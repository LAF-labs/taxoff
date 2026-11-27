import os from 'node:os';
import path from 'node:path';

export interface AppPaths {
  root: string;
  userData: string;
  db: string;
  vault: string;
  chromeProfile: string;
  staging: string;
  logs: string;
  crashDumps: string;
}

export const APP_DIR_NAME = 'SovereignAX';
export const DEV_APP_DIR_NAME = 'SovereignAX-dev';

export function defaultAppRoot(platform: NodeJS.Platform = process.platform, dir: string = APP_DIR_NAME): string {
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error('LOCALAPPDATA is not set');
    return path.win32.join(local, dir);
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', dir);
  return path.join(os.homedir(), '.local', 'share', dir);
}

export function appPaths(root: string = defaultAppRoot()): AppPaths {
  const j = (p: string) => path.join(root, p);
  return {
    root,
    userData: j('userData'),
    db: j('db'),
    vault: j('vault'),
    chromeProfile: j('chrome-profile'),
    staging: j('staging'),
    logs: j('logs'),
    crashDumps: j('crashDumps'),
  };
}
