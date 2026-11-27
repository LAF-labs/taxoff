
export function runVersion(packaged: boolean, env: NodeJS.ProcessEnv, real: () => string): string {
  const v = env.SAX_DEV_APP_VERSION;
  return !packaged && typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : real();
}

/**
 * 개발 실행이 쓰던 DB의 판을 올리지 않을지. 개발 실행은 설치본과 같은 앱 폴더와 키체인 키를 쓴다(shell.ts).
 * 판을 올리면 설치본이 db.schema_newer로 켜지지 않는다(11-25). 따로 정한 앱 폴더(가짜 홈택스, 시험)는 막지 않고,
 * 같은 폴더에서 일부러 올릴 때만 SAX_DEV_DB_UPGRADE=1.
 */
export function devDbFrozen(packaged: boolean, ownRoot: boolean, env: NodeJS.ProcessEnv): boolean {
  return !packaged && !ownRoot && env.SAX_DEV_DB_UPGRADE !== '1';
}
