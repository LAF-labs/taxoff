import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Logger, TokenIssuer, TokenVerifier, createServer, ed25519RawPublic, listen, migrate, openSqlite, type Sql } from '../services/shared/src/index.ts';
import { ACCOUNT, AccountService, MIGRATIONS_DIR, MockMailSender, MockPaymentGateway, NOTICE, accountRouter, type NoticeKind } from '../services/account/src/index.ts';
import { Clock, D, client, edKey, internalAuth } from './services-kit.ts';

class FlakyMail extends MockMailSender {
  failNotices = 0;
  finalFail = false;
  hold: Promise<void> | null = null;
  calls = 0;
  override async sendNotice(to: string, kind: NoticeKind): Promise<void> {
    this.calls++;
    if (this.hold) await this.hold;
    if (this.finalFail) throw Object.assign(new Error('mail.rejected'), { retryable: false });
    if (this.failNotices > 0) {
      this.failNotices--;
      throw new Error('mail down');
    }
    return super.sendNotice(to, kind);
  }
}

const ORIGIN = 'https://account.test.invalid';
const RP = { rpId: 'account.test.invalid', origins: [ORIGIN] };

interface Env {
  clock: Clock;
  db: Sql;
  mail: MockMailSender;
  svc: AccountService;
  server: Server;
  req: ReturnType<typeof client>;
  svcEvents: string[];
  flush(): Promise<void>;
}

async function start(o: { mail?: MockMailSender } = {}): Promise<Env> {
  const clock = new Clock();
  const db = openSqlite();
  await migrate(db, 'account', MIGRATIONS_DIR);
  const mail = o.mail ?? new MockMailSender();
  const deferred: Array<() => Promise<void>> = [];
  const svcEvents: string[] = [];
  const signKey = edKey().priv;
  const svc = new AccountService({
    db,
    mail,
    payments: new MockPaymentGateway(),
    tokens: new TokenIssuer('k1', signKey),
    codeMacKey: Buffer.alloc(32, 7),
    rp: RP,
    publicOrigin: ORIGIN,
    billingReturnUrl: 'https://app.test.invalid/billing/done',
    onEvent: (n) => void svcEvents.push(n),
    defer: (t) => void deferred.push(t),
    now: clock.now,
  });
  const flush = async () => {
    while (deferred.length) await deferred.shift()!();
  };
  const router = accountRouter({ svc, verifier: new TokenVerifier({ k1: ed25519RawPublic(signKey) }), publicOrigin: ORIGIN, internal: internalAuth() });
  const server = createServer(router, { logger: new Logger('account', () => {}, clock.now) });
  return { clock, db, mail, svc, server, req: client(await listen(server)), svcEvents, flush };
}

const bearer = (s: string) => ({ authorization: `Bearer ${s}` });

async function codeLogin(e: Env, email: string, remember = false): Promise<{ session: string; refreshToken?: string }> {
  const s = await e.req('POST', '/v1/auth/code', { body: { email } });
  const v = await e.req('POST', '/v1/auth/code/verify', { body: { loginId: s.json.loginId, code: e.mail.lastCode(email), ...(remember ? { remember: true } : {}) } });
  assert.equal(v.status, 200, v.text);
  return { session: v.json.session as string, refreshToken: v.json.refreshToken as string | undefined };
}

describe('비밀번호 경로 없음(ADR-061 결정 1)', () => {
  it('옛 판 앱이 비밀번호 경로를 부르면 404 request.not_found, 이메일 코드 로그인과 /v1/me 모양은 그대로', async () => {
    const e = await start();
    try {
      const { session } = await codeLogin(e, 'off@example.com');
      for (const [m, p, h, b] of [
        ['POST', '/v1/auth/password', {}, { email: 'off@example.com', password: 'x' }],
        ['PUT', '/v1/password', bearer(session), { password: 'x' }],
        ['DELETE', '/v1/password', bearer(session), undefined],
        ['POST', '/v1/auth/password/reset', {}, { email: 'off@example.com' }],
        ['POST', '/v1/auth/password/reset/verify', {}, { resetId: 'r', code: '123456', password: 'x' }],
        ['POST', '/v1/auth/reauth', bearer(session), {}],
        ['POST', '/v1/auth/reauth/verify', bearer(session), { reauthId: 'r', code: '123456' }],
      ] as const) {
        const r = await e.req(m, p, { headers: h, ...(b ? { body: b } : {}) });
        assert.deepEqual([r.status, r.json?.error], [404, 'request.not_found'], `${m} ${p}`);
      }
      const me = await e.req('GET', '/v1/me', { headers: bearer(session) });
      assert.equal(me.status, 200);
      assert.deepEqual([me.json.hasPassword, me.json.reauthUntil, me.json.authMethod], [false, null, 'email_code'], '0.1.40 이하 PC 앱이 모양을 검사한다');
    } finally {
      e.server.close();
    }
  });
});

describe('알림 메일 발송 큐(notice_outbox)', () => {
  it('발송 큐: 동시에 도는 두 처리자도 한 번만 보내고, 계속 실패하면 상한(8회) 뒤 버린다, 다시 보내도 같은 실패는 바로 버린다, 계정을 지우면 행도 지운다', async () => {
    const mail = new FlakyMail();
    const f = await start({ mail });
    try {
      await codeLogin(f, 'c@example.com');
      const acc = (await f.db.one<{ id: string }>('SELECT id FROM accounts WHERE email = $1', ['c@example.com']))!.id;
      await f.db.run("INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ('x0', $1, 'email_unlocked', $2, 0, $2)", [acc, f.clock.now()]);
      mail.calls = 0;
      await Promise.all([f.flush(), f.svc.drainNotices(), f.svc.drainNotices()]);
      assert.equal(mail.outbox.filter((m) => m.kind === 'email_unlocked').length, 1);
      assert.equal(mail.calls, 1);
      await f.db.run("INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ('x1', $1, 'email_unlocked', $2, 0, $2)", [acc, f.clock.now()]);
      mail.failNotices = 100;
      const waits: number[] = [];
      for (let i = 0; i < NOTICE.maxAttempts; i++) {
        await f.svc.drainNotices();
        const r = await f.db.one<{ next_at: number }>("SELECT next_at FROM notice_outbox WHERE id = 'x1'");
        if (!r) break;
        waits.push(Number(r.next_at) - f.clock.now());
        f.clock.advance(Number(r.next_at) - f.clock.now());
      }
      assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 64].map((k) => Math.min(k * NOTICE.retryBaseMs, NOTICE.retryMaxMs)));
      assert.equal(await f.db.one("SELECT 1 AS x FROM notice_outbox WHERE id = 'x1'"), undefined);
      assert.ok(f.svcEvents.includes('account.notice_dropped.email_unlocked'));
      mail.failNotices = 0;
      mail.finalFail = true;
      f.svcEvents.length = 0;
      await f.db.run("INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ('x3', $1, 'email_unlocked', $2, 0, $2)", [acc, f.clock.now()]);
      assert.deepEqual(await f.svc.drainNotices(), { sent: 0, failed: 1 });
      assert.equal(await f.db.one("SELECT 1 AS x FROM notice_outbox WHERE id = 'x3'"), undefined);
      assert.deepEqual(f.svcEvents.filter((e) => e.startsWith('account.notice_')), ['account.notice_dropped.email_unlocked']);
      mail.finalFail = false;
      await f.db.run("INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ('x2', $1, 'email_unlocked', $2, 0, $2)", [acc, f.clock.now()]);
      await f.db.run('DELETE FROM accounts WHERE id = $1', [acc]);
      assert.equal(await f.db.one("SELECT 1 AS x FROM notice_outbox WHERE id = 'x2'"), undefined);
    } finally {
      f.server.close();
    }
  });

});

describe('ADR-038 (f) 자동 로그인: 갱신 토큰', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('remember면 갱신 토큰, 쓸 때마다 회전, 이전 토큰 재사용이면 계정 세션·갱신 토큰 전부 폐기 + 알림', async () => {
    const first = await codeLogin(e, 'rf@example.com', true);
    assert.match(first.refreshToken!, /^sxa1\.[A-Za-z0-9_-]{43}$/);
    const other = await codeLogin(e, 'rf@example.com', true);
    const r1 = await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: first.refreshToken } });
    assert.equal(r1.status, 200, r1.text);
    assert.notEqual(r1.json.refreshToken, first.refreshToken);
    assert.equal(r1.json.refreshExpiresInSec, 30 * 24 * 3600);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(r1.json.session as string) })).json.authMethod, 'refresh');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: first.refreshToken } })).json.error, 'account.unauthorized');
    for (const s of [first.session, other.session, r1.json.session as string]) assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.error, 'account.unauthorized');
    for (const t of [r1.json.refreshToken, other.refreshToken]) assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: t } })).json.error, 'account.unauthorized');
    assert.ok(e.mail.outbox.some((m) => m.to === 'rf@example.com' && m.kind === 'sessions_revoked'));
    assert.equal(await e.db.one('SELECT 1 AS x FROM refresh_tokens'), undefined);
    const stored = JSON.stringify(await e.db.all('SELECT * FROM refresh_tokens'));
    assert.ok(!stored.includes(first.refreshToken!.slice(5)));
  });

  it('30일 미사용 만료(회전마다 새로 30일), 끄기는 계보 전체 폐기, 모르는 토큰·형식 오류는 401·400', async () => {
    let t = (await codeLogin(e, 'ex@example.com', true)).refreshToken!;
    for (let i = 0; i < 3; i++) {
      e.clock.advance(29 * D);
      const r = await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: t } });
      assert.equal(r.status, 200, `${i} ${r.text}`);
      t = r.json.refreshToken as string;
    }
    e.clock.advance(ACCOUNT.refreshTtlMs);
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: t } })).json.error, 'account.unauthorized');
    const a = (await codeLogin(e, 'ex@example.com', true)).refreshToken!;
    const a2 = (await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: a } })).json.refreshToken as string;
    assert.equal((await e.req('POST', '/v1/auth/refresh/revoke', { body: { refreshToken: a } })).status, 204, '이전 토큰으로도 계보를 끈다');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: a2 } })).json.error, 'account.unauthorized');
    assert.equal((await e.req('POST', '/v1/auth/refresh/revoke', { body: { refreshToken: 'sxa1.' + 'A'.repeat(43) } })).status, 204);
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: 'sxa1.' + 'A'.repeat(43) } })).json.error, 'account.unauthorized');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: 'sxs1.' + 'A'.repeat(43) } })).status, 400);
    e.clock.advance(ACCOUNT.refreshTtlMs + 1);
    await e.svc.sweep();
    assert.equal(await e.db.one('SELECT 1 AS x FROM refresh_tokens'), undefined);
  });

  it('모든 기기에서 로그아웃: 계정 세션·갱신 토큰 전부(이 세션 포함)', async () => {
    const a = await codeLogin(e, 'all@example.com', true);
    const b = await codeLogin(e, 'all@example.com', true);
    const other = await codeLogin(e, 'someone@example.com', true);
    assert.equal((await e.req('POST', '/v1/auth/logout-all', { headers: bearer(a.session) })).status, 204);
    for (const s of [a.session, b.session]) assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.error, 'account.unauthorized');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: b.refreshToken } })).json.error, 'account.unauthorized');
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(other.session) })).status, 200, '다른 계정은 그대로');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: other.refreshToken } })).status, 200);
  });
});

describe('마이그레이션', () => {
  it('기존 세션은 옮겨지고(auth_at = created_at) 새 방식 값을 받는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-acct-mig-'));
    try {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, '001_init.sql'), path.join(dir, '001_init.sql'));
      const db = openSqlite();
      await migrate(db, 'account', dir);
      await db.run("INSERT INTO accounts (id, email, status, created_at) VALUES ('a1', 'm@example.com', 'active', 1)");
      await db.run("INSERT INTO sessions (token_hash, account_id, auth_method, created_at, expires_at) VALUES ('h1', 'a1', 'passkey', 5, 99)");
      assert.deepEqual(await migrate(db, 'account', MIGRATIONS_DIR), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
      assert.deepEqual({ ...(await db.one('SELECT token_hash, account_id, auth_method, created_at, auth_at, expires_at FROM sessions'))! }, { token_hash: 'h1', account_id: 'a1', auth_method: 'passkey', created_at: 5, auth_at: 5, expires_at: 99 });
      await db.run("INSERT INTO sessions (token_hash, account_id, auth_method, created_at, auth_at, expires_at) VALUES ('h2', 'a1', 'refresh', 1, 1, 2)");
      await assert.rejects(db.run("INSERT INTO sessions (token_hash, account_id, auth_method, created_at, auth_at, expires_at) VALUES ('h3', 'a1', 'magic', 1, 1, 2)"));
      for (const t of ['pw_creds', 'pw_locks', 'reset_codes']) assert.equal(await db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = $1", [t]), undefined, `013이 ${t}를 지운다`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
