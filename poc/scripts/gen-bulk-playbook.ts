import fs from 'node:fs';
import path from 'node:path';
import { BULK_ID, BUYER_LOOKUP_ID, bulkPackage, buyerLookupPackage } from './playbooks/hometax-invoice-bulk.ts';

const DIR = path.resolve(import.meta.dirname, '../packages/engine/playbooks');
const jsonText = (o: unknown): string => JSON.stringify(o, null, 1);

export function bulkOutputs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, p] of [[BULK_ID, bulkPackage()], [BUYER_LOOKUP_ID, buyerLookupPackage()]] as const) {
    out.set(`${id}/manifest.json`, jsonText(p.manifest));
    out.set(`${id}/playbook.json`, jsonText(p.playbook));
    out.set(`${id}/selectors.json`, jsonText(p.selectors));
    out.set(`${id}/strings.ko.json`, jsonText(p.strings));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [rel, text] of bulkOutputs()) {
    const f = path.join(DIR, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
}
