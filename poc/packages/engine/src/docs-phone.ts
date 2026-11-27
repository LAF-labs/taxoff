import type { Db } from '@sax/db';

export interface DocPhoneRow {
  id: string;
  name: string;
  docType: string;
  issuedOn: string | null;
  expiresOn: string | null;
  bytes: number;
  sha256: string;
}

export function docsForPhone(db: Db): DocPhoneRow[] {
  const rows = db.prepare('SELECT id, doc_type, display_name, issued_at, expires_at, bytes, sha256 FROM documents ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id), name: String(r.display_name ?? '서류'), docType: String(r.doc_type), issuedOn: (r.issued_at as string | null) ?? null, expiresOn: (r.expires_at as string | null) ?? null,
    bytes: Number(r.bytes), sha256: String(r.sha256),
  }));
}
