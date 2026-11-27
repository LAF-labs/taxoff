import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = `node --conditions=development scripts/gateway-serves.ts [--pc <poc 폴더>]

운영 게이트웨이(https://tax.laf-co.com의 지금 Vercel 배포)가 그 PC 판의 툴셋 판을 모두 내보내는지 본다.
게이트웨이가 모르는 판으로 부르는 PC는 대화가 "답을 받지 못했어요"로 끝난다(11-27). 게시 전에 돌린다.

  --pc <폴더>  게시할 판의 poc 폴더(release-mac.sh의 ~/sax-publish/mac-<판>/src/poc). 기본은 이 저장소.
읽기만 한다(vercel CLI 로그인 필요). 출력: JSON {deployment, missing: [{id, digest}]}. 빠진 판이 있으면 1로 끝난다.`;

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}
const at = argv.indexOf('--pc');
const pc = path.resolve(at >= 0 ? argv[at + 1]! : path.join(import.meta.dirname, '..'));
const RELEASED = '/src/poc/packages/model/toolsets/released.json';

interface FileNode {
  name: string;
  type: string;
  uid?: string;
  children?: FileNode[];
}

const vercel = (endpoint: string): unknown => JSON.parse(execFileSync('vercel', ['api', endpoint], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }));
const find = (nodes: FileNode[], want: string, at = ''): FileNode | undefined => {
  for (const n of nodes) {
    const p = `${at}/${n.name}`;
    if (p === want) return n;
    if (n.children && want.startsWith(`${p}/`)) return find(n.children, want, p);
  }
  return undefined;
};

const deployment = (vercel('/v13/deployments/tax.laf-co.com') as { id: string }).id;
const file = find(vercel(`/v6/deployments/${deployment}/files`) as FileNode[], RELEASED);
if (!file?.uid) {
  console.error(`운영 게이트웨이(${deployment})에 released.json이 없다: 툴셋 판을 고르는 게이트웨이(PR #20) 전 배포다. 게이트웨이를 먼저 배포한다.`);
  process.exit(1);
}
const released = JSON.parse(Buffer.from((vercel(`/v7/deployments/${deployment}/files/${file.uid}`) as { data: string }).data, 'base64').toString('utf8')) as { versions: Record<string, unknown> };

const model = (await import(pathToFileURL(path.join(pc, 'packages/model/src/index.ts')).href)) as { toolsetDigest(t: { id: string }): string };
const gateway = (await import(pathToFileURL(path.join(pc, 'services/gateway/src/service.ts')).href)) as { gatewayToolsets(): Map<string, { id: string }> };
const missing = [...gateway.gatewayToolsets().values()].map((t) => ({ id: t.id, digest: model.toolsetDigest(t) })).filter((x) => !released.versions[x.digest]);

console.log(JSON.stringify({ deployment, missing }));
if (missing.length) {
  console.error(`운영 게이트웨이가 모르는 툴셋 판: ${missing.map((m) => m.id).join(', ')}. 이 판을 담은 게이트웨이를 먼저 배포한다.`);
  process.exit(1);
}
