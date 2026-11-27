import fs from 'node:fs';
import path from 'node:path';
import type { PackageFiles, SelectorEntry, Step } from '@sax/engine/core';

/**
 * 월 리포트 홈택스 자동 받기 패키지 hometax.report.sync(ADR-068 결정 6). 읽기 전용이다: 승인 카드, 제출, 커밋 요청이 없고 effects도 없다(V-27).
 * 로그인은 발급 패키지(hometax.invoice.issue)와 같은 화면이라 그 스텝과 셀렉터를 가져온다. 로그인 뒤 report_sync 스텝 하나가 받기 계획(plan)의
 * 구간마다 금고 고정 스크립트로 조회 화면을 읽는다(메뉴 클릭으로 들어가기, 기간 고르기, alert 가로채기, 쪽 넘기기는 금고 report/read.ts).
 * 조회 화면 id는 2026-11-25 맥북 실측(/mnt/project-files/hometax-ref/report-probe.md)이고 금고 표(report/screens.ts)에 있어 패키지가 바꿀 수 없다.
 * 손으로 고치지 말고 이 파일을 고친 뒤 `node --conditions=development scripts/gen-report-playbook.ts`로 다시 만든다.
 */
export const REPORT_ID = 'hometax.report.sync';
export const REPORT_VERSION = '1.0.0';
const VERIFIED = '2026-11-25';

const H01_DIR = path.resolve(import.meta.dirname, '../../packages/engine/playbooks/hometax.invoice.issue');
const LOGIN_STEPS = ['s0', 's2', 's3', 's4', 's4a', 's4b', 's4c', 's8', 's8a', 's8b', 's4d', 's4e', 's4f', 's4g', 's4h', 's5', 's6', 's7', 's7a', 's7b', 's7c', 's7d', 's7e', 's7f', 's7g'];
const STRINGS = ['login.loggedIn', 'hometax.login.successMarker', 'cert.passwordPrompt', 'cert.pickOne', 'login.certNoticeWindow', 'login.simpleAuth', 'popup.hide', 'popup.hide.idPrefix', 'popup.hide.cookie', 'popup.window.close'];
/** 조회 화면의 요청(실측). 조회만이라 commitEndpoints는 비우고 knownEndpoints로만 둔다(커밋 가드는 발급 패키지 커밋 요청을 계속 막는다). */
const READ_HOSTS: ReadonlyArray<[string, string]> = [['tecr.hometax.go.kr', '^/wqAction\\.do$'], ['teht.hometax.go.kr', '^/wqAction\\.do$'], ['tecr.hometax.go.kr', '^/permission\\.do$'], ['teht.hometax.go.kr', '^/permission\\.do$']];

const read = (f: string) => JSON.parse(fs.readFileSync(path.join(H01_DIR, f), 'utf8'));

export function reportPackage(): PackageFiles {
  const h01 = { playbook: read('playbook.json'), selectors: read('selectors.json'), strings: read('strings.ko.json'), manifest: read('manifest.json') };
  const byId = (id: string): Step => {
    const s = (h01.playbook.steps as Step[]).find((x) => x.id === id);
    if (!s) throw new Error(`H-01에 스텝이 없다: ${id}`);
    return structuredClone(s);
  };
  const steps: Step[] = [
    ...LOGIN_STEPS.map(byId),
    // 받기 계획의 구간마다 금고가 조회 화면을 읽는다. 구간 하나의 실패는 다음 구간을 막지 않고, 하나도 못 받으면 실패로 끝난다.
    { id: 's10', type: 'report_sync', plan: '$inputs.plan', onFail: { retry: 0, then: 'abort' } } as Step,
    { id: 's11', type: 'end', status: 'success' } as Step,
  ];
  const keys = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    else if (typeof x === 'string' && Object.hasOwn(h01.selectors.entries, x)) keys.add(x);
  };
  walk(steps);
  walk(h01.playbook.closeLayers.targets);
  walk(h01.playbook.closeWindows);
  const all = h01.selectors.entries as Record<string, SelectorEntry>;
  for (const k of [...keys]) for (let l = all[k]!.landmark; l && !keys.has(l); l = all[l]?.landmark) keys.add(l);
  const entries = Object.fromEntries([...keys].sort().map((k) => [k, all[k]!]));
  const strings: Record<string, string> = {
    'report.title': '홈택스 자료 받기',
    ...Object.fromEntries(STRINGS.map((k) => {
      if (!Object.hasOwn(h01.strings, k)) throw new Error(`H-01에 글이 없다: ${k}`);
      return [k, h01.strings[k]];
    })),
  };
  const playbook = {
    ir: 2, id: REPORT_ID, version: REPORT_VERSION, portal: 'hometax', profileKinds: ['business'], effects: [],
    inputs: { plan: { type: 'report_plan', required: true } },
    preconditions: [{ profileHas: 'signMethod' }],
    recovery: h01.playbook.recovery,
    steps,
    postconditions: [],
    pacing: h01.playbook.pacing,
    closeWindows: h01.playbook.closeWindows,
    closeLayers: { ...h01.playbook.closeLayers, until: 's10' },
  };
  const manifest = { ...h01.manifest, id: REPORT_ID, version: REPORT_VERSION, title: 'report.title', effects: [], createdAt: `${VERIFIED}T00:00:00+09:00`, lookupsUsed: [] };
  return {
    manifest, playbook, strings,
    selectors: {
      portal: 'hometax', entries, commitEndpoints: [],
      knownEndpoints: [...h01.selectors.knownEndpoints, ...READ_HOSTS.map(([host, pathPattern]) => ({ method: 'POST', host, pathPattern }))],
    },
  } as unknown as PackageFiles;
}
