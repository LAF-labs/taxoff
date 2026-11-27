import fs from 'node:fs';
import path from 'node:path';
import { AMEND_ID, amendCaptureList, amendPackage } from './playbooks/hometax-invoice-amend.ts';

const DIR = path.resolve(import.meta.dirname, '../packages/engine/playbooks');
const jsonText = (o: unknown): string => JSON.stringify(o, null, 1);

export function amendOutputs(): Map<string, string> {
  const p = amendPackage();
  return new Map([
    [`${AMEND_ID}/manifest.json`, jsonText(p.manifest)],
    [`${AMEND_ID}/playbook.json`, jsonText(p.playbook)],
    [`${AMEND_ID}/selectors.json`, jsonText(p.selectors)],
    [`${AMEND_ID}/strings.ko.json`, jsonText(p.strings)],
    ['CAPTURE-hometax-amend.md', amendCaptureList()],
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [rel, text] of amendOutputs()) {
    const f = path.join(DIR, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
}
