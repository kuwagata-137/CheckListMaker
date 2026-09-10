'use strict';
// 手順間の画像コピー D&D（docs/spec-dnd-image-copy-phase-move.md）の DOM 配線テスト。
// 純関数 copyItemImage は test/model.test.js が見ているので、ここでは
// 「サムネイルがドラッグソースとして生きているか」＝配線だけを確かめる。
// この形の不具合（純関数は正しいが別機能に配線を潰される）は純関数テストでは
// 原理的に検出できないため、独立したファイルとして置く。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, PX_JPEG } = require('./harness');

const STORAGE_KEY = 'checklistmaker.v1';

const state = () => ({
  checklists: [{
    id: 'c1', title: 'D&Dテスト', type: 'template', createdAt: 1, updatedAt: 1,
    sections: [{ id: 's1', title: '', items: [
      { id: 'i1', text: '手順1', done: false, note: '', time: '', body: '',
        images: [PX_JPEG], imageEdits: [null], imagesFull: [null] },
      { id: 'i2', text: '手順2', done: false, note: '', time: '', body: '',
        images: [], imageEdits: [], imagesFull: [] },
    ] }],
  }],
  settings: { theme: 'auto' },
});

// エディタ画面まで進めて、最初のサムネイルとコピー先の手順を返す
async function openEditor(t) {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(state()) } });
  t.after(() => app.close());
  const api = await app.api();
  app.window.location.hash = '#/c/c1';
  const thumb = await waitFor(() => app.document.querySelector('img.thumb'), { label: 'サムネイル' });
  return { app, api, thumb };
}

// jsdom には canvas の実装が無く getContext は null を返す。画像エディタは開いた直後に
// 2D コンテキストへ描き始めるので、「開いたかどうか」だけを見るために無害なスタブを差す。
// 描画結果は検証しない（画像編集の中身は test/imageeditor.test.js が純関数で見ている）。
function stubCanvas(win) {
  const ctx = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : () => ({ data: [], width: 0, height: 0 })),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  win.HTMLCanvasElement.prototype.getContext = () => ctx;
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
}

const imagesOf = (api, itemId) =>
  api.store.state.checklists[0].sections[0].items.find((x) => x.id === itemId).images;

test('画像コピー D&D — サムネイルの配線', async (t) => {
  await t.test('サムネイルの pointerdown は preventDefault されない', async (t) => {
    const { app, thumb } = await openEditor(t);
    const ev = new app.window.Event('pointerdown', { bubbles: true, cancelable: true });
    thumb.dispatchEvent(ev);
    assert.equal(
      ev.defaultPrevented, false,
      'preventDefault すると Chromium は互換 mousedown ごと抑止し、ネイティブ D&D が始まらない'
    );
  });

  await t.test('別の手順へドラッグすると画像がコピーされ、コピー元にも残る', async (t) => {
    const { app, api, thumb } = await openEditor(t);
    const win = app.window;
    const target = app.document.querySelector('.item[data-item="i2"]');
    assert.ok(target, 'コピー先の手順がある');

    thumb.dispatchEvent(new win.Event('dragstart', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new win.Event('dragover', { bubbles: true, cancelable: true }));
    assert.ok(target.classList.contains('drop-target'), 'ドロップ先がハイライトされる');
    target.dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));

    assert.equal(imagesOf(api, 'i2').length, 1, 'コピー先に1枚増える');
    assert.equal(imagesOf(api, 'i1').length, 1, 'コピー元は減らない');
    assert.equal(imagesOf(api, 'i2')[0], imagesOf(api, 'i1')[0], '実体は複製せず共有する');
    assert.equal(target.classList.contains('drop-target'), false, 'ハイライトは消える');
  });

  await t.test('同じ手順へのドロップは何も起こさない', async (t) => {
    const { app, api, thumb } = await openEditor(t);
    const win = app.window;
    const self = app.document.querySelector('.item[data-item="i1"]');

    thumb.dispatchEvent(new win.Event('dragstart', { bubbles: true, cancelable: true }));
    self.dispatchEvent(new win.Event('dragover', { bubbles: true, cancelable: true }));
    assert.equal(self.classList.contains('drop-target'), false, 'コピー元はハイライトしない');
    self.dispatchEvent(new win.Event('drop', { bubbles: true, cancelable: true }));

    assert.equal(imagesOf(api, 'i1').length, 1, '枚数は変わらない');
  });

  await t.test('サムネイルのクリックで画像エディタが開く', async (t) => {
    const { app, thumb } = await openEditor(t);
    stubCanvas(app.window);
    thumb.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await waitFor(() => app.document.querySelector('.modal.img-editor'), { label: '画像エディタ' });
  });
});
