import type { DocRefresh, DocumentView } from '@sax/engine';
import { CERT_DOCS } from './cert-docs.ts';

export type { DocRefresh };

export const REFRESH_MONTHS = 3;

export interface CertRow {
  code: string;
  name: string;
  docIds: string[];
  on: boolean;
  dueOn: string | null;
  due: boolean;
  failedToday: boolean;
  failure: string | null;
}

export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

type VaultDoc = Pick<DocumentView, 'id' | 'docType' | 'issuedOn' | 'createdAt'>;

export function certRows(list: readonly DocRefresh[], docs: readonly VaultDoc[], today: string): CertRow[] {
  return CERT_DOCS.flatMap((def) => {
    const mine = docs.filter((d) => d.docType === def.docType).sort((a, b) => (b.issuedOn ?? '').localeCompare(a.issuedOn ?? '') || b.createdAt.localeCompare(a.createdAt));
    const r = list.find((x) => x.code === def.code);
    if (!mine.length && !r) return [];
    const lastOn = mine.find((d) => d.issuedOn)?.issuedOn ?? null;
    const dueOn = r ? (lastOn ? addMonths(lastOn, REFRESH_MONTHS) : today) : null;
    return [{
      code: def.code,
      name: def.name,
      docIds: mine.map((d) => d.id),
      on: !!r,
      dueOn,
      due: !!dueOn && dueOn <= today,
      failedToday: r?.failedOn === today,
      failure: r?.failedOn && r.failedOn >= (lastOn ?? '') ? (r.failure ?? null) : null,
    }];
  });
}

export function nextToRun(rows: readonly CertRow[]): CertRow | null {
  return rows.filter((s) => s.on && s.due && !s.failedToday).sort((a, b) => a.dueOn!.localeCompare(b.dueOn!))[0] ?? null;
}
