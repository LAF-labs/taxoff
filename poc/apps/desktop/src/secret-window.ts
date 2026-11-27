import path from 'node:path';
import { BrowserWindow, type MessagePortMain } from 'electron';
import { hardenWindow } from './harden.ts';
import { IPC } from './ipc.ts';

const STATIC = path.join(import.meta.dirname, '../static');

/** 창이 뜬 직후 본체가 잠깐 포커스를 받는 일은 바깥 누르기로 보지 않는다 */
const OPEN_GRACE_MS = 400;

/**
 * 비밀 입력 창. OS 시트(modal)로 띄우면 macOS가 본체를 딤으로 덮고 그 딤은 눌러도 닫히지 않아 창을 빠져나갈 길이 없었다(대표 2026-11-23).
 * 그래서 본체 위에 뜨는 자식 창으로 띄우고, 본체를 누르면(본체가 포커스를 받으면) 이 창을 닫는다. Esc는 창 안에서 닫는다(codef-secret.js).
 * 닫으면 요청은 취소된다: 비밀번호를 넣는 동안 본체를 함께 쓰는 일은 여전히 없다.
 */
export function openVaultInputWindow(parent: BrowserWindow, port: MessagePortMain, url: string, title: string, height = 300, log?: (name: string, data: Record<string, string | number>) => void): BrowserWindow {
  const win = new BrowserWindow({
    parent,
    modal: false,
    width: 440,
    height,
    ...centerOn(parent, 440, height),
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
      disableDialogs: true,
      webviewTag: false,
      preload: path.join(STATIC, 'preload-secret.cjs'),
    },
  });
  try {
    win.setMenu(null);
    win.setContentProtection(true);
    hardenWindow(win);
    win.on('page-title-updated', (e) => e.preventDefault());
  } catch (e) {
    win.destroy();
    throw e;
  }
  let sent = false;
  const drop = () => {
    if (!sent) port.close();
  };
  void win.loadURL(url).then(
    () => {
      if (win.isDestroyed()) return drop();
      win.webContents.postMessage(IPC.secretPort, null, [port]);
      sent = true;
    },
    () => {
      drop();
      if (!win.isDestroyed()) win.close();
    },
  );
  const openedAt = Date.now();
  const outside = () => {
    if (Date.now() - openedAt < OPEN_GRACE_MS || win.isDestroyed()) return;
    log?.('main.secret_window_dismissed', { step: 'outside' });
    win.close();
  };
  parent.on('focus', outside);
  win.on('closed', () => {
    if (!parent.isDestroyed()) parent.off('focus', outside);
    drop();
  });
  win.webContents.on('did-fail-load', (_e, code) => log?.('main.secret_window_blank', { step: 'load', code }));
  win.webContents.on('render-process-gone', (_e, d) => log?.('main.secret_window_blank', { step: 'gone', code: String(d.reason).slice(0, 20) }));
  win.webContents.on('unresponsive', () => log?.('main.secret_window_blank', { step: 'unresponsive' }));
  return win;
}

function centerOn(parent: BrowserWindow, w: number, h: number): { x?: number; y?: number } {
  if (parent.isDestroyed()) return {};
  const b = parent.getBounds();
  return { x: Math.round(b.x + (b.width - w) / 2), y: Math.round(b.y + Math.max(40, (b.height - h) / 3)) };
}
