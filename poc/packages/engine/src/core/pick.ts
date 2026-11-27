import { normalizeName } from './constants.ts';
import type { ElementRef } from './page.ts';
import { resolveTarget } from './resolve.ts';
import { isAbsent, isRef, readRef, scalar } from './scope.ts';
import { NEXT, waitTarget, type Outcome, type StepEnv } from './steps.ts';
import type { StepOf } from './types.ts';

const PICK_SELECT_WAIT_MS = 3_000;
const GONE_QUIET_MS = 300;

type PickResult = { ok: true; name: string } | { ok: false; code: string; none?: boolean };

const none = (code: string): PickResult => ({ ok: false, code, none: true });

/** 목록(key)에서 행 하나를 고르고 선택돼 있게 만든다. by는 값 참조($profile.certName 등) 또는 없음. */
export async function pickRow(env: StepEnv, key: string, o: { by?: string; use?: 'selected' }, timeoutMs: number): Promise<PickResult> {
  const entry = env.dict.entries[key];
  if (!entry?.rows) return { ok: false, code: 'step.selector_miss' };
  const t = await waitTarget(env, key, timeoutMs);
  if (!t.ok) return { ok: false, code: t.code };
  const { item, name, selected, button } = entry.rows;
  const css = (value: string) => ({ kind: 'css' as const, value });
  const deadline = env.clock.now() + timeoutMs;
  // 실화면 인증서 창은 저장 위치·드라이브를 고른 뒤 목록을 비동기로 다시 그린다(행 요소가 바뀌고 0번 행이 다시 골라진다).
  // 그래서 행은 요소가 아니라 이름으로 잇고, 고를 때와 확인할 때마다 지금 그려진 목록을 다시 읽는다.
  const readRows = async (): Promise<Array<{ el: ElementRef; name: string }>> => {
    const out: Array<{ el: ElementRef; name: string }> = [];
    for (const el of await env.page.query(css(item), entry.frame, t.t.el)) {
      const cell = (await env.page.query(css(name), entry.frame, el))[0];
      const n = cell ? normalizeName(await env.page.text(cell)) : '';
      if (n !== '') out.push({ el, name: n });
    }
    return out;
  };
  let rows: Array<{ el: ElementRef; name: string }>;
  for (;;) {
    rows = await readRows();
    if (rows.length > 0) break;
    if (env.stopRequested?.()) return { ok: false, code: 'run.stopped' };
    if (env.clock.now() >= deadline) return { ok: false, code: 'step.timeout' };
    await env.clock.sleep(Math.min(env.pollMs, Math.max(0, deadline - env.clock.now())));
  }
  if (button) {
    if (o.use === 'selected') return { ok: false, code: 'step.cond_unsupported' };
    const v = o.by && isRef(o.by) ? readRef(env.scope, o.by) : undefined;
    const want = isAbsent(v) ? null : scalar(v);
    if (want === null) return none('pick.name_absent');
    const hits = rows.flatMap((r, i) => (r.name === normalizeName(want) ? [i] : []));
    if (hits.length !== 1) return none(hits.length === 0 ? 'pick.no_match' : 'pick.ambiguous');
    if (!env.act.pickButton) return { ok: false, code: 'step.cond_unsupported' };
    const c = await env.act.pickButton(t.t, rows[hits[0]!]!.el);
    return c.ok ? { ok: true, name: rows[hits[0]!]!.name } : { ok: false, code: c.code };
  }
  if (!selected) return { ok: false, code: 'step.selector_miss' };
  const selectedName = async (): Promise<string | null> => {
    const sel = await env.page.query(css(selected), entry.frame, t.t.el);
    if (sel.length !== 1) return null;
    const cell = (await env.page.query(css(name), entry.frame, sel[0]!))[0];
    const n = cell ? normalizeName(await env.page.text(cell)) : '';
    return n === '' ? null : n;
  };
  let want: string;
  if (o.use === 'selected') {
    const n = await selectedName();
    if (n === null || !rows.some((r) => r.name === n)) return none('pick.none_selected');
    want = n;
  } else if (rows.length === 1) want = rows[0]!.name;
  else {
    const v = o.by && isRef(o.by) ? readRef(env.scope, o.by) : undefined;
    const w = isAbsent(v) ? null : scalar(v);
    if (w === null) return none('pick.name_absent');
    const hits = rows.filter((r) => r.name === normalizeName(w));
    if (hits.length !== 1) return none(hits.length === 0 ? 'pick.no_match' : 'pick.ambiguous');
    want = hits[0]!.name;
  }
  // 고른 행이 선택될 때까지: 지금 그려진 목록에서 그 이름의 행을 누른다. 목록이 다시 그려지면(누른 행이 사라짐) 새 목록에서 한 번 더 누른다.
  let clicked: ElementRef | null = null;
  let until = Math.min(deadline, env.clock.now() + PICK_SELECT_WAIT_MS);
  for (;;) {
    if ((await selectedName()) === want) break;
    const row = (await readRows()).find((r) => r.name === want)?.el;
    if (row && !(clicked && (await env.page.same(row, clicked)))) {
      if (!env.act.pickRow) return { ok: false, code: 'step.cond_unsupported' };
      const c = await env.act.pickRow(t.t, row);
      // identity_mismatch: 읽은 뒤 누르기 전에 목록이 다시 그려졌다. 새 목록을 다시 읽는다.
      if (!c.ok && c.code !== 'step.identity_mismatch') return { ok: false, code: c.code };
      if (c.ok) {
        clicked = row;
        until = Math.min(deadline, env.clock.now() + PICK_SELECT_WAIT_MS);
      }
    }
    if (env.stopRequested?.()) return { ok: false, code: 'run.stopped' };
    if (env.clock.now() >= until) return { ok: false, code: 'pick.not_selected' };
    await env.clock.sleep(Math.min(env.pollMs, Math.max(0, until - env.clock.now())));
  }
  return { ok: true, name: want };
}

/** pick 스텝(IR rev v1.3.6). 못 고르면 ifNone(없으면 실패), 고르면 remember 뒤 then 또는 다음 스텝. */
export async function pickStep(s: StepOf<'pick'>, env: StepEnv): Promise<Outcome> {
  const r = await pickRow(env, s.target, { ...(s.by !== undefined ? { by: s.by } : {}), ...(s.use ? { use: s.use } : {}) }, s.timeoutMs ?? env.defaultTimeoutMs);
  if (!r.ok) return r.none && s.ifNone ? { t: 'jump', to: s.ifNone } : { t: 'fail', code: r.code };
  if (s.remember) {
    await env.profileWrite?.(s.remember, r.name).catch(() => false);
    env.scope.profile = { ...env.scope.profile, [s.remember]: r.name };
  }
  return s.then ? { t: 'jump', to: s.then } : NEXT;
}

/**
 * wait for:'gone'(IR rev v1.3.6, v1.3.7에서 바꿈): 보이는 대상이 하나뿐일 때만 기다린다. 없거나 안 보이는 상태가 GONE_QUIET_MS 이어지면 통과.
 * v1.3.7(부장 2026-11-13): 보이는 것이 여럿이거나 timeoutMs까지 계속 보이면 실패하지 않고 지나간다(처리 표시는 다음 스텝을 막는 조건이 아니다).
 */
export async function waitGone(key: string, env: StepEnv, timeoutMs: number): Promise<Outcome> {
  if (!env.dict.entries[key]) return { t: 'fail', code: 'step.selector_miss' };
  const deadline = env.clock.now() + timeoutMs;
  let since: number | null = null;
  for (;;) {
    const r = await resolveTarget(env.page, env.dict, key);
    const now = env.clock.now();
    if (!r.ok && r.ambiguous) return NEXT;
    if (r.ok || r.code !== 'step.selector_miss') since = null;
    else if (since === null) since = now;
    if (since !== null && now - since >= GONE_QUIET_MS) return NEXT;
    if (env.stopRequested?.()) return { t: 'fail', code: 'run.stopped' };
    if (now >= deadline) return NEXT;
    await env.clock.sleep(Math.min(env.pollMs, Math.max(0, deadline - now)));
  }
}
