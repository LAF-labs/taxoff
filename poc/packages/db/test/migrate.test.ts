import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { appliedMigrations, backupName, migrationSha256, isEncryptedFile, listBackups, MIGRATIONS, MigrationError, openDatabase, restoreBackup, rolledBackCleanly, type Migration } from '@sax/db';

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-mig-'));
  dirs.push(d);
  return path.join(d, 'db.sqlite');
};
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const key = () => new Uint8Array(randomBytes(32));
const tables = (db: ReturnType<typeof openDatabase>): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);

const D07_TABLES = [
  'bank_accounts', 'bank_imports', 'bank_txns',
  'bundle_entries', 'bundle_exports', 'bundle_items', 'card_fetches', 'card_sales', 'card_txn_memos', 'card_txns', 'cash_receipts', 'cash_sales', 'clock_guard', 'consents', 'cooldowns', 'counterparties', 'cp_bank_accounts', 'cp_payer_aliases',
  'documents', 'employees', 'gate_requests', 'hometax_syncs', 'invoice_amends', 'invoice_bulk_rows', 'irreversible_log', 'match_rejects', 'onboarding_state', 'payroll_lines', 'payroll_months', 'playbook_packages', 'policy', 'profiles', 'rate_counters',
  'rate_tables', 'receipts', 'receivable_adjusts', 'receivable_allocs', 'receivable_events', 'receivables', 'registry_state', 'remote_cmd_seen', 'remote_devices', 'remote_pair_state', 'run_events', 'runs', 'schedules', 'settings', 'share_in', 'share_out', 'share_party', 'share_state', 'shifts',
  'temp_previews', 'txn_category_rules', 'usage_local', 'validity_rules',
];

describe('스키마 마이그레이션(D07 §7)', () => {
  it('새 DB: D07 §2 테이블 전부 + 버전 테이블, user_version = 최신 판, 백업 없음', () => {
    const file = tmp();
    const db = openDatabase(file, key());
    assert.deepEqual(tables(db).filter((t) => t !== 'schema_migrations'), D07_TABLES);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert.deepEqual(appliedMigrations(db).map((m) => m.version), MIGRATIONS.map((m) => m.version));
    assert.equal(db.pragma('foreign_key_check').length, 0);
    db.close();
    assert.deepEqual(listBackups(file), []);
    assert.ok(isEncryptedFile(file));
  });

  it('버전 테이블 이전(PoC v2, user_version만) DB: 기록을 채우고 v3~ 적용, 기존 행 유지, 적용 전 암호문 백업', () => {
    const file = tmp();
    const k = key();
    const v2 = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2) });
    v2.prepare(`INSERT INTO settings (key, value_json) VALUES ('x', '1')`).run();
    v2.exec('DROP TABLE schema_migrations');
    assert.equal(v2.pragma('user_version', { simple: true }), 2);
    v2.close();

    const db = openDatabase(file, k);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert.deepEqual(appliedMigrations(db).map((m) => m.version), MIGRATIONS.map((m) => m.version));
    assert.equal(db.prepare(`SELECT value_json FROM settings WHERE key='x'`).pluck().get(), '1');
    db.close();
    const backups = listBackups(file);
    assert.equal(backups.length, 1);
    assert.match(path.basename(backups[0]!), /^db\.sqlite\.pre-v2-\d{8}T\d{6}Z\.bak$/);
    assert.ok(isEncryptedFile(backups[0]!), '백업도 암호문');
    if (process.platform !== 'win32') assert.equal(fs.statSync(backups[0]!).mode & 0o777, 0o600);
    const b = openDatabase(backups[0]!, k, { migrations: MIGRATIONS.slice(0, 2) });
    assert.equal(b.pragma('user_version', { simple: true }), 2);
    assert.ok(!tables(b).includes('employees'));
    b.close();
  });

  it('실패하면 대기 중인 판 전부를 되돌린다: DB는 이전 판 그대로, 오류는 판 번호만, 기존 백업은 지우지 않는다', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 1) }).close();
    for (const n of [2, 3]) openDatabase(file, k, { migrations: MIGRATIONS.slice(0, n), now: () => new Date(Date.UTC(2026, 10, 5, 10, n)) }).close();
    const before = listBackups(file);
    assert.equal(before.length, 2);
    const broken: Migration[] = [...MIGRATIONS.slice(0, 4), { version: 5, name: 'broken', sql: 'CREATE TABLE ok_part (x INTEGER); CREATE TABLE settings (dup TEXT);' }];
    assert.throws(
      () => openDatabase(file, k, { migrations: broken }),
      (e: unknown) => e instanceof MigrationError && e.code === 'db.migration_failed' && e.version === 5 && e.message === 'db.migration_failed:v5',
    );
    const db = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 3) });
    assert.equal(db.pragma('user_version', { simple: true }), 3, 'v4도 되돌려졌다(한 트랜잭션)');
    assert.ok(!tables(db).includes('employees') && !tables(db).includes('ok_part'));
    db.close();
    assert.deepEqual(listBackups(file), before, '실패한 시도는 오래된 복구 지점을 지우지 않고, 사본도 남기지 않는다');
    const at = () => new Date(Date.UTC(2026, 10, 5, 12));
    for (let i = 0; i < 2; i++) assert.throws(() => openDatabase(file, k, { migrations: broken, now: at }), (e: unknown) => e instanceof MigrationError && e.code === 'db.migration_failed');
    assert.deepEqual(listBackups(file), before);
  });

  it('실패 뒤 되돌림을 확인하지 못하면(트랜잭션이 남음·판이 다름) 이번 백업은 지우지 않는 조건', () => {
    const db = openDatabase(tmp(), key());
    const v = db.pragma('user_version', { simple: true }) as number;
    assert.equal(rolledBackCleanly(db, v), true);
    assert.equal(rolledBackCleanly(db, v - 1), false, '판이 다르면 남긴다');
    db.prepare('BEGIN').run();
    assert.equal(rolledBackCleanly(db, v), false, '트랜잭션이 끝나지 않았으면 남긴다');
    db.prepare('ROLLBACK').run();
    db.close();
    assert.equal(rolledBackCleanly(db, v), false, '닫힌·상한 DB는 확인 실패 → 남긴다');
  });

  it('같은 이름의 백업이 이미 있으면 -2를 붙이고, 정리는 성공한 뒤에만 한다', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2) }).close();
    const at = new Date(Date.UTC(2026, 10, 5, 13));
    fs.writeFileSync(backupName(file, 2, at), 'x');
    const db = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 3), now: () => at });
    db.close();
    assert.deepEqual(listBackups(file).map((b) => path.basename(b)), ['db.sqlite.pre-v2-20261105T130000Z-2.bak', 'db.sqlite.pre-v2-20261105T130000Z.bak'].sort());
  });

  it('앱보다 새 판 DB는 열지 않는다', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k).close();
    assert.throws(() => openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 3) }), (e: unknown) => e instanceof MigrationError && e.code === 'db.schema_newer');
  });

  it('noUpgrade면 쓰던 DB를 올리지 않고 그대로 둔다(새 DB는 만든다)', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2), noUpgrade: true }).close();
    assert.throws(() => openDatabase(file, k, { noUpgrade: true }), (e: unknown) => e instanceof MigrationError && e.code === 'db.upgrade_refused' && e.version === 2);
    assert.deepEqual(listBackups(file), []);
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2), noUpgrade: true }).close();
  });

  it('이미 적용한 판의 SQL이 바뀌면 열지 않는다(배포한 마이그레이션은 고치지 않는다)', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2) }).close();
    const edited = MIGRATIONS.slice(0, 2).map((m) => (m.version === 2 ? { ...m, sql: m.sql + '\n-- edited' } : m));
    assert.throws(() => openDatabase(file, k, { migrations: edited }), (e: unknown) => e instanceof MigrationError && e.code === 'db.migration_mismatch' && e.version === 2);
  });

  it('판 번호는 1부터 빈틈없이', () => {
    assert.throws(() => openDatabase(tmp(), key(), { migrations: [MIGRATIONS[0]!, { version: 3, name: 'gap', sql: 'SELECT 1' }] }), /db\.migration_invalid/);
    MIGRATIONS.forEach((m, i) => assert.equal(m.version, i + 1));
  });

  it('백업은 최근 2개만 남기고, restoreBackup은 지금 파일을 .unreadable-로 옮긴 뒤 되돌린다', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 1) }).close();
    for (const n of [2, 3, 4]) openDatabase(file, k, { migrations: MIGRATIONS.slice(0, n), now: () => new Date(Date.UTC(2026, 10, 5, 10, n)) }).close();
    const backups = listBackups(file);
    assert.deepEqual(backups.map((b) => path.basename(b).replace(/-\d{8}T\d{6}Z\.bak$/, '')), ['db.sqlite.pre-v2', 'db.sqlite.pre-v3']);
    const moved = restoreBackup(file, backups[0]!, new Date(Date.UTC(2026, 10, 5, 11)));
    assert.ok(moved && fs.existsSync(moved) && /\.unreadable-20261105T110000Z$/.test(moved));
    const db = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2) });
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    db.close();
    assert.throws(() => restoreBackup(file, path.join(path.dirname(file), 'elsewhere.bak')), /db\.migration_invalid/);
  });
  it('v1부터 끝까지 한 판씩 같은 파일에 올린다: 합쳐진 판의 sha256은 그대로, v9(돈 맞추기) 뒤 v10이 발급 키를 더하고 옛 원장 행은 키 없이 남는다', () => {
    const file = tmp();
    const k = key();
    assert.deepEqual(MIGRATIONS.map((m) => [m.version, m.name, migrationSha256(m)]), [
      [1, 'poc_core', 'f7b81164f958b19b6044334c9d0fc2d05e0db90fb93a3b454e8c81f5dc56b17d'],
      [2, 'ledger_hmac', 'c3ee4259140e74902560847c989dd675de6f9f37985b73665077e4bc5a5e3264'],
      [3, 'd07_core_rest', 'b5d9ac815c9a25c78b78ab1985cba45ccf013ca2345e2a4bd7db968ae8b9b4a1'],
      [4, 'payroll', '47b2a65f601d2e06324bbc1cda7a019551708c3ff9282d44e37d74f083d41fb4'],
      [5, 'tax_bundle', 'ba015b5e9475b9ea05880d7815e6999898332e4ad2be8db997603bce2b4259fc'],
      [6, 'onboarding', 'ac00ee125448df4b5e172cf52c7c34175fdbd8b9c7c229f4fa15ff975c6ee3e9'],
      [7, 'counterparty_items', '8243cf97bb6a13eb2b9166136887cb3dd5c7e359f483457056c13b4358585a68'],
      [8, 'ledger_attempt', '3999cd470c7ee4bf2cd969d12b19a4c66480fa88703befd8cc5685af7db1264e'],
      [9, 'bank_match', '5edef61e8d9494ab2ba3c857a39bec5efe9d725ece0baa4710cebb2f5364bab0'],
      [10, 'ledger_issue_key', 'e495b805912ad0b64ce639d7a17579f3e270d591cd79cfb28568e86a430d1762'],
      [11, 'profile_cert_name', 'efc24eec177b195ef238b38a7cc056b84d88aaf922c9441baf122f0bc02b4ce7'],
      [12, 'ledger_reverify', 'eb352dd990e65c60b8e195b09c9d446bdf30cb8a88271b01f14de784d1b0047b'],
      [13, 'payables_cashflow', '4b594a8699cc2fde8d8fd51adfc75b5b3a8eafdca026a4b4242e31247b5d8c86'],
      [14, 'share_log', '0ede1444ef7375250cc0cd655f7b4f8cc365a77ed434849f2af0e274cd2c5009'],
      [15, 'invoice_amends', 'd8d2b3b8091bfd31411480bdd824ac719811f4b9243f219f78cc65e6c57b25fe'],
      [16, 'counterparty_phone_added', '5d0cbc2c61220174812a6aa6804145c1df404cb3f8de2eabfa8a889c5f4e35ff'],
      [17, 'invoice_bulk_rows', 'f8418457a00da03e1a082cdb4dd7cf8c27c45bc465e4917eed7d7194104f6935'],
      [18, 'ledger_pipeline', '478e02ed1a7b84d81d4b9668764df7739a42cd9769eeb4e761965d7b69aa2583'],
      [19, 'drop_own_bizno_rows', 'd8512b0c3490fe4ca12df4efec0d2b168ba6469349c91ab726332cb974120d1b'],
      [20, 'counterparty_phone', 'a0772948a06aee7ca272d8980eb0e73991569c40e31d2a8bbd4e2bc85ee12fff'],
      [21, 'receivable_receipt_type', '8d058671909f6645fc589bdef457d29f89828f29ca573b7df243b8e485d29891'],
      [22, 'purchase_deductible', 'd29836e764c7045e008d3e8f8542821ee9640c2164b4ed1355476e48298f3cfc'],
      [23, 'cash_receipt_key_day', 'f2bb8287098b71c97b8b131047af8e29707d6f9de599a0692e7a70d290c12448'],
      [24, 'receipt_paper_invoice', 'f32c1feaba02e039f7207cb093b2c838c5567c57e99d72b764eab540b6a36605'],
    ], '합쳐진 마이그레이션은 고치지 않는다. 새 판은 끝에 더하고 이 표에 한 줄을 더한다');
    for (let n = 1; n <= MIGRATIONS.length; n++) {
      const db = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, n) });
      assert.equal(db.pragma('user_version', { simple: true }), n);
      assert.deepEqual(appliedMigrations(db).map((m) => [m.version, m.sha256]), MIGRATIONS.slice(0, n).map((m) => [m.version, migrationSha256(m)]));
      if (n === 9) {
        db.prepare(`INSERT INTO runs (id, playbook_id, playbook_version, package_digest, profile_id, trigger, inputs_hash, status, started_at) VALUES ('r9', 'H-01', '1', 'd', 'p', 'local', 'i', 'running', '2026-11-12T00:00:00Z')`).run();
        db.prepare(`INSERT INTO irreversible_log (intent_id, step_id, attempt, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, device_id, state, armed_at, cp_biz_no_hmac) VALUES ('i9', 's21', 1, 'r9', 'bk', 'H-01', 'i', 'd', 'a', 'dv', 'committed', '2026-11-12T00:00:00Z', 'h')`).run();
        assert.ok(!(db.pragma('table_info(irreversible_log)') as Array<{ name: string }>).some((c) => c.name === 'issue_key'));
      }
      db.close();
    }
    const db = openDatabase(file, k);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert.ok((db.pragma('table_info(profiles)') as Array<{ name: string }>).some((c) => c.name === 'cert_name'));
    assert.equal(db.prepare(`SELECT state || ':' || ifnull(issue_key, '-') FROM irreversible_log WHERE intent_id = 'i9'`).pluck().get(), 'committed:-');
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='ux_irr_issue_live'`).get());
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='bank_accounts'`).get());
    db.close();
  });
});
