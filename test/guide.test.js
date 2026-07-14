'use strict';
// ガイド小窓（3-R6）のテスト。仕様は docs/spec-3-R6-guide-overlay.md 参照。
// guide.html 自体（Electron 窓）は実機検証項目のため、ここでは
// ①ペイロード純関数 ②プレイヤーの小窓モード（guideAPI スタブ）を検証する。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor } = require('./harness');

// 記録用の guideAPI スタブ。onAction/onClosed のコールバックを取り出して
// 「小窓からの操作」をテストから直接発火できるようにする。
function stubGuideAPI() {
  const calls = { open: [], update: [], close: [] };
  const stub = {
    available: true,
    open: (p) => { calls.open.push(p); return Promise.resolve({ ok: true }); },
    update: (p) => { calls.update.push(p); return Promise.resolve({ ok: true }); },
    close: (o) => { calls.close.push(o || {}); return Promise.resolve({ ok: true }); },
    onAction: (cb) => { stub.actionCb = cb; },
    onClosed: (cb) => { stub.closedCb = cb; },
  };
  return { stub, calls };
}

test('guide — guideStepPayload（純関数）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const { M } = T;

  const c = M.createChecklist('template', '手順書');
  c.sections[0].title = '準備';
  const sid = c.sections[0].id;
  M.addItem(c, sid, '「保存」ボタンをクリック');
  c.sections[0].items[0].note = 'メモです';
  c.sections[0].items[0].time = '2';
  const steps = T.playerSteps(c);

  await t.test('フィールド一式（index は 1 始まり・stdMin は分・image は null）', () => {
    const p = T.guideStepPayload(c, steps, 0, [{ status: 'pending', seconds: 42 }]);
    assert.equal(p.title, '手順書');
    assert.equal(p.sectionTitle, '準備');
    assert.equal(p.index, 1);
    assert.equal(p.total, 1);
    assert.equal(p.text, '「保存」ボタンをクリック');
    assert.equal(p.note, 'メモです');
    assert.equal(p.stdMin, 2);
    assert.equal(p.seconds, 42);
    assert.equal(p.image, null);
  });

  await t.test('境界: 範囲外 index・null は落ちずに null', () => {
    assert.equal(T.guideStepPayload(c, steps, 5, []), null);
    assert.equal(T.guideStepPayload(null, steps, 0, []), null);
    const p = T.guideStepPayload(c, steps, 0, null);
    assert.equal(p.seconds, 0, 'results 無しでも seconds は 0');
  });
});

test('guide — プレイヤーの小窓モード（guideAPI スタブ）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const { M, store } = T;
  const win = app.window;
  const doc = app.document;

  const c = M.createChecklist('template', '小窓テスト');
  const sid = c.sections[0].id;
  M.addItem(c, sid, '手順その1');
  M.addItem(c, sid, '手順その2');
  store.commit((s) => M.addChecklist(s, c));

  await t.test('「小窓で実行」起動: オーバーレイが隠れ open にペイロードが届く', async () => {
    const { stub, calls } = stubGuideAPI();
    win.guideAPI = stub;
    const overlay = T.openPlayer(c.id, null, { gadget: true });
    await waitFor(() => calls.open.length === 1, { label: 'guide open' });
    assert.equal(overlay.style.display, 'none', '全画面オーバーレイは隠れる');
    assert.equal(calls.open[0].index, 1);
    assert.equal(calls.open[0].total, 2);
    assert.equal(calls.open[0].text, '手順その1');

    // 小窓の「✓ 完了して次へ」→ 本体のチェックに同期し update が飛ぶ
    stub.actionCb('complete');
    await waitFor(() => calls.update.length === 1, { label: 'guide update' });
    assert.equal(M.findChecklist(store.state, c.id).sections[0].items[0].done, true);
    assert.equal(calls.update[0].index, 2);

    // 最後のステップを完了 → focusMain 付きで閉じ、全画面に戻ってサマリ表示（決定2）
    stub.actionCb('complete');
    await waitFor(() => calls.close.length === 1, { label: 'guide close' });
    assert.equal(calls.close[0].focusMain, true);
    await waitFor(() => overlay.style.display !== 'none' && /実行完了/.test(overlay.textContent),
      { label: 'サマリ表示' });
    overlay.querySelector('[data-pl="exit"]').click();
    assert.equal(doc.querySelector('.player-overlay'), null);
  });

  await t.test('小窓の ✕（closed 通知）: 全画面の実行モードへ戻る', async () => {
    const cur = M.findChecklist(store.state, c.id);
    cur.sections[0].items.forEach((it) => (it.done = false));
    const { stub, calls } = stubGuideAPI();
    win.guideAPI = stub;
    const overlay = T.openPlayer(c.id, null, { gadget: true });
    await waitFor(() => calls.open.length === 1, { label: 'guide open' });
    stub.closedCb();
    assert.equal(overlay.style.display, '', 'オーバーレイが再表示される');
    assert.match(overlay.textContent, /ステップ 1 \/ 2/, '同じ位置から全画面で継続');
    overlay.querySelector('[data-pl="exit"]').click();
  });

  await t.test('全画面 →「🧭 小窓に切替」ボタンで途中から小窓モードへ', async () => {
    const { stub, calls } = stubGuideAPI();
    win.guideAPI = stub;
    const overlay = T.openPlayer(c.id);
    const btn = overlay.querySelector('[data-pl="guide"]');
    assert.ok(btn, 'guideAPI があるときは切替ボタンが出る');
    btn.click();
    await waitFor(() => calls.open.length === 1, { label: 'guide open' });
    assert.equal(overlay.style.display, 'none');
    // 実行モードを終了すると小窓も閉じる
    stub.closedCb && overlay.remove(); // 後片付け（close 経路は上のテストで検証済み）
  });

  await t.test('guideAPI が無い（ブラウザ/単体HTML）: 切替ボタン自体が出ない', () => {
    delete win.guideAPI;
    const overlay = T.openPlayer(c.id);
    assert.equal(overlay.querySelector('[data-pl="guide"]'), null);
    overlay.remove();
  });
});
