// 복구 코드 금고 창. 코드는 금고와 이 창 사이 포트로만 오가고 main과 본체 렌더러는 보지 못한다.
const mode = document.body.dataset.mode;
let port = null;
let seq = 0;
const waiting = new Map();
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    port.postMessage({ t: 'rpc', id, method, params });
  });

window.addEventListener('message', (ev) => {
  if (ev.data !== 'vault-secret-port' || !ev.ports[0]) return;
  port = ev.ports[0];
  port.onmessage = ({ data }) => {
    const done = waiting.get(data?.id);
    waiting.delete(data?.id);
    done?.(data?.error ? { error: data.error } : data?.result);
  };
  if (mode === 'show') void show();
  else document.querySelector('#cells input')?.focus();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.isComposing) window.close();
});

async function show() {
  const r = await rpc('recovery.show', {});
  const box = document.getElementById('code');
  if (!r?.groups) return window.close();
  box.replaceChildren(...r.groups.map((g) => Object.assign(document.createElement('span'), { textContent: g })));
  const btn = document.getElementById('done');
  btn.disabled = false;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await rpc('recovery.done', {});
    box.replaceChildren();
    window.close();
  });
}

if (mode === 'enter') {
  const cells = document.getElementById('cells');
  const open = document.getElementById('open');
  const msg = document.getElementById('msg');
  const inputs = Array.from({ length: 6 }, (_, i) => {
    const el = document.createElement('input');
    Object.assign(el, { maxLength: 4, autocomplete: 'off', spellcheck: false });
    el.setAttribute('aria-label', `${i + 1}번째 묶음`);
    cells.append(el);
    return el;
  });
  const clean = (s) => s.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const full = () => inputs.map((x) => clean(x.value)).join('');
  const sync = () => (open.disabled = full().length !== 24);
  inputs.forEach((el, i) => {
    el.addEventListener('input', () => {
      const v = clean(el.value);
      if (v.length > 4) {
        const all = (inputs.slice(0, i).map((x) => clean(x.value)).join('') + v).slice(0, 24);
        inputs.forEach((x, j) => (x.value = all.slice(j * 4, j * 4 + 4)));
        inputs[Math.min(5, Math.floor(all.length / 4))].focus();
      } else {
        el.value = v;
        if (v.length === 4 && i < 5) inputs[i + 1].focus();
      }
      sync();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !el.value && i > 0) inputs[i - 1].focus();
    });
  });
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (open.disabled || !port) return;
    open.disabled = true;
    const r = await rpc('recovery.enter', { code: full() });
    if (r?.ok) {
      inputs.forEach((x) => (x.value = ''));
      return window.close();
    }
    msg.textContent = r?.reason === 'paused' ? '여러 번 틀려서 1시간 동안 막혔어요' : r?.error === 'expired' ? '시간이 지났어요. 창을 닫고 다시 해 주세요' : '코드가 맞지 않아요';
    sync();
  });
}
