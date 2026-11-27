import fs from 'node:fs';
import path from 'node:path';
import { REPORT_ID, reportPackage } from './playbooks/hometax-report-sync.ts';

const DIR = path.resolve(import.meta.dirname, '../packages/engine/playbooks');
const jsonText = (o: unknown): string => JSON.stringify(o, null, 1);

export function reportOutputs(): Map<string, string> {
  const p = reportPackage();
  return new Map([
    [`${REPORT_ID}/manifest.json`, jsonText(p.manifest)],
    [`${REPORT_ID}/playbook.json`, jsonText(p.playbook)],
    [`${REPORT_ID}/selectors.json`, jsonText(p.selectors)],
    [`${REPORT_ID}/strings.ko.json`, jsonText(p.strings)],
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [rel, text] of reportOutputs()) {
    const f = path.join(DIR, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
}
