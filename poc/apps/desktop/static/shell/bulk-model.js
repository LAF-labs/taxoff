// 여러 건 발급 묶음(ADR-059 결정 3, 4, 5)의 값과 확인할 이유. 화면 없이 셈만 한다.

/** 확인할 이유는 사람 말로 짧게(결정 4). 화면에는 첫 이유 하나만 보인다. */
export const REASON = {
  party_missing: '거래처가 비어 있어요',
  cp_ambiguous: '같은 이름 거래처가 여럿이에요',
  bizno_missing: '사업자번호가 없어요',
  bizno_invalid: '사업자번호가 틀려요',
  bizno_not_business: '사업자번호가 아니에요',
  amount_missing: '금액이 비어 있어요',
  amount_zero: '금액이 0원이에요',
  amount_negative: '금액이 마이너스예요',
  amount_mismatch: '합계가 맞지 않아요',
  vat_unusual: '부가세가 10%가 아니에요',
  date_invalid: '날짜를 읽지 못했어요',
  date_future: '앞날 날짜예요',
  duplicate_in_file: '같은 금액이 또 있어요',
  party_filled_down: '거래처를 윗줄에서 가져왔어요',
  item_missing: '품목이 비어 있어요',
  biz_closed: '폐업한 곳이에요',
  biz_unregistered: '국세청에 없는 번호예요',
  biz_suspended: '휴업한 곳이에요',
};
/** 국세청 사업자 상태(main이 조회) → 확인할 이유 */
const STATUS_ISSUE = { '02': 'biz_suspended', '03': 'biz_closed', '': 'biz_unregistered' };
/** 사장님이 맞다고 보면 체크만 켜면 되는 이유. 나머지는 고쳐야 넣을 수 있다. */
export const SOFT = new Set(['duplicate_in_file', 'party_filled_down', 'vat_unusual', 'amount_mismatch', 'biz_suspended']);
/** 그 칸을 고치면 파일에서 온 이유가 풀린다 */
const CLEARS = {
  name: ['party_missing', 'party_filled_down', 'duplicate_in_file'],
  date: ['duplicate_in_file'],
  item: ['duplicate_in_file'],
  supply: ['amount_mismatch', 'duplicate_in_file'],
  vat: ['amount_mismatch', 'duplicate_in_file'],
};
const ORDER = Object.keys(REASON);
const FILE_KEEP = new Set(['bizno_invalid', 'bizno_not_business', 'duplicate_in_file', 'party_filled_down', 'amount_mismatch']);

const compact = (s) => String(s ?? '').replace(/\s+/g, '').replace(/\(주\)|㈜|주식회사/g, '').toLowerCase();
export const vatOf = (supply) => (supply == null ? null : Math.floor(supply / 10));

/** 거래처 목록과 맞춘다: 파일 번호 → 같은 이름 한 곳 → 여럿이면 확인 */
export function matchParty(row, cps) {
  if (row.fileBizNo) return { bizNo: row.fileBizNo, cpId: cps.find((c) => c.bizNo === row.fileBizNo)?.id ?? null, issue: null };
  const key = compact(row.name);
  if (!key) return { bizNo: null, cpId: null, issue: 'party_missing' };
  const hits = cps.filter((c) => compact(c.name) === key);
  if (hits.length === 1) return { bizNo: hits[0].bizNo || null, cpId: hits[0].id, issue: hits[0].bizNo ? null : 'bizno_missing' };
  if (hits.length > 1) return { bizNo: null, cpId: null, issue: 'cp_ambiguous' };
  return { bizNo: null, cpId: null, issue: 'bizno_missing' };
}

export function rowIssues(row, cps, today, status = {}) {
  const out = new Set(row.fileIssues.filter((c) => FILE_KEEP.has(c)));
  const party = matchParty(row, cps);
  row.bizNo = party.bizNo;
  row.cpId = party.cpId;
  if (party.bizNo) {
    out.delete('bizno_invalid');
    out.delete('bizno_not_business');
  } else if (party.issue && !(party.issue === 'bizno_missing' && (out.has('bizno_invalid') || out.has('bizno_not_business')))) out.add(party.issue);
  if (party.bizNo && party.bizNo in status) out.add(STATUS_ISSUE[status[party.bizNo]]);
  if (!String(row.item ?? '').trim() && row.cpId) row.item = cps.find((c) => c.id === row.cpId)?.item ?? '';
  if (!String(row.item ?? '').trim()) out.add('item_missing');
  if (row.supply == null) out.add('amount_missing');
  else if (row.supply === 0) out.add('amount_zero');
  else if (row.supply < 0) out.add('amount_negative');
  else if (row.taxable && row.vat != null && Math.abs(row.vat - row.supply / 10) > 10) out.add('vat_unusual');
  if (!row.date) out.add('date_invalid');
  else if (row.date > today) out.add('date_future');
  return ORDER.filter((c) => out.has(c));
}
export const isHard = (issues) => issues.some((c) => !SOFT.has(c));
export const totalOf = (r) => (r.supply == null ? null : r.supply + (r.vat ?? 0));

/** main이 읽은 행(BulkRow) → 화면 행. 확인할 건은 체크가 꺼진 채 맨 위로 모은다(결정 4). */
export function makeBatch(rows, cps, today, id = `bulk-${Date.now()}`, status = {}) {
  const list = rows.map((r) => {
    const row = { key: r.key, line: r.line, name: r.name, fileBizNo: r.bizNo, bizNo: r.bizNo, cpId: null, date: r.date, item: r.item, supply: r.supply, vat: r.vat, taxable: r.taxable, fileIssues: [...r.fileIssues], vatTouched: false, issues: [], on: true, flagged: false };
    row.issues = rowIssues(row, cps, today, status);
    row.on = row.issues.length === 0;
    row.flagged = !row.on;
    return row;
  });
  const flagged = list.filter((r) => r.flagged);
  return { id, today, status: { ...status }, rows: [...flagged, ...list.filter((r) => !r.flagged)], rev: 0 };
}

/** 칸 하나를 고친다. 이름은 파일에 맞는 번호가 없을 때만 거래처 목록과 다시 맞춘다. 공급가액을 고치면 부가세가 따라 바뀐다(따로 고친 뒤에는 그대로). 확인할 것이 다 풀리면 체크가 저절로 켜진다. */
export function editRow(batch, row, field, value, cps) {
  for (const c of CLEARS[field] ?? []) row.fileIssues = row.fileIssues.filter((x) => x !== c);
  if (field === 'name') {
    row.name = String(value).trim();
  } else if (field === 'item') row.item = String(value).trim();
  else if (field === 'date') row.date = value;
  else if (field === 'supply') {
    row.supply = value;
    if (!row.vatTouched) row.vat = row.taxable ? vatOf(value) : 0;
  } else if (field === 'vat') {
    row.vat = value;
    row.vatTouched = true;
  }
  const had = row.issues.length > 0;
  row.issues = rowIssues(row, cps, batch.today, batch.status);
  if (row.issues.length === 0 && had) row.on = true;
  if (isHard(row.issues)) row.on = false;
  batch.rev++;
}

/** 맨 앞 체크. 고쳐야 하는 이유가 남은 건은 켜지지 않는다. */
export function setOn(batch, row, on) {
  if (on && isHard(row.issues)) return false;
  row.on = on;
  batch.rev++;
  return true;
}

export function summary(batch) {
  const on = batch.rows.filter((r) => r.on);
  const off = batch.rows.filter((r) => !r.on);
  const dates = on.map((r) => r.date).filter(Boolean).sort();
  const largest = on.reduce((m, r) => (m && (totalOf(m) ?? 0) >= (totalOf(r) ?? 0) ? m : r), null);
  return {
    count: batch.rows.length,
    ready: on.length,
    parties: new Set(on.map((r) => r.bizNo ?? compact(r.name))).size,
    supply: on.reduce((s, r) => s + (r.supply ?? 0), 0),
    vat: on.reduce((s, r) => s + (r.vat ?? 0), 0),
    total: on.reduce((s, r) => s + (totalOf(r) ?? 0), 0),
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    largest,
    attention: batch.rows.filter((r) => r.issues.length && !r.on).length,
    excluded: off.length,
    excludedAttention: off.length > 0 && off.every((r) => r.issues.length > 0),
  };
}

/** 발급 직전 main이 다시 조회한 상태를 묶음에 더한다. 폐업이나 없는 번호가 된 건은 체크가 꺼지고 확인할 건으로 올라간다. 바뀐 건 수를 돌려준다. */
export function applyStatus(batch, status, cps) {
  batch.status = { ...batch.status, ...status };
  let n = 0;
  for (const r of batch.rows) {
    const before = r.issues.join(',');
    r.issues = rowIssues(r, cps, batch.today, batch.status);
    if (r.issues.join(',') === before) continue;
    n++;
    if (isHard(r.issues)) r.on = false;
    r.flagged = r.flagged || r.issues.length > 0;
  }
  if (n) {
    batch.rows = [...batch.rows.filter((r) => r.flagged), ...batch.rows.filter((r) => !r.flagged)];
    batch.rev++;
  }
  return n;
}

/** 발급할 건만 main에 보낼 값으로(bulk.issue). 확인할 이유가 남은 건은 사장님이 체크를 켠 것이다. */
export function issuePayload(batch) {
  return batch.rows.filter((r) => r.on).map((r) => ({ key: r.key, name: r.name, bizNo: r.bizNo ?? '', cpId: r.cpId, date: r.date ?? '', item: r.item, supply: r.supply ?? 0, vat: r.vat ?? 0, taxable: r.taxable }));
}

/** 묶음 전체를 묶은 대조 값(결정 5): 행마다 번호, 작성일, 공급가액, 부가세. 승인 뒤 한 행이라도 바뀌면 달라진다. */
export function batchDigest(batch) {
  return batch.rows.filter((r) => r.on).map((r) => `${r.bizNo ?? ''}|${r.date ?? ''}|${r.supply ?? ''}|${r.vat ?? ''}`).join('\n');
}

export function dateLabel(iso, today) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(y) === today.slice(0, 4) ? '' : `${y}년 `}${m}월 ${d}일`;
}
export function periodLabel(from, to, today) {
  if (!from) return '';
  if (from === to) return dateLabel(from, today);
  const a = dateLabel(from, today);
  const b = from.slice(0, 7) === to.slice(0, 7) ? `${Number(to.slice(8))}일` : dateLabel(to, today);
  return `${a}부터 ${b}`;
}

const valid = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};
/** 표 칸에 친 날짜: "11월 24일", "11/24", "11.24", "2026-11-24", "2026.11.24", "24일"(이번 달) */
export function parseDateInput(text, today) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const ty = Number(today.slice(0, 4));
  let m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?$/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?$/.exec(s);
  if (m) return valid(ty, Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})\s*일$/.exec(s);
  if (m) return valid(ty, Number(today.slice(5, 7)), Number(m[1]));
  return null;
}
/** 표 칸에 친 금액: 숫자와 쉼표만 본다. 비우면 null */
export function parseAmountInput(text) {
  const s = String(text ?? '').replace(/[,\s원₩]/g, '');
  if (!s) return null;
  if (!/^-?\d{1,13}$/.test(s)) return undefined;
  return Number(s);
}
