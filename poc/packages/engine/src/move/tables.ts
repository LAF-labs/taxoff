export type MoveRef =
  | 'profile'
  | 'counterparty'
  | 'document'
  | 'run'
  | 'card_fetch'
  | 'card_txn'
  | 'bank_account'
  | 'bank_import'
  | 'bank_txn'
  | 'receivable'
  | 'alloc'
  | 'employee'
  | 'bundle_item';

export interface MovedTable {
  table: string;
  as?: { ref: MoveRef; col: string };
  refs?: Record<string, MoveRef>;
  owner?: string;
  match: string[][];
  sealed?: string[];
  accountHmac?: { col: string; from: string };
  counterHmac?: string;
  clear?: string[];
  reset?: Record<string, string | number>;
  docIdsJson?: string[];
  autoSeq?: { col: string; self: string[] };
  where?: string;
  order?: string;
}

/** ADR-055 결정 2를 테이블로 옮긴 것. 위에서 아래 순서로 넣는다(부모가 먼저). */
export const MOVED: readonly MovedTable[] = [
  { table: 'counterparties', as: { ref: 'counterparty', col: 'id' }, match: [['biz_no']] },
  {
    table: 'documents',
    as: { ref: 'document', col: 'id' },
    refs: { profile_id: 'profile' },
    match: [['profile_id', 'doc_type', 'sha256']],
    clear: ['blob_id', 'kek_ver'],
    reset: { backup_state: 'none', index_exposed: 0, index_rev_max: 0 },
  },
  {
    table: 'runs',
    as: { ref: 'run', col: 'id' },
    where: 'id IN (SELECT run_id FROM card_fetches)',
    match: [['id']],
    clear: ['inputs_json_enc', 'context_json_enc', 'checkpoint'],
  },
  { table: 'card_fetches', as: { ref: 'card_fetch', col: 'run_id' }, refs: { run_id: 'run', profile_id: 'profile' }, match: [['run_id']] },
  { table: 'card_txns', as: { ref: 'card_txn', col: 'id' }, refs: { profile_id: 'profile', fetch_run_id: 'card_fetch' }, match: [['fetch_run_id', 'seq']] },
  { table: 'card_txn_memos', refs: { profile_id: 'profile', txn_id: 'card_txn' }, match: [['profile_id', 'match_key']] },
  { table: 'receipts', refs: { doc_id: 'document' }, match: [['doc_id'], ['phone_msg_id']] },
  { table: 'cash_sales', refs: { profile_id: 'profile' }, match: [['profile_id', 'day']] },
  {
    table: 'bank_accounts',
    as: { ref: 'bank_account', col: 'id' },
    refs: { profile_id: 'profile' },
    sealed: ['number_enc'],
    accountHmac: { col: 'number_hmac', from: 'number_enc' },
    match: [['profile_id', 'number_hmac']],
    reset: { link_state: 'file_only' },
    clear: ['link_provider', 'link_error', 'link_checked_at'],
  },
  { table: 'bank_imports', as: { ref: 'bank_import', col: 'id' }, refs: { profile_id: 'profile', account_id: 'bank_account', document_id: 'document' }, match: [['id']] },
  {
    table: 'bank_txns',
    as: { ref: 'bank_txn', col: 'id' },
    refs: { profile_id: 'profile', account_id: 'bank_account', import_id: 'bank_import', assigned_counterparty_id: 'counterparty' },
    counterHmac: 'counter_account_hmac',
    match: [['account_id', 'row_key']],
  },
  {
    table: 'cp_bank_accounts',
    refs: { counterparty_id: 'counterparty' },
    sealed: ['number_enc'],
    accountHmac: { col: 'number_hmac', from: 'number_enc' },
    match: [['counterparty_id', 'number_hmac']],
  },
  { table: 'cp_payer_aliases', refs: { counterparty_id: 'counterparty' }, match: [['counterparty_id', 'name_norm']] },
  { table: 'receivables', as: { ref: 'receivable', col: 'id' }, refs: { profile_id: 'profile', counterparty_id: 'counterparty' }, match: [['profile_id', 'approval_no'], ['run_id']] },
  { table: 'receivable_allocs', as: { ref: 'alloc', col: 'id' }, refs: { profile_id: 'profile', receivable_id: 'receivable', txn_id: 'bank_txn' }, owner: 'receivable_id', match: [['id']] },
  { table: 'match_rejects', refs: { receivable_id: 'receivable', txn_id: 'bank_txn' }, owner: 'receivable_id', match: [['receivable_id', 'txn_id']] },
  {
    table: 'receivable_events',
    refs: { profile_id: 'profile', receivable_id: 'receivable', txn_id: 'bank_txn', alloc_id: 'alloc' },
    owner: 'receivable_id',
    match: [],
    autoSeq: { col: 'seq', self: ['undo_of'] },
    order: 'seq',
  },
  { table: 'receivable_adjusts', refs: { profile_id: 'profile', receivable_id: 'receivable' }, owner: 'receivable_id', match: [['run_id']] },
  { table: 'txn_category_rules', refs: { profile_id: 'profile' }, match: [['profile_id', 'direction', 'label_norm']] },
  { table: 'employees', as: { ref: 'employee', col: 'id' }, refs: { profile_id: 'profile' }, sealed: ['rrn_enc'], match: [['id']] },
  { table: 'payroll_months', refs: { profile_id: 'profile' }, docIdsJson: ['notice_doc_ids_json'], match: [['profile_id', 'month', 'revision']] },
  { table: 'payroll_lines', refs: { profile_id: 'profile', employee_id: 'employee' }, match: [['profile_id', 'month', 'revision', 'employee_id']] },
  { table: 'shifts', refs: { profile_id: 'profile', employee_id: 'employee' }, match: [['id']] },
  { table: 'bundle_items', as: { ref: 'bundle_item', col: 'id' }, refs: { profile_id: 'profile' }, match: [['id']] },
  { table: 'bundle_entries', refs: { item_id: 'bundle_item' }, docIdsJson: ['doc_ids_json'], match: [['item_id', 'period']] },
  { table: 'schedules', refs: { profile_id: 'profile' }, clear: ['last_run_id'], match: [['id']] },
  { table: 'consents', refs: { profile_id: 'profile' }, autoSeq: { col: 'seq', self: [] }, order: 'seq', match: [['profile_id', 'kind', 'notice_key', 'notice_version', 'choice', 'at']] },
  { table: 'cash_receipts', refs: { profile_id: 'profile' }, clear: ['sync_id'], match: [['profile_id', 'side', 'day', 'approval_no', 'canceled']] },
  { table: 'card_sales', refs: { profile_id: 'profile' }, clear: ['sync_id'], match: [['profile_id', 'month', 'issuer']] },
  { table: 'validity_rules', match: [['doc_type']] },
];

/** 설정 중 사업자에 딸린 것만 옮긴다. 열쇠 안의 사업자 ID를 새 PC의 것으로 바꾼다. */
export const MOVED_SETTING = /^profile\.([0-9a-f-]{36})\.((?:payroll|bundle|bank)\..+)$/;

/** 옮기지 않는 테이블과 까닭(ADR-055 결정 2). profiles는 종류별로 새 PC의 것에 맞춘다. */
export const STAYS: Readonly<Record<string, string>> = {
  profiles: 'new PC has its own; rows are mapped by kind and business number',
  settings: 'only MOVED_SETTING keys move',
  run_events: 'run ledger',
  irreversible_log: 'run ledger',
  gate_requests: 'run ledger',
  invoice_amends: 'run ledger',
  invoice_bulk_rows: 'run ledger',
  rate_counters: 'per-PC limits',
  clock_guard: 'per-PC clock',
  cooldowns: 'per-PC limits',
  playbook_packages: 'new PC fetches its own',
  policy: 'new PC fetches its own',
  registry_state: 'new PC fetches its own',
  rate_tables: 'new PC fetches its own',
  temp_previews: 'short-lived',
  usage_local: 'per-PC usage',
  remote_devices: 'phones pair again with the new PC',
  remote_pair_state: 'phones pair again with the new PC',
  remote_cmd_seen: 'phones pair again with the new PC',
  bundle_exports: 'export files stay on the old PC',
  onboarding_state: 'new PC has its own',
  share_out: 'shared record sync state',
  share_in: 'shared record sync state',
  share_state: 'shared record sync state',
  share_party: 'shared record sync state',
  hometax_syncs: 'new PC syncs from Hometax itself',
  schema_migrations: 'schema bookkeeping',
  sqlite_sequence: 'schema bookkeeping',
};
