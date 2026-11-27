import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const pinPath = new URL('../../.github/codemap.sha256', import.meta.url);
const cli = 'node poc/scripts/codemap-pin.mjs';
const refresh = `artiboard에서 게시한 codemap.mjs를 검토한 뒤 ${cli} update <검토한-파일>을 실행하고 .github/codemap.sha256을 커밋하세요.`;
const usage = `저장소 루트에서 실행:
  ${cli} verify <파일>                   등록된 SHA-256과 비교합니다. 불일치하면 종료 코드 1을 반환합니다.
  ${cli} update <검토한-파일> [--dry-run] 검토한 파일의 SHA-256을 등록합니다. --dry-run은 저장하지 않습니다.
  ${cli} --help

파일을 실행하지 않고 해시만 계산합니다. 결과는 JSON으로 출력합니다.
비교할 파일은 curl -fsSL --proto '=https' https://project.laf-co.com/codemap.mjs -o /tmp/codemap.mjs 로 받을 수 있습니다.`;

function main() {
  const [command, artifact, option, ...rest] = process.argv.slice(2);
  if (command === '--help' && !artifact) {
    console.log(usage);
    return;
  }
  const dryRun = option === '--dry-run';
  if ((command !== 'verify' && command !== 'update') || !artifact || artifact.startsWith('-') ||
      (option !== undefined && !(command === 'update' && dryRun)) || rest.length) {
    throw new Error(`명령과 파일 경로를 확인하세요. 사용법: ${cli} --help`);
  }

  const pinned = readFileSync(pinPath, 'utf8').trim();
  const actual = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  if (pinned === actual) {
    console.log(JSON.stringify({ status: 'current', pinned }));
  } else if (command === 'verify') {
    console.error(JSON.stringify({ status: 'stale', pinned, actual, message: refresh }));
    process.exitCode = 1;
  } else {
    if (!dryRun) writeFileSync(pinPath, `${actual}\n`);
    console.log(JSON.stringify({ status: dryRun ? 'would-update' : 'updated', pinned, actual }));
  }
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ status: 'error', message: String(error) }));
  process.exitCode = 1;
}
