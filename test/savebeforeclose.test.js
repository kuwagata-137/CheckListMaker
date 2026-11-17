'use strict';
// 窓を閉じる前・再読み込みの前の保存（v1.0.14・計画外。docs/spec-file-storage-migration.md「閉じる前と再読み込みの前の保存」）の試験。
// 手順名・メモ・本文などの欄は、change・focusout（欄を離れた時）に保存する作り。閉じる前と再読み込みの前に
// フォーカスを外して確定させ、ファイルへの書き込みが終わってから閉じる。
// main プロセス側（save-before-close.js）は、BrowserWindow の代わりの簡単な窓で確認する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { bootApp, createMainStorage, waitFor } = require('./harness');
const { flushRenderer, guardCloseUntilSaved, reloadAfterSave } = require('../save-before-close');

const STORAGE_KEY = 'checklistmaker.v1';
const seedState = () => ({
  checklists: [{
    id: 't1', title: '保存の確認', type: 'template', createdAt: 1, updatedAt: 1,
    sections: [{ id: 's1', title: '準備', items: [{ id: 'j1', text: '手順1', done: false, note: '', time: '', body: '<p>本文</p>', images: [] }] }],
  }],
  settings: { theme: 'auto' },
});
const firstItem = (state) => state.checklists[0].sections[0].items[0];

async function openChecklist(app) {
  app.window.location.hash = '#/c/t1';
  return waitFor(() => app.document.querySelector('#app [data-rb-edit]'), { label: '手順の本文' });
}

test('本文を編集したまま閉じる前の確定を呼ぶと、本文が手順書データに保存される（ブラウザ版）', async (t) => {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
  t.after(() => app.close());
  const api = await app.api();
  const editor = await openChecklist(app);
  editor.focus();
  editor.innerHTML = '<p>本文（PDF でも可）</p>';
  assert.doesNotMatch(firstItem(api.store.state).body, /PDF/, 'フォーカスがあるうちは、まだ保存されていない');
  assert.equal(typeof app.window.clmFlushBeforeUnload, 'function');
  await app.window.clmFlushBeforeUnload();
  assert.match(firstItem(api.store.state).body, /PDF でも可/);
  assert.match(app.window.localStorage.getItem(STORAGE_KEY), /PDF でも可/);
});

// 手順名・メモの欄（change で保存）は、jsdom がプログラムで入れた値では change を発火しないため、
// 実物の Electron で確認する（入力した後にフォーカスを外すと change が発火する）。

test('閉じる前の確定は、フォーカスがある欄からフォーカスを外す', async (t) => {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
  t.after(() => app.close());
  await app.api();
  await openChecklist(app);
  const input = await waitFor(() => app.document.querySelector('#app [data-action="edit-item"]'), { label: '手順名の欄' });
  input.focus();
  assert.equal(app.document.activeElement, input);
  await app.window.clmFlushBeforeUnload();
  assert.notEqual(app.document.activeElement, input);
});

test('beforeunload でもフォーカスを外し、本文を保存する（ブラウザ版・単体 HTML）', async (t) => {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
  t.after(() => app.close());
  const api = await app.api();
  const editor = await openChecklist(app);
  editor.focus();
  editor.innerHTML = '<p>本文（読み直し前）</p>';
  app.window.dispatchEvent(new app.window.Event('beforeunload'));
  assert.match(firstItem(api.store.state).body, /読み直し前/);
});

test('Electron 版: 閉じる前の確定は、ファイルへの書き込みが終わるまで待つ', async (t) => {
  const storage = createMainStorage();
  t.after(() => storage.cleanup());
  fs.mkdirSync(storage.dataDir, { recursive: true });
  fs.writeFileSync(path.join(storage.dataDir, 'checklists.json'), JSON.stringify(seedState()));
  const app = bootApp({ storage });
  t.after(() => app.close());
  await app.api();
  const editor = await openChecklist(app);
  editor.focus();
  editor.innerHTML = '<p>本文（PDF でも可）</p>';
  await app.window.clmFlushBeforeUnload();
  const saved = JSON.parse(fs.readFileSync(path.join(storage.dataDir, 'checklists.json'), 'utf8'));
  assert.match(firstItem(saved).body, /PDF でも可/);
});

// ---- main プロセス側（save-before-close.js）----
// BrowserWindow の代わり。close() は 'close' を発火し、止められなければ閉じる（Electron と同じ）。
function fakeWindow(flush) {
  const win = new EventEmitter();
  let destroyed = false;
  win.closeCalls = 0;
  win.scripts = [];
  win.isDestroyed = () => destroyed;
  win.webContents = {
    executeJavaScript: (code) => { win.scripts.push(code); return flush(); },
    reload: () => {},
    reloadIgnoringCache: () => {},
  };
  win.close = () => {
    win.closeCalls++;
    let prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });
    if (!prevented) destroyed = true;
  };
  return win;
}

test('閉じる操作を一度止め、ページ側の確定が終わってから閉じる', async () => {
  let done;
  const win = fakeWindow(() => new Promise((r) => { done = r; }));
  guardCloseUntilSaved(win);
  win.close();
  assert.equal(win.isDestroyed(), false, '確定が終わるまでは閉じない');
  await waitFor(() => win.scripts.length === 1, { label: 'ページ側の確定を呼ぶ' });
  assert.match(win.scripts[0], /clmFlushBeforeUnload/);
  win.close(); // 確定の途中でもう一度閉じても、確定は 1 回だけ
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(win.scripts.length, 1);
  assert.equal(win.isDestroyed(), false);
  done(true);
  await waitFor(() => win.isDestroyed(), { label: '確定の後に閉じる' });
  assert.equal(win.closeCalls, 3);
});

test('ページ側が応答しない時は、待ち時間を過ぎたら閉じる', async () => {
  const win = fakeWindow(() => new Promise(() => {}));
  guardCloseUntilSaved(win, { timeoutMs: 30 });
  win.close();
  await waitFor(() => win.isDestroyed(), { label: '待ち時間の後に閉じる' });
});

test('ページ側の確定で例外が起きても閉じる', async () => {
  const win = fakeWindow(() => Promise.reject(new Error('確定に失敗')));
  guardCloseUntilSaved(win);
  win.close();
  await waitFor(() => win.isDestroyed(), { label: '例外の後に閉じる' });
});

test('再読み込みは、ページ側の確定が終わってから読み直す', async () => {
  const order = [];
  const win = fakeWindow(() => { order.push('確定'); return Promise.resolve(true); });
  win.webContents.reload = () => order.push('再読み込み');
  win.webContents.reloadIgnoringCache = () => order.push('強制的に再読み込み');
  await reloadAfterSave(win, false);
  await reloadAfterSave(win, true);
  assert.deepEqual(order, ['確定', '再読み込み', '確定', '強制的に再読み込み']);
});

test('窓が無い時・閉じた後は何もしない', async () => {
  await reloadAfterSave(null, false);
  assert.equal(await flushRenderer(null), false);
  const win = fakeWindow(() => Promise.resolve(true));
  win.close = () => {};
  win.isDestroyed = () => true;
  assert.equal(await flushRenderer(win), false);
});
