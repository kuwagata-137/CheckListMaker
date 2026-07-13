'use strict';
// 1-1 マイグレーションの統合テスト（最重要）。
// index.html を jsdom で起動し、本物の storage.js をバックエンドにして
// localStorage → ファイル保存への移行を通しで確認する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, createMainStorage, waitFor, PX_JPEG } = require('./harness');

const STORAGE_KEY = 'checklistmaker.v1';
const MIGRATED_KEY = STORAGE_KEY + '.migratedToFile';

const legacyState = () => ({
  checklists: [{
    id: 'c1', title: '移行テスト', type: 'template', createdAt: 1, updatedAt: 1,
    sections: [{ id: 's1', title: '', items: [
      { id: 'i1', text: '手順1', done: false, note: '', time: '', body: '',
        images: [PX_JPEG], imageEdits: [{ v: 1, base: PX_JPEG, strokes: '', objects: [] }] },
    ] }],
  }],
  settings: { theme: 'auto' },
});

test('migration — localStorage からファイル保存への移行', async (t) => {
  const st = createMainStorage();
  t.after(() => st.cleanup());

  await t.test('初回起動 — 旧データが参照化されてファイルへ移行される', async () => {
    const app = bootApp({ storage: st, localStorage: { [STORAGE_KEY]: JSON.stringify(legacyState()) } });
    try {
      await app.api();
      const loaded = await waitFor(async () => {
        const r = await st.ipc('storage:load');
        return r.json ? r : null;
      }, { label: '移行ファイルの作成' });
      const item = JSON.parse(loaded.json).checklists[0].sections[0].items[0];
      assert.match(item.images[0], /^img:[0-9a-f-]{36}\.jpg$/, '画像が参照化される');
      assert.match(item.imageEdits[0].base, /^img:/, 'imageEdits.base も参照化される');
      assert.ok(app.window.localStorage.getItem(MIGRATED_KEY), '完了マーカーが書かれる');
      assert.ok(app.window.localStorage.getItem(STORAGE_KEY), '旧データは切り戻し用に残る');
      assert.equal(fs.readdirSync(st.imageDir).length, 2, '画像ファイルは2つ（images と base）');
    } finally {
      app.close();
    }
  });

  await t.test('2回目起動 — ファイルから復元されサムネイル参照が解決される', async () => {
    const app = bootApp({ storage: st });
    try {
      const api = await app.api();
      assert.equal(api.store.state.checklists[0].title, '移行テスト');
      assert.ok(app.document.querySelector('.card'), 'ホームにカードが描画される');
      app.window.location.hash = '#/c/c1';
      const thumb = await waitFor(
        () => app.document.querySelector('img.thumb'),
        { label: 'エディタのサムネイル' }
      );
      assert.ok(thumb.getAttribute('data-img-ref'), 'サムネイルに参照属性が付く');
      await waitFor(() => thumb.src.startsWith('data:image/jpeg'), { label: '参照の dataURL 解決' });
    } finally {
      app.close();
    }
  });

  await t.test('マーカーがあれば旧データが残っていても再移行しない', async () => {
    // 状態ファイルを消して「ファイル未作成・マーカーあり」の状況を作る
    fs.rmSync(path.join(st.dataDir, 'checklists.json'), { force: true });
    fs.rmSync(path.join(st.dataDir, 'checklists.json.bak'), { force: true });
    const app = bootApp({
      storage: st,
      localStorage: {
        [STORAGE_KEY]: JSON.stringify(legacyState()),
        [MIGRATED_KEY]: '2026-01-01T00:00:00.000Z',
      },
    });
    try {
      const api = await app.api();
      assert.equal(api.store.state.checklists.length, 0, '空の状態で開始する（再移行しない）');
    } finally {
      app.close();
    }
  });
});

test('migration — ブラウザモードは従来どおり（無改修互換）', async (t) => {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(legacyState()) } });
  t.after(() => app.close());
  const api = await app.api();

  assert.equal(api.store.state.checklists[0].title, '移行テスト', 'localStorage から復元される');
  assert.ok(app.document.querySelector('.card'), 'ホームが描画される');
  assert.equal(app.window.localStorage.getItem(MIGRATED_KEY), null, '移行マーカーは書かれない');

  app.window.location.hash = '#/c/c1';
  const thumb = await waitFor(() => app.document.querySelector('img.thumb'), { label: 'サムネイル' });
  assert.ok(thumb.src.startsWith('data:image/jpeg'), 'dataURL 直持ちのまま表示される');
  assert.equal(thumb.getAttribute('data-img-ref'), null, '参照属性は付かない（素通し）');
});
