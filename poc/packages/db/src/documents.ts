import { ValidationError } from './repo.ts';
import type { Db } from './open.ts';

export interface DocumentRow {
  id: string;
  profileId: string;
  docType: string;
  displayName: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  issuer: string | null;
  path: string;
  bytes: number;
  sha256: string;
  meta: Record<string, unknown> | null;
  runId: string | null;
  createdAt: string;
}

export type DocumentPatch = Partial<Pick<DocumentRow, 'docType' | 'displayName' | 'issuedAt' | 'expiresAt' | 'issuer' | 'path' | 'meta'>>;

type Row = Record<string, unknown>;

const toDocument = (r: Row): DocumentRow => ({
  id: String(r.id),
  profileId: String(r.profile_id),
  docType: String(r.doc_type),
  displayName: (r.display_name as string) ?? null,
  issuedAt: (r.issued_at as string) ?? null,
  expiresAt: (r.expires_at as string) ?? null,
  issuer: (r.issuer as string) ?? null,
  path: String(r.path),
  bytes: Number(r.bytes),
  sha256: String(r.sha256),
  meta: r.meta_json ? (JSON.parse(String(r.meta_json)) as Record<string, unknown>) : null,
  runId: (r.run_id as string) ?? null,
  createdAt: String(r.created_at),
});

export class DocumentRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(d: Omit<DocumentRow, 'createdAt'>, createdAt: string = new Date().toISOString()): DocumentRow {
    this.db
      .prepare(`INSERT INTO documents (id, profile_id, doc_type, display_name, issued_at, expires_at, issuer, path, bytes, sha256, meta_json, run_id, created_at)
        VALUES (@id, @profileId, @docType, @displayName, @issuedAt, @expiresAt, @issuer, @path, @bytes, @sha256, @meta, @runId, @createdAt)`)
      .run({ ...d, meta: d.meta ? JSON.stringify(d.meta) : null, createdAt });
    return this.get(d.id)!;
  }

  get(id: string): DocumentRow | null {
    const r = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    return r ? toDocument(r as Row) : null;
  }

  bySha256(sha256: string): DocumentRow | null {
    const r = this.db.prepare('SELECT * FROM documents WHERE sha256 = ? ORDER BY created_at LIMIT 1').get(sha256);
    return r ? toDocument(r as Row) : null;
  }

  list(): DocumentRow[] {
    return this.db.prepare('SELECT * FROM documents ORDER BY COALESCE(issued_at, substr(created_at, 1, 10)) DESC, created_at DESC').all().map((r) => toDocument(r as Row));
  }

  update(id: string, patch: DocumentPatch): DocumentRow {
    const cur = this.get(id);
    if (!cur) throw new ValidationError('not_found');
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as DocumentRow;
    this.db
      .prepare('UPDATE documents SET doc_type=?, display_name=?, issued_at=?, expires_at=?, issuer=?, path=?, meta_json=? WHERE id=?')
      .run(next.docType, next.displayName, next.issuedAt, next.expiresAt, next.issuer, next.path, next.meta ? JSON.stringify(next.meta) : null, id);
    return this.get(id)!;
  }

  overrideDays(docType: string): number | null {
    const r = this.db.prepare('SELECT user_override_days AS d FROM validity_rules WHERE doc_type = ?').get(docType) as { d: number | null } | undefined;
    return r?.d ?? null;
  }
}

/** 보관 파일 이름에 쓰는 서류명. 종류마다 고정이라 파일 이름에 거래처, 번호 같은 개인 정보가 들어가지 않는다(V-23). */
const DOC_FILE_LABEL: Record<string, string> = {
  national_tax_cert: '납세증명서',
  biz_registration_cert: '사업자등록증명',
  vat_tax_base_cert: '부가가치세과세표준증명',
  financial_statements_cert: '표준재무제표증명',
  tax_invoice: '전자세금계산서',
  paper_receipt: '종이증빙',
  settlement_file: '정산자료',
  payroll_ledger: '급여대장',
  bundle_file: '세무자료',
};

/**
 * 보관 파일 이름: "서류명_날짜.확장자"(대표 11-25: "사업자등록증명_20261125"처럼). 같은 이름이 있으면 n으로 "_2", "_3"을 붙인다(n은 0부터).
 * 세금계산서는 거래처명을 넣는다(대표 11-25: "각 거래처명이 들어가야"): "전자세금계산서_A상사_20261125". 파일 이름에 못 쓰는 글자와 빈칸은 뺀다.
 */
export function docFileName(docType: string, day: string, ext: string, n = 0, party?: string): string {
  const who = [...(party ?? '')].filter((c) => c.charCodeAt(0) >= 0x20).join('').replace(/[\\/:*?"<>|\s]+/g, '').replace(/^\.+/, '').slice(0, 40);
  return `${DOC_FILE_LABEL[docType] ?? '서류'}${who ? `_${who}` : ''}_${day.replace(/-/g, '')}${n > 0 ? `_${n + 1}` : ''}.${ext}`;
}
