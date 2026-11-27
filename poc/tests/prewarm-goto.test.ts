import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Page } from 'playwright-core';
import { PlaywrightActuator } from '../packages/engine/src/driver/actuator.ts';
import type { PlaywrightPageReader } from '../packages/engine/src/driver/reader.ts';

const FORM = 'https://hometax.go.kr/form';

function make(at: string, freshUrl?: string) {
  const went: string[] = [];
  let fresh = 0;
  const page = {
    url: () => at,
    goto: async (u: string) => {
      went.push(u);
      at = u;
    },
    waitForLoadState: async () => {},
  } as unknown as Page;
  const a = new PlaywrightActuator({ page, reader: { release: async () => {} } as unknown as PlaywrightPageReader, ...(freshUrl ? { freshUrl: { url: freshUrl, landed: freshUrl }, onFresh: () => fresh++ } : {}), afterNavigation: async () => ({ ok: true }) });
  return { a, went, fresh: () => fresh };
}

describe('미리 열어 둔 발급 화면: 첫 goto를 건너뛴다', () => {
  it('같은 URL에 그대로 있으면 다시 열지 않고, 두 번째부터는 연다', async () => {
    const h = make(FORM, FORM);
    assert.equal(h.a.willSkipGoto(FORM), true);
    assert.equal(h.a.willSkipGoto('https://hometax.go.kr/other'), false);
    assert.deepEqual(await h.a.goto(FORM), { ok: true });
    assert.deepEqual(h.went, []);
    assert.equal(h.fresh(), 1);
    await h.a.goto(FORM);
    assert.deepEqual(h.went, [FORM]);
    assert.equal(h.fresh(), 1);
  });

  it('페이지가 다른 곳에 있으면 연다', async () => {
    const h = make('https://hometax.go.kr/login', FORM);
    await h.a.goto(FORM);
    assert.deepEqual(h.went, [FORM]);
    assert.equal(h.fresh(), 0);
  });

  it('다른 URL로 먼저 이동하면 표식이 사라진다', async () => {
    const h = make(FORM, FORM);
    await h.a.goto('https://hometax.go.kr/other');
    await h.a.goto(FORM);
    assert.deepEqual(h.went, ['https://hometax.go.kr/other', FORM]);
  });

  it('표식이 없으면 늘 연다', async () => {
    const h = make(FORM);
    await h.a.goto(FORM);
    assert.deepEqual(h.went, [FORM]);
  });
});
