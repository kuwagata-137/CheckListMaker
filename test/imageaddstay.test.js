'use strict';
// 画像を手順／項目に足したあと、画像編集を開かずに一覧の画面のままにする（v1.0.11）。
// クリップボードからの貼り付け・エクスプローラーからのドロップ・「🖼 画像」ボタンのどれでも同じ。
// テンプレート型と ToDo 型の両方で確かめる。サムネイルのクリックで画像編集が開くことは
// test/imagednd.test.js が確かめている（「.modal.img-editor」）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor } = require('./harness');

const STORAGE_KEY = 'checklistmaker.v1';
const item = (id, text) => ({ id, text, done: false, note: '', time: '', body: '', images: [] });
const state = (type) => ({
  checklists: [{
    id: 'c1', title: '画像の追加', type, createdAt: 1, updatedAt: 1,
    sections: [{ id: 's1', title: '', items: [item('i1', '手順1'), item('i2', '手順2')] }],
  }],
  settings: { theme: 'auto' },
});

// jsdom には画像のデコードと canvas が無い。compressImage が通るよう、読み込みは即 onload、
// canvas は何もしないスタブにする（保存される中身は検証しない）。
function stubImagePipeline(win) {
  win.Image = class {
    constructor() { this.naturalWidth = 40; this.naturalHeight = 30; }
    set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
    get src() { return this._src; }
  };
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  win.HTMLCanvasElement.prototype.getContext = () => ctx;
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,AAAA';
}

async function openEditor(t, type) {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(state(type)) } });
  t.after(() => app.close());
  const api = await app.api();
  stubImagePipeline(app.window);
  app.window.location.hash = '#/c/c1';
  await waitFor(() => app.document.querySelector('#app .item[data-item="i2"]'), { label: '編集画面' });
  const win = app.window;
  const doc = app.document;
  const images = (id) => api.store.state.checklists[0].sections[0].items.find((x) => x.id === id).images;
  const pngFile = () => new win.File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  return { app, api, win, doc, images, pngFile };
}

for (const type of ['template', 'todo']) {
  test(`画像を足しても一覧の画面のまま（${type === 'todo' ? 'ToDo' : 'テンプレート'}型）`, async (t) => {
    await t.test('クリップボードから貼り付け: 画像が付き、編集画面は開かず、文字欄のフォーカスが戻る', async (tt) => {
      const { win, doc, images, pngFile } = await openEditor(tt, type);
      const ta = doc.querySelector('#app .item[data-item="i2"] .item-text');
      ta.focus();
      ta.setSelectionRange(2, 2);
      const file = pngFile();
      const ev = new win.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', {
        value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
      });
      ta.dispatchEvent(ev);
      assert.equal(ev.defaultPrevented, true, '画像の貼り付けとして受け取る');
      await waitFor(() => images('i2').length === 1, { label: '画像が付く' });
      assert.equal(doc.querySelector('.img-editor'), null, '画像編集は開かない');
      assert.equal(win.location.hash, '#/c/c1', '一覧の画面のまま');
      assert.ok(doc.querySelector('#app .item[data-item="i2"] img.thumb'), '一覧に画像が出る');
      const now = doc.activeElement;
      assert.ok(now.matches('#app .item[data-item="i2"] .item-text'), '同じ手順の文字欄にフォーカスが戻る');
      assert.equal(now.selectionStart, 2, 'カーソル位置も戻る');
    });

    await t.test('エクスプローラーから1枚ドロップ: 画像が付き、編集画面は開かない', async (tt) => {
      const { win, doc, images, pngFile } = await openEditor(tt, type);
      const row = doc.querySelector('#app .item[data-item="i1"]');
      const file = pngFile();
      const ev = new win.Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
      row.dispatchEvent(ev);
      await waitFor(() => images('i1').length === 1, { label: '画像が付く' });
      assert.equal(doc.querySelector('.img-editor'), null, '画像編集は開かない');
    });
  });
}
