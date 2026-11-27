import fs from 'node:fs';
import { RELEASED_TOOLSETS_FILE, readReleasedToolsets, toolsetVersion, versionDigest, type ReleasedToolsets } from '@sax/model';
import { gatewayToolsets } from '../services/gateway/src/service.ts';

const HELP = `node --conditions=development scripts/toolsets-released.ts [--check]

게이트웨이가 지금 내보내는 툴셋 판을 packages/model/toolsets/released.json에 더한다.
게이트웨이는 이 파일의 모든 판을 계속 내보내므로, 옛 앱은 자기 toolsetDigest로 옛 판을 받는다.
툴셋 머리말·도구·출력을 바꾼 뒤 한 번 돌리고 그 파일을 같이 커밋한다. 판은 지우지 않는다.

  --check  쓰지 않고, 빠진 판이 있으면 그 툴셋 이름을 찍고 1로 끝난다.
출력: JSON {added: [{id, digest}], file}`;

if (process.argv.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}

const released: ReleasedToolsets = readReleasedToolsets();
const added: Array<{ id: string; digest: string }> = [];
for (const t of gatewayToolsets().values()) {
  const v = toolsetVersion(t);
  const digest = versionDigest(v);
  if (released.versions[digest]) continue;
  released.versions[digest] = v;
  added.push({ id: v.id, digest });
}

if (process.argv.includes('--check')) {
  if (added.length) {
    console.error(`released.json에 없는 툴셋 판: ${added.map((a) => a.id).join(', ')}. node --conditions=development scripts/toolsets-released.ts 를 돌려 더한다.`);
    process.exit(1);
  }
} else if (added.length) {
  const versions = Object.fromEntries(Object.entries(released.versions).sort(([a, x], [b, y]) => x.id.localeCompare(y.id) || a.localeCompare(b)));
  fs.writeFileSync(RELEASED_TOOLSETS_FILE, `${JSON.stringify({ withoutDigest: released.withoutDigest, versions }, null, 2)}\n`);
}
console.log(JSON.stringify({ added, file: RELEASED_TOOLSETS_FILE.pathname }));
