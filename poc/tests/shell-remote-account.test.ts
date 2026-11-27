import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { dirGuard, isUserSid, readDacl, windowsTool } from '@sax/platform';
import { b64, fromB64, verifyAcctClaim, verifyCert } from '@sax/remote';
import { CERT_RENEW_MS, checkIdentity, DesktopAccount, PendingCodeFile, RemoteIdentityFile } from '../apps/desktop/src/remote-account.ts';
import { ORIGIN, softDesktopKeys, startDevStack, type DevStack } from './remote-dev-stack.ts';

const EMAIL = 'owner@gyeonbon-test.example';

async function assertUserOnly(file: string): Promise<void> {
  if (process.platform !== 'win32') return assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const [name = '', me = ''] = execFileSync(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim().split('","').map((f) => f.replace(/"/g, ''));
  const local = name.split('\\')[0]?.toLowerCase() === process.env.COMPUTERNAME?.toLowerCase();
  const sids = (await readDacl(file)).aces.map((a) => a.sid);
  assert.ok(sids.length > 0 && sids.every((x) => isUserSid(x, me, local) || x === 'SY'), `신원 파일 ACE: ${sids.join(', ')}`);
}

describe('데스크톱 계정: 이메일 6자리 → 첫 PC 등록 → 기기 토큰', () => {
  let root: string;
  let dir: string;
  let s: DevStack;
  let logs: Array<[string, Record<string, string | number>]>;
  const account = (keys = softDesktopKeys(), client: DevStack['client'] | null = s.client) =>
    new DesktopAccount({ client, keys: async () => keys, identity: new RemoteIdentityFile(dir), platform: 'windows', deviceName: 'Windows PC', now: s.clock.now, log: (n, d) => logs.push([n, d]) });
  const signIn = async (a: DesktopAccount, email = EMAIL) => {
    await a.init();
    assert.equal((await a.sendCode(email)).step, 'code_sent');
    return a.verify(s.mail.lastCode(email.toLowerCase())!);
  };

  before(async () => {
    root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'sax-remote-acct-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(root, 'u-'));
    assert.equal((await dirGuard().ensurePrivate(dir)).ok, true);
    s = await startDevStack();
    logs = [];
  });
  afterEach(() => s.close());

  it('처음: 코드 보내기 → 코드 확인 → AIK 고정 → 신원 파일(비밀 없음) → 로그아웃', async () => {
    const keys = softDesktopKeys();
    const a = account(keys);
    assert.equal((await a.init()).step, 'signed_out');
    const sent = await a.sendCode(` ${EMAIL} `);
    assert.equal(sent.step, 'code_sent');
    assert.equal(sent.email, EMAIL);
    assert.ok(sent.codeExpiresAt! > s.clock.now());
    const v = await a.verify(s.mail.lastCode(EMAIL)!);
    assert.deepEqual(v, { step: 'signed_in', email: EMAIL, codeExpiresAt: null, error: null, phones: 0 });
    assert.deepEqual(s.client.calls, ['POST /v1/auth/code', 'POST /v1/auth/code/verify', 'GET /v1/device-list', 'POST /v1/aik', 'POST /v1/auth/logout']);
    const raw = fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8');
    const id = checkIdentity(JSON.parse(raw), s.clock.now())!;
    assert.ok(id, '파일은 AIK로 다시 검증된다');
    assert.equal(id.aikPub, b64(keys.aik.publicKey));
    const c = verifyCert(id.cert, keys.aik.publicKey, s.clock.now())!;
    assert.equal(c.device_id, id.deviceId);
    assert.equal(b64(c.Vx), b64(keys.vd.publicKey));
    await assertUserOnly(path.join(dir, 'remote-identity.json'));
    for (const bad of ['session', 'loginId', 'sxd1.', s.mail.lastCode(EMAIL)!]) assert.ok(!raw.includes(bad), bad);
    const dl = (await s.svc.deviceList((await s.svc.verifyEmailCode((await s.svc.startEmailCode(EMAIL)).loginId, s.mail.lastCode(EMAIL)!)).accountId)) as { aikPub: string };
    assert.equal(dl.aikPub, id.aikPub, '서버에 이 AIK가 고정됐다');
  });

  it('기기 토큰으로 계정 호출: 토큰은 캐시(15분), acct-claim은 폰과 같은 검사(계정 서비스 고정 키)를 통과한다', async () => {
    const keys = softDesktopKeys();
    const a = account(keys);
    await signIn(a);
    const dev = a.device()!;
    const h1 = await dev.auth('GET', `${ORIGIN}/v1/device-list`);
    assert.match(h1.Authorization!, /^DPoP sxd1\./);
    const r = await s.http({ method: 'GET', url: `${ORIGIN}/v1/device-list`, headers: h1 });
    assert.equal(r.status, 200);
    await dev.auth('GET', `${ORIGIN}/v1/device-list`);
    assert.equal(s.client.calls.filter((c) => c === 'POST /v1/device-tokens').length, 1, '토큰은 다시 받지 않는다');
    const field = await dev.acctClaimField();
    const ok = verifyAcctClaim(field, { accountKeys: [fromB64(s.claimSigner.publicKey)], aikPub: keys.aik.publicKey, now: s.clock.now() });
    assert.ok(ok.ok && ok.claim.email === EMAIL, JSON.stringify(ok));
    s.clock.advance(16 * 60_000);
    await dev.auth('GET', `${ORIGIN}/v1/device-list`);
    assert.equal(s.client.calls.filter((c) => c === 'POST /v1/device-tokens').length, 2, '만료되면 새로 받는다');
  });

  it('다시 켜면 신원 파일로 바로 로그인 상태(네트워크 없음), 다른 금고 키면 쓰지 않는다', async () => {
    const keys = softDesktopKeys();
    await signIn(account(keys));
    const n = s.client.calls.length;
    assert.equal((await account(keys).init()).step, 'signed_in');
    assert.equal(s.client.calls.length, n);
    assert.equal((await account(softDesktopKeys()).init()).step, 'signed_out');
    assert.deepEqual(logs.at(-1), ['main.account_identity', { result: 'key_mismatch' }]);
  });

  it('같은 금고로 다시 설치(신원 파일 없음): 서버 목록의 이 PC 항목으로 되살린다(같은 deviceId)', async () => {
    const seed = new Uint8Array(32).fill(7);
    await signIn(account(softDesktopKeys(seed)));
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).deviceId;
    await fsp.rm(path.join(dir, 'remote-identity.json'));
    s.clock.advance(70 * 60_000);
    const v = await signIn(account(softDesktopKeys(seed)));
    assert.equal(v.step, 'signed_in');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).deviceId, first);
    assert.ok(!s.client.calls.slice(-3).includes('POST /v1/aik'), '다시 고정하지 않는다');
  });

  it('다른 PC가 이미 고정한 계정이면 account.aik_already_pinned로 끝나고 신원 파일을 만들지 않는다(두 번째 PC는 A-03)', async () => {
    await signIn(account());
    await fsp.rm(path.join(dir, 'remote-identity.json'));
    s.clock.advance(70 * 60_000);
    const v = await signIn(account(softDesktopKeys()));
    assert.equal(v.step, 'signed_out');
    assert.equal(v.error, 'account.aik_already_pinned');
    assert.ok(!fs.existsSync(path.join(dir, 'remote-identity.json')));
    assert.equal(s.client.calls.at(-1), 'POST /v1/auth/logout', '실패해도 세션은 버린다');
  });

  it('틀린 코드·이메일 모양·만료·계정 없는 빌드', async () => {
    const a = account();
    await a.init();
    assert.equal((await a.sendCode('not-an-email')).error, 'account.email_shape');
    await a.sendCode(EMAIL);
    const code = s.mail.lastCode(EMAIL)!;
    const wrong = await a.verify(code === '000000' ? '111111' : '000000');
    assert.equal(wrong.step, 'code_sent');
    assert.equal(wrong.error, 'account.code_invalid');
    assert.equal((await a.verify('12ab56')).error, 'account.code_shape');
    s.clock.advance(11 * 60_000);
    const late = await a.verify(code);
    assert.equal(late.step, 'signed_out');
    assert.equal(late.error, 'account.code_expired');
    assert.equal(a.back().step, 'signed_out');
    const none = account(softDesktopKeys(), null);
    assert.equal((await none.init()).step, 'unavailable');
    await assert.rejects(none.sendCode(EMAIL), /account_unavailable/);
  });

  it('[로그아웃](설정 > 계정): 신원 파일·기기 토큰을 지우고 로그인 전으로(이메일 칸은 채움), 다시 켜도 로그아웃, 같은 금고로 다시 로그인하면 같은 PC', async () => {
    const seed = new Uint8Array(32).fill(9);
    const a = account(softDesktopKeys(seed));
    await signIn(a);
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).deviceId;
    assert.ok(a.device());
    const v = await a.signOut();
    assert.deepEqual([v.step, v.email], ['signed_out', EMAIL]);
    assert.equal(a.device(), null, '기기 범위 호출이 끊긴다');
    assert.ok(!fs.existsSync(path.join(dir, 'remote-identity.json')));
    assert.deepEqual(logs.at(-1), ['main.account_signout', { result: 'ok' }]);
    assert.equal((await account(softDesktopKeys(seed)).init()).step, 'signed_out', '다시 켜도 로그아웃');
    s.clock.advance(70 * 60_000);
    assert.equal((await signIn(account(softDesktopKeys(seed)))).step, 'signed_in');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).deviceId, first);
  });

  it('폰 연결을 닫은 빌드(운영 룸 호스트·폰 앱 출시 전): 로그인 뷰에 pairable:false, 렌더러는 [폰 연결] 대신 안내, main은 pair_unavailable', async () => {
    const a = new DesktopAccount({ client: s.client, keys: async () => softDesktopKeys(), identity: new RemoteIdentityFile(dir), platform: 'windows', deviceName: 'Windows PC', pairing: false, now: s.clock.now });
    const v = await signIn(a);
    assert.equal(v.step, 'signed_in');
    assert.equal(v.pairable, false);
    const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(read('apps/desktop/static/shell/shell-account.js'), /v\.pairable === false\s*\? h\('p', \{ class: 'sx-meta', 'data-pair-soon': '' \}/);
    assert.match(read('apps/desktop/src/shell-app.ts'), /if \(opts\.remote\?\.pairing === false\) throw new Error\('pair_unavailable'\);/);
  });

  it('[로그아웃] 배선: 실제 입력 3초, 발급 실행 중이면 거부, 진행 중인 폰 연결을 그만둔다, 렌더러는 설정 > 계정의 [로그아웃] → 로그인 게이트', () => {
    const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const src = read('apps/desktop/src/shell-app.ts');
    assert.match(src, /'account\.signOut': async \(\) => \{\s*needGesture\(3_000\);\s*await accountInit\(\);\s*if \(runs\.anyActive\(\)\) throw new Error\('run_active'\);\s*pairReset\(\);/);
    const acct = read('apps/desktop/static/shell/shell-account.js');
    assert.match(acct, /onSignOut \? h\('div', \{ class: 'sx-actions' \}, btn\('로그아웃', onSignOut, 'sx-btn-quiet', \{ 'data-act': 'account-signout' \}\)/);
    const shell = read('apps/desktop/static/shell/shell.js');
    assert.match(shell, /accountCard\(state\.account, openLogin, pairRow, signOut\)/);
    assert.match(shell, /state\.account = await call\('account\.signOut', \{\}\);\s*state\.login = null;\s*render\(\);/);
  });

  it('인증서는 만료 14일 전에 AIK로 새로 서명해 파일에 둔다', async () => {
    const keys = softDesktopKeys();
    const a = account(keys);
    await signIn(a);
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).cert.cert.not_after as number;
    s.clock.t = before - CERT_RENEW_MS + 1;
    a.device()!.clearToken();
    await a.device()!.auth('GET', `${ORIGIN}/v1/device-list`);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'remote-identity.json'), 'utf8')).cert.cert.not_after as number;
    assert.ok(after > before);
  });

  it('받은 코드는 만료까지: 앱을 껐다 켜도(새 DesktopAccount) 코드 화면으로 돌아와 같은 코드로 로그인, 파일엔 코드 없음·사용자만, 성공·[뒤로]·만료에 지운다', async () => {
    const keys = softDesktopKeys();
    const mk = () => new DesktopAccount({ client: s.client, keys: async () => keys, identity: new RemoteIdentityFile(dir), pending: new PendingCodeFile(dir), platform: 'windows', deviceName: 'Windows PC', now: s.clock.now });
    const file = path.join(dir, 'remote-pending-code.json');
    const a = mk();
    await a.init();
    const sent = await a.sendCode(EMAIL);
    await new Promise((r) => setTimeout(r, 50));
    const raw = fs.readFileSync(file, 'utf8');
    const code = s.mail.lastCode(EMAIL)!;
    assert.ok(!raw.includes(code), '코드 자체는 저장하지 않는다');
    await assertUserOnly(file);
    const b = mk();
    const v = await b.init();
    assert.deepEqual([v.step, v.email, v.codeExpiresAt], ['code_sent', EMAIL, sent.codeExpiresAt]);
    assert.equal((await b.verify(code === '000000' ? '111111' : '000000')).error, 'account.code_invalid');
    const c = mk();
    assert.equal((await c.init()).step, 'code_sent');
    assert.equal((await c.verify(code)).step, 'signed_in');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(file), false, '성공하면 지운다');
    const d = new DesktopAccount({ client: s.client, keys: async () => softDesktopKeys(), identity: new RemoteIdentityFile(await fsp.mkdtemp(path.join(root, 'u-'))), pending: new PendingCodeFile(dir), platform: 'windows', deviceName: 'Windows PC', now: s.clock.now });
    await d.init();
    await d.sendCode('other@gyeonbon-test.example');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(file), true);
    d.back();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(file), false, '[뒤로]면 지운다');
    const f = new PendingCodeFile(dir);
    await f.save({ email: EMAIL, loginId: 'L', expiresAt: s.clock.now() - 1 });
    assert.equal(await f.load(s.clock.now()), null);
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, '{"email":"x","loginId":"L","expiresAt":1}');
    assert.equal(await f.load(s.clock.now()), null);
  });

  it('로그에 이메일·코드·토큰이 없다', async () => {
    await signIn(account());
    const t = JSON.stringify(logs);
    for (const bad of [EMAIL, 'gyeonbon', s.mail.lastCode(EMAIL)!, 'sxd1.']) assert.ok(!t.includes(bad), bad);
    assert.deepEqual(logs, [['main.account_code', { result: 'sent' }], ['main.account_enroll', { result: 'ok' }]]);
  });
});

describe('셸 배선(소스 검사)', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/src/shell-app.ts'), 'utf8');
  const js = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/static/shell/shell-account.js'), 'utf8');
  it('코드 보내기·확인은 실제 입력 뒤 3초 안에만, 인자는 이메일·코드 하나씩', async () => {
    const { SHELL_METHODS, USER_ACTION_METHODS } = await import('../apps/desktop/src/ipc.ts');
    assert.equal(USER_ACTION_METHODS['account.sendCode'], 3_000);
    assert.equal(USER_ACTION_METHODS['account.verify'], 3_000);
    assert.deepEqual(Object.keys(SHELL_METHODS['account.sendCode']), ['email']);
    assert.deepEqual(Object.keys(SHELL_METHODS['account.verify']), ['code']);
    assert.match(src, /'account\.sendCode': async \(p\) => \{\s*needGesture\(3_000\);/);
    assert.match(src, /'account\.verify': async \(p\) => \{[^}]*?needTyping\(3_000\);/);
    assert.match(src, /'pair\.submit': async \(p\) => \{[^}]*?needTyping\(3_000\);/);
    assert.equal((src.match(/needTyping\(/g) ?? []).length, 2, 'account.verify·pair.submit 둘뿐');
    assert.match(src, /if \(isTypingKey\(i\)\) typing\.note\(performance\.now\(\)\);/);
    assert.match(src, /if \(isGestureKey\(i\)\) gesture\.note\(performance\.now\(\)\);/);
  });
  it('코드 화면: 칸 바로 아래 [확인](6자리면 켜짐), 서버가 코드를 거절한 때만 칸을 비우고, 입력을 못 봐 거절되면 "[확인]을 눌러 주세요"', () => {
    const shell = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/static/shell/shell.js'), 'utf8');
    assert.match(js, /const ok = primary\('확인', \(\) => !busy && verify\(draft\.code \?\? ''\), 'account-verify', busy \|\| !\/\^\\d\{6\}\$\/\.test\(draft\.code \?\? ''\)\);/);
    assert.match(js, /codeField\(ctx, busy, verify, \(c\) => \(ok\.disabled = busy \|\| !\/\^\\d\{6\}\$\/\.test\(c\)\)\),\s*ok,\s*errNote\(err === 'gesture_required' \? 'account\.confirm_click' : err\)/);
    assert.match(js, /'account\.confirm_click': '\[확인\]을 눌러 주세요'/);
    assert.match(shell, /const SERVER_CODE_ERR = new Set\(\['account\.code_invalid', 'account\.code_locked', 'account\.code_expired'\]\);/);
    assert.match(shell, /if \(method === 'account\.verify' && SERVER_CODE_ERR\.has\(state\.account\?\.error\)\) l\.draft\.code = '';/);
  });
  it('금고 키 연결이 없으면 계정 클라이언트도 쓰지 않는다(unavailable), 키는 금고 control로만', () => {
    assert.match(src, /client: opts\.remote\?\.keys \? \(opts\.remote\.cloud\?\.account \?\? null\) : null/);
    assert.match(src, /f\(\(m, p\) => host\.control\(m, p\)\)/);
  });
  it('로그인 화면은 HTML로 그리지 않고, 오류 코드를 그대로 보이지 않는다', () => {
    assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
    assert.match(js, /ERR\[code\] \?\?/);
  });
});
