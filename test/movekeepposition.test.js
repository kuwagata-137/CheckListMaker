'use strict';
// ↑↓ で順番を入れ替えた手順を、画面上の同じ位置に残す（v1.0.12）。
// 仕様は docs/spec-move-item-keep-position.md。jsdom にはレイアウトが無いので、
// getBoundingClientRect と scrollBy を差し替えて「差の分だけスクロールし直す」配線を確かめる。
// 実際の見た目（Electron 31・編集ズーム）は実機で確認する。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor } = require('./harness');

const STORAGE_KEY = 'checklistmaker.v1';
const plain = (v) => JSON.parse(JSON.stringify(v)); // jsdom 側の配列・オブジェクトを素の値にする
const item = (id, text) => ({ id, text, done: false, note: '', time: '', body: '', images: [] });
const state = (type) => ({
  checklists: [{
    id: 'c1', title: '並べ替え', type, createdAt: 1, updatedAt: 1,
    sections: [{ id: 's1', title: '', items: [item('i1', '手順1'), item('i2', '手順2'), item('i3', '手順3')] }],
  }],
  settings: { theme: 'auto' },
});

test('keepPositionScrollDelta — 描き直しの前後の差を画面 px にする', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  assert.equal(T.keepPositionScrollDelta(300, 180, 1, 1), -120, '上へ 120px 動いたら 120px 上へスクロール');
  assert.equal(T.keepPositionScrollDelta(300, 420, 1, 1), 120);
  // Electron 31（M128 より前）は zoom の中の値が内部 px（unit=1）。画面 px にするには zoom を掛ける
  assert.equal(T.keepPositionScrollDelta(300, 200, 1, 0.8), -80);
  // M128 以降は値が画面 px（unit=zoom）。unit で割ってから zoom を掛けるので、そのままの差になる
  assert.equal(T.keepPositionScrollDelta(240, 160, 0.8, 0.8), -80);
  assert.equal(T.keepPositionScrollDelta(null, 100, 1, 1), 0, '測れなければ動かさない');
  assert.equal(T.keepPositionScrollDelta(100, undefined, 1, 1), 0);
  assert.equal(T.keepPositionScrollDelta(100, 160, 0, NaN), 60, '壊れた unit・zoom は 1 とみなす');
});

for (const type of ['template', 'todo']) {
  test(`↑↓ のあと、動かした手順の行の高さの差だけスクロールし直す（${type === 'todo' ? 'ToDo' : 'テンプレート'}型）`, async (t) => {
    const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(state(type)) } });
    t.after(() => app.close());
    const api = await app.api();
    const win = app.window;
    const doc = app.document;
    win.location.hash = '#/c/c1';
    await waitFor(() => doc.querySelector('#app .item[data-item="i3"]'), { label: '編集画面' });

    // 行の上端＝並び順 × 100px（画像入りなどで高さが違っても、測った差だけ戻すことを見る）。
    // 物差し（高さ 100px の div）は高さ 100 を返す＝ unit 1。
    const heights = { i1: 100, i2: 260, i3: 100 };
    const seenTransforms = [];
    win.Element.prototype.getBoundingClientRect = function () {
      if (this.style && this.style.height === '100px') return { top: 0, bottom: 100, height: 100, width: 10, left: 0, right: 10 };
      const id = this.dataset && this.dataset.item;
      if (!id || !this.classList.contains('item')) return { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 };
      seenTransforms.push(this.style.transform);
      const order = [...doc.querySelectorAll('#app .item')].map((el) => el.dataset.item);
      let top = 0;
      for (const x of order) { if (x === id) break; top += heights[x]; }
      return { top, bottom: top + heights[id], height: heights[id], width: 100, left: 0, right: 100 };
    };
    const scrolls = [];
    win.scrollBy = (opt) => { scrolls.push(opt); };
    const press = (id, action) => {
      const btn = doc.querySelector(`#app .item[data-item="${id}"] [data-action="${action}"]`);
      btn.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    };
    const order = () => plain(api.store.state.checklists[0].sections[0].items.map((x) => x.id));

    press('i3', 'move-item-up'); // i3 の上端は 360 → i2（260px）の上へ入って 100
    assert.deepEqual(order(), ['i1', 'i3', 'i2']);
    assert.deepEqual(plain(scrolls.at(-1)), { top: -260, behavior: 'instant' });
    press('i3', 'move-item-up'); // 100 → 0
    assert.deepEqual(order(), ['i3', 'i1', 'i2']);
    assert.deepEqual(plain(scrolls.at(-1)), { top: -100, behavior: 'instant' });
    press('i3', 'move-item-down'); // 0 → 100
    assert.deepEqual(order(), ['i1', 'i3', 'i2']);
    assert.deepEqual(plain(scrolls.at(-1)), { top: 100, behavior: 'instant' });
    const n = scrolls.length;
    press('i1', 'move-item-up'); // 先頭の ↑ は何もしない
    assert.equal(scrolls.length, n, '動かないときはスクロールもしない');

    assert.ok(seenTransforms.length >= 6 && seenTransforms.every((v) => v === 'none'), 'ホバーの浮きを外して測る');
    doc.querySelectorAll('#app .item').forEach((el) => assert.equal(el.style.transform, '', '測った後は元に戻す'));
  });
}

test('↑↓ を続けて押しても、端数がたまって少しずつずれない（同じ手順は最初の高さへ戻す）', async (t) => {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify({
    checklists: [{ id: 'c1', title: '並べ替え', type: 'template', createdAt: 1, updatedAt: 1,
      sections: [{ id: 's1', title: '', items: Array.from({ length: 8 }, (_, i) => item('i' + (i + 1), '手順' + (i + 1))) }] }],
    settings: { theme: 'auto' },
  }) } });
  t.after(() => app.close());
  await app.api();
  const win = app.window;
  const doc = app.document;
  win.location.hash = '#/c/c1';
  await waitFor(() => doc.querySelector('#app .item[data-item="i8"]'), { label: '編集画面' });
  // 行の高さに端数がある（100.4px）。スクロール量は Chromium と同じく整数に丸める（0 方向へ切り捨て）。
  let scrollY = 1000;
  win.Element.prototype.getBoundingClientRect = function () {
    if (this.style && this.style.height === '100px') return { top: 0, bottom: 100, height: 100, width: 10, left: 0, right: 10 };
    const id = this.dataset && this.dataset.item;
    if (!id || !this.classList.contains('item')) return { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 };
    const idx = [...doc.querySelectorAll('#app .item')].findIndex((el) => el.dataset.item === id);
    const top = idx * 100.4 - scrollY;
    return { top, bottom: top + 100.4, height: 100.4, width: 100, left: 0, right: 100 };
  };
  win.scrollBy = (opt) => { scrollY += Math.trunc(opt.top); };
  const topOf = (id) => doc.querySelector(`#app .item[data-item="${id}"]`).getBoundingClientRect().top;
  const first = topOf('i8');
  for (let k = 0; k < 6; k++) {
    doc.querySelector('#app .item[data-item="i8"] [data-action="move-item-up"]')
      .dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    assert.ok(Math.abs(topOf('i8') - first) <= 0.5, `${k + 1}回目: ${topOf('i8')} は最初の ${first} から 0.5px 以内`);
  }
});

test('取り込みウィザードの ↑↓ も、動かした行を一覧の同じ高さに残す', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const win = app.window;
  const doc = app.document;
  win.fileAPI = { readPickedImage: () => Promise.resolve(null) };
  const files = ['a', 'b', 'c', 'd'].map((n) => ({ path: `pics/${n}.png`, name: `${n}.png` }));
  T.openImportWizard(T.makeFilesSource(files));
  await waitFor(() => doc.querySelectorAll('.modal.import-wiz .iw-row').length === 4, { label: 'ウィザード' });
  const list = doc.querySelector('.modal.import-wiz .iw-list');
  // 行の上端＝ 並び順 × 96px − 一覧の scrollTop（行の高さは一定）
  win.Element.prototype.getBoundingClientRect = function () {
    if (!this.classList || !this.classList.contains('iw-row')) return { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 };
    const top = Number(this.dataset.i) * 96 - list.scrollTop;
    return { top, bottom: top + 88, height: 88, width: 400, left: 0, right: 400 };
  };
  list.scrollTop = 0;
  const name = (i) => doc.querySelector(`.modal.import-wiz .iw-row[data-i="${i}"] .iw-name`).textContent;
  const press = (i, op) => doc.querySelector(`.modal.import-wiz .iw-row[data-i="${i}"] [data-iw="${op}"]`).click();
  press(1, 'down'); // b を下へ（1→2）
  assert.equal(name(2), 'b.png');
  assert.equal(list.scrollTop, 96, '1行ぶん下へスクロールし、b が同じ高さに残る');
  press(2, 'up'); // b を上へ戻す（2→1）
  assert.equal(name(1), 'b.png');
  assert.equal(list.scrollTop, 0);
  press(1, 'del'); // ↑↓ 以外ではスクロールし直さない
  assert.equal(list.scrollTop, 0);
});
