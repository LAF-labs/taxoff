import { BrowserWindow, session, type Session } from 'electron';
import { hardenSession, hardenWindow } from './harden.ts';

let pdfSession: Session | null = null;
function renderSession(): Session {
  if (pdfSession) return pdfSession;
  pdfSession = session.fromPartition('sax-pdf-render');
  pdfSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('data:') }));
  hardenSession(pdfSession);
  return pdfSession;
}

/** 우리 HTML 한 장을 PDF로. 창은 보이지 않고, 스크립트와 data: 밖 요청을 막는다. */
export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, session: renderSession() } });
  hardenWindow(w);
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return new Uint8Array(await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally {
    w.destroy();
  }
}

