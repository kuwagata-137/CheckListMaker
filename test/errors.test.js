'use strict';
// エラー可視化（1-3）のレンダラー統合テスト。
// グローバルエラーの捕捉 → ログAPI、保存失敗 → トースト通知を確認する。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor } = require('./harness');

test('errors — グローバルエラーがローカルログへ届く', async (t) => {
  const logs = [];
  const app = bootApp({ logs });
  t.after(() => app.close());
  await app.api();
  const before = logs.length; // 起動中のログが混ざっても差分で数える

  const w = app.window;
  w.dispatchEvent(new w.ErrorEvent('error', {
    message: 'boom', filename: 'app.js', lineno: 12, colno: 3, error: new w.Error('boom'),
  }));
  await waitFor(() => logs.length > before, { label: 'error イベントの記録' });
  const rec = logs[logs.length - 1];
  assert.equal(rec.kind, 'error');
  assert.equal(rec.message, 'boom');
  assert.equal(rec.extra, 'app.js:12:3');

  const ev = new w.Event('unhandledrejection');
  ev.reason = new w.Error('rejected');
  w.dispatchEvent(ev);
  await waitFor(() => logs.length > before + 1, { label: 'unhandledrejection の記録' });
  assert.equal(logs[logs.length - 1].kind, 'unhandledrejection');
  assert.equal(logs[logs.length - 1].message, 'rejected');
});

test('errors — ログは1セッション最大50件で打ち切る', async (t) => {
  const logs = [];
  const app = bootApp({ logs });
  t.after(() => app.close());
  await app.api();

  const w = app.window;
  for (let i = 0; i < 80; i++) {
    w.dispatchEvent(new w.ErrorEvent('error', { message: 'e' + i }));
  }
  assert.ok(logs.length <= 50, `記録は50件以下（実際: ${logs.length}）`);
});

test('errors — ファイル保存の失敗でトーストが出る（表示はスロットル）', async (t) => {
  // storage:save だけ失敗する Electron モードのスタブ
  const seed = JSON.stringify({ checklists: [], settings: { theme: 'auto' } });
  const failingStorage = {
    ipc: (ch) => {
      if (ch === 'storage:load') return Promise.resolve({ ok: true, json: seed });
      if (ch === 'storage:save') return Promise.resolve({ ok: false, error: 'ディスク書き込み拒否' });
      return Promise.resolve({ ok: false, error: 'unexpected: ' + ch });
    },
  };
  const app = bootApp({ storage: failingStorage });
  t.after(() => app.close());
  const api = await app.api();

  api.store.commit((s) => { s.settings.theme = 'dark'; });
  const toast = await waitFor(
    () => app.document.querySelector('.toast.error'),
    { label: '保存失敗トースト' }
  );
  assert.match(toast.textContent, /ファイル保存に失敗/);
  assert.match(toast.textContent, /ディスク書き込み拒否/);

  // 30秒スロットル: 続けて失敗してもトーストは増えない
  api.store.commit((s) => { s.settings.theme = 'auto'; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(app.document.querySelectorAll('.toast.error').length, 1, '連打されない');

  // force は必ず表示される
  api.notifySaveError('強制表示テスト', { force: true });
  assert.equal(app.document.querySelectorAll('.toast.error').length, 2);

  // トーストはクリックで閉じる
  toast.dispatchEvent(new app.window.Event('click'));
  assert.equal(app.document.querySelectorAll('.toast.error').length, 1);
});

test('errors — localStorage 保存失敗（容量上限相当）でもトーストが出る', async (t) => {
  const app = bootApp(); // ブラウザモード
  t.after(() => app.close());
  const api = await app.api();

  // setItem を容量超過相当で失敗させる
  const proto = Object.getPrototypeOf(app.window.localStorage);
  const orig = proto.setItem;
  proto.setItem = () => { throw new app.window.Error('QuotaExceededError'); };
  try {
    api.store.commit((s) => { s.settings.theme = 'dark'; });
    assert.equal(api.store.lastSaveOk, false, 'persist が false を返す');
    const toast = await waitFor(
      () => app.document.querySelector('.toast.error'),
      { label: '容量上限トースト' }
    );
    assert.match(toast.textContent, /保存に失敗/);
  } finally {
    proto.setItem = orig;
  }
});
