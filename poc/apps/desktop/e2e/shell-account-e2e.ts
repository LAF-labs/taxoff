import './os-guard.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, nativeTheme } from 'electron';
import { Egress } from '@sax/net';
import { cloudPorts } from '../dist/remote-cloud.js';
import { serveAccount } from './fake-account-http.js';
import { fakeAccount, softKeys } from './fake-account.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

registerShellSchemes();
if (process.env.SAX_E2E_THEME === 'light' || process.env.SAX_E2E_THEME === 'dark') nativeTheme.themeSource = process.env.SAX_E2E_THEME;
const USER_DATA = path.join(app.getPath('temp'), `sax-e2e-acct-${process.pid}`);
app.setPath('userData', USER_DATA);
process.once('exit', () => rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
let S: Shell | undefined;
const js = <T = unknown>(code: string): Promise<T> => S!.win.webContents.executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}
async function press(sel: string) {
  S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
  await sleep(30);
  const ok = await js<boolean>(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no button ${sel}`);
}
async function typeKeys(sel: string, text: string) {
  await js(`document.querySelector(${JSON.stringify(sel)}).focus()`);
  for (const ch of text) {
    S!.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
    S!.win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    S!.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await sleep(40);
  }
}
const type = (sel: string, v: string) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); })()`);
const screen = () => js<string | null>(`document.querySelector('[data-acct-screen]')?.dataset.acctScreen ?? null`);
async function shot(name: string) {
  const dir = process.env.SAX_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await sleep(120);
  writeFileSync(path.join(dir, `${name}.png`), (await S!.win.webContents.capturePage()).toPNG());
}
const loginStep = () => js<string | null>(`document.querySelector('[data-account-login]')?.dataset.accountLogin ?? null`);
const callErr = (m: string, p: unknown) => js<string>(`window.sax.call(${JSON.stringify(m)}, ${JSON.stringify(p)}).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);

async function main() {
  const acct = fakeAccount();
  const keys = softKeys();
  const front = await serveAccount(acct.client);
  const egress = new Egress({ cloudDevLocal: true });
  const cloud = cloudPorts({ egress, env: 'dev', dev: { accountOrigin: front.origin, relayHost: '127.0.0.1:9' } });
  S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, remote: { cloud, keys: async () => keys } });
  S.win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.log(`  [renderer] ${e.message}`);
  });
  await S.ready;
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1');

  await sleep(3_100);
  check('코드 보내기는 실제 입력 뒤에만', (await callErr('account.sendCode', { email: 'a@gyeonbon-test.example' })) === 'gesture_required');

  await js(`document.querySelector('#rail [data-view="settings"]').click()`);
  await until('settings', async () => js<boolean>(`!!document.querySelector('[data-set-tab=devices]')`));
  await js(`document.querySelector('[data-set-tab=devices]').click()`);
  check('설정 > 기기 연결: 로그인 전', await until('account card', async () => js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_out'`)));
  await press('[data-act=account-login]');
  check('로그인 화면(이메일): 전체 화면', await until('login email', async () => (await screen()) === 'email' && (await loginStep()) === 'signed_out'));
  check('화면이 열리면 앱 틀은 inert', await js<boolean>(`document.querySelector('#app').inert === true`));
  await shot('a01-email');
  check('패스키 버튼은 데스크톱 패스키가 되기 전까지 없다(명세 §8 G7)', !(await js<boolean>(`!!document.querySelector('[data-act=account-passkey]')`)));
  check('비밀번호 칸, [비밀번호 찾기], [계정 만들기]가 없다(ADR-061 결정 1)', !(await js<boolean>(`!!document.querySelector('input[type=password], [data-act=account-reset], [data-act=account-signup], [data-act=account-password]')`)));
  check('제목 "이메일로 시작해요", 단추 [숫자 받기](승인 시안)', await js<boolean>(`document.querySelector('#acct-title').textContent === '이메일로 시작해요' && document.querySelector('[data-act=account-send]').textContent === '숫자 받기'`));
  await type('.acct-email', 'bad');
  await press('[data-act=account-send]');
  check('이메일 모양 오류 문구(서버 부르지 않음)', await until('email err', async () => js<boolean>(`document.querySelector('.acct-err')?.textContent.includes('이메일 형식') === true`)) && acct.calls.length === 0);
  await type('.acct-email', 'owner@gyeonbon-test.example');
  await press('[data-act=account-send]');
  check('[숫자 받기] → 숫자 6자리 화면(받는 주소 표시)', await until('code', async () => (await screen()) === 'code' && (await loginStep()) === 'code_sent' && (await js<string>(`document.querySelector('[data-acct-to]').textContent`)) === 'owner@gyeonbon-test.example' && (await js<string>(`document.querySelector('#acct-title').textContent`)) === '메일로 온 숫자 6자리'));
  check('남은 시간 m:ss', /^\d+:\d\d$/.test(await js<string>(`document.querySelector('[data-acct-left]')?.textContent ?? ''`)));
  await type('.acct-code', '48');
  check('칸 여섯 개에 넣은 숫자', (await js<string>(`[...document.querySelectorAll('.acct-cell')].map((c) => c.textContent).join('')`)) === '48');
  await shot('a01-code');
  await type('.acct-code', '');
  await press('.acct-code');
  await sleep(5_000);
  await typeKeys('.acct-code', '000000');
  check('틀린 코드 문구, 코드 화면 유지, 칸 비움(클릭 5초 뒤 키로 친 6자리도 서버 확인까지 간다)', await until('wrong', async () => (await screen()) === 'code' && js<boolean>(`document.querySelector('.acct-err')?.textContent.includes('숫자가 맞지 않아요') === true && document.querySelector('.acct-code').value === ''`)));
  await press('[data-act=account-back]');
  check('[뒤로] → 이메일 화면', await until('back email', async () => (await screen()) === 'email' && (await loginStep()) === 'signed_out'));
  await press('[data-act=account-send]');
  await until('code again', async () => (await screen()) === 'code');
  check('[확인]은 코드 칸 바로 아래, 6자리 전에는 꺼져 있다', await js<boolean>(`(() => { const b = document.querySelector('[data-act=account-verify]'); return !!b && b.disabled && document.querySelector('.acct-code-box').nextElementSibling === b; })()`));
  await press('.acct-code');
  await sleep(5_000);
  await type('.acct-code', '123456');
  check(
    '입력을 못 본 6자리 → "[확인]을 눌러 주세요", 코드는 칸에 남고 [확인]이 켜진다(서버로 가지 않음)',
    await until('confirm click', async () => js<boolean>(`document.querySelector('.acct-err')?.textContent.includes('[확인]을 눌러 주세요') === true && document.querySelector('.acct-code').value === '123456' && !document.querySelector('[data-act=account-verify]').disabled`)),
  );
  check('"버튼을 다시 눌러 주세요"는 코드 화면에 뜨지 않는다', !(await js<string>(`document.querySelector('[data-acct-screen]').textContent`)).includes('버튼을 다시 눌러 주세요'));
  await press('[data-act=account-verify]');
  check('[확인] 클릭 → 확인 → 등록 끝: 화면이 닫히고 계정 줄에 이메일', await until('signed in', async () => (await loginStep()) === null && js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_in' && document.querySelector('[data-account-email]').textContent === 'owner@gyeonbon-test.example'`)));
  check('계정 호출 순서(코드 → 확인 → 코드 → 확인 → 목록 → AIK 고정 → 로그아웃)', JSON.stringify(acct.calls) === JSON.stringify(['code', 'verify', 'code', 'verify', 'list', 'aik', 'logout']), acct.calls);
  check(
    '계정 호출은 제품 클라이언트·제품 Egress 허용 목록을 지나 앞단에 닿았다(#224 결함 재발 방지)',
    front.hits.includes('POST /v1/auth/code/verify') && egress.audit.some((x) => x.dest === 'cloud' && x.path === 'auth.verify' && x.status === 200) && egress.audit.every((x) => x.dest === 'cloud') && JSON.stringify(egress.audit).indexOf('gyeonbon') < 0,
    { hits: front.hits, audit: egress.audit },
  );
  const idFile = path.join(S.fixture!.root, 'userData', 'remote-identity.json');
  const found = existsSync(idFile) ? idFile : null;
  const raw = found ? readFileSync(found, 'utf8') : '';
  check('신원 파일: 고정한 deviceId, 세션 없음', !!found && JSON.parse(raw).deviceId === acct.pinned()?.deviceId && !raw.includes('sxs1'), found);
  check('렌더러에 세션·토큰 없음', !(await js<string>(`document.body.innerHTML`)).includes('sxs1'));
  check('로그인한 뒤에는 코드 보내기를 받지 않는다', (await (async () => (S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 }), await sleep(30), callErr('account.sendCode', { email: 'x@gyeonbon-test.example' })))()) === 'account_signed_in');
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await S?.close().catch(() => {});
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok`);
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
