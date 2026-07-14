'use strict';
// 実行モード（3-R5）のテスト。仕様は docs/spec-3-R5-player.md 参照。
// 前半は純関数、後半はブラウザモード起動でのプレイヤー動作（DOM）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./harness');

// steps: [{done, time, text}] の略記からチェックリストを組む
function buildChecklist(M, spec) {
  const c = M.createChecklist('template', 'テスト手順');
  const sid = c.sections[0].id;
  spec.forEach((over, i) => {
    const it = M.createItem(over.text || `手順${i + 1}`);
    Object.assign(it, over);
    c.sections[0].items.push(it);
  });
  M.addSection(c, '後半');
  return { c, sid };
}

test('player — 実行モードの純関数', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const { M } = T;

  await t.test('playerSteps — 全セクションの項目を平坦化・セクション指定で絞る', () => {
    const { c, sid } = buildChecklist(M, [{}, {}]);
    const s2 = c.sections[1];
    s2.items.push(M.createItem('後半の手順'));
    const all = T.playerSteps(c);
    assert.equal(all.length, 3);
    assert.equal(all[0].sectionId, sid);
    assert.equal(all[2].sectionTitle, '後半');
    const only = T.playerSteps(c, s2.id);
    assert.equal(only.length, 1);
    assert.equal(only[0].item.text, '後半の手順');
    assert.equal(T.playerSteps(null).length, 0, 'null でも落ちない');
  });

  await t.test('playerStartIndex — 最初の未チェックから再開・全部済みなら先頭', () => {
    const { c } = buildChecklist(M, [{ done: true }, { done: false }, { done: false }]);
    assert.equal(T.playerStartIndex(T.playerSteps(c)), 1);
    c.sections[0].items.forEach((it) => (it.done = true));
    assert.equal(T.playerStartIndex(T.playerSteps(c)), 0);
    assert.equal(T.playerStartIndex([]), 0);
  });

  await t.test('formatPlayerTime — m:ss 形式・不正値は 0:00', () => {
    assert.equal(T.formatPlayerTime(0), '0:00');
    assert.equal(T.formatPlayerTime(9), '0:09');
    assert.equal(T.formatPlayerTime(75), '1:15');
    assert.equal(T.formatPlayerTime(600), '10:00');
    assert.equal(T.formatPlayerTime(-5), '0:00');
    assert.equal(T.formatPlayerTime('x'), '0:00');
  });

  await t.test('playerSummary — 完了/スキップ/合計実測/合計標準（time は分）', () => {
    const { c } = buildChecklist(M, [{ time: '1' }, { time: '2' }, { time: '' }]);
    const steps = T.playerSteps(c);
    const sum = T.playerSummary(steps, [
      { status: 'done', seconds: 30 },
      { status: 'skip', seconds: 15 },
      { status: 'pending', seconds: 0 },
    ]);
    assert.deepEqual(
      JSON.parse(JSON.stringify(sum)),
      { total: 3, done: 1, skipped: 1, seconds: 45, stdSeconds: 180 }
    );
    const empty = T.playerSummary([], []);
    assert.equal(empty.total, 0);
    assert.equal(empty.stdSeconds, 0);
  });
});

test('player — プレイヤーの DOM 動作（チェック同期・キーボード・サマリ）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const { M, store } = T;
  const doc = app.document;
  const win = app.window;

  const key = (k) =>
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  // 2手順のリストをストアに用意
  const c = M.createChecklist('template', 'DOMテスト');
  const sid = c.sections[0].id;
  M.addItem(c, sid, '「保存」ボタンをクリック');
  M.addItem(c, sid, '「閉じる」をクリック');
  c.sections[0].items[0].note = '上書き確認は「はい」';
  c.sections[0].items[0].time = '1';
  store.commit((s) => M.addChecklist(s, c));

  await t.test('開く → 1手順目が表示される（文・メモ・標準時間）', () => {
    const overlay = T.openPlayer(c.id);
    assert.ok(doc.querySelector('.player-overlay'), 'オーバーレイが開く');
    assert.match(overlay.querySelector('.pl-text').textContent, /保存/);
    assert.match(overlay.querySelector('.pl-note').textContent, /上書き確認/);
    assert.match(overlay.textContent, /ステップ 1 \/ 2/);
    assert.match(overlay.querySelector('.pl-times').textContent, /1:00/, '標準時間 1分 = 1:00');
    overlay.remove(); // 後片付け（次のサブテストで開き直す）
  });

  await t.test('Space で完了 → 本体の done に同期して次のステップへ', () => {
    const overlay = T.openPlayer(c.id);
    key(' ');
    const cur = M.findChecklist(store.state, c.id);
    assert.equal(cur.sections[0].items[0].done, true, '本体のチェックと同期（決定1）');
    assert.match(overlay.textContent, /ステップ 2 \/ 2/, '次のステップへ進む');
    assert.ok(store.canUndo(), '通常 commit なので Undo できる');
    key('Escape');
    assert.equal(doc.querySelector('.player-overlay'), null, 'Esc で閉じる');
  });

  await t.test('→ はスキップ（チェックなし）で、最後まで進むとサマリ', () => {
    const cur = M.findChecklist(store.state, c.id);
    cur.sections[0].items.forEach((it) => (it.done = false));
    const overlay = T.openPlayer(c.id);
    key('ArrowRight'); // 手順1をスキップ
    key('ArrowRight'); // 手順2をスキップ → サマリ
    assert.equal(cur.sections[0].items[0].done, false, 'スキップはチェックを付けない（決定4）');
    assert.match(overlay.textContent, /実行完了/, 'サマリ表示');
    assert.match(overlay.textContent, /スキップ/);
    const stats = [...overlay.querySelectorAll('.pl-stat .v')].map((el) => el.textContent.trim());
    assert.equal(stats[0], '0 / 2', '完了 0');
    assert.equal(stats[1], '2', 'スキップ 2');
    overlay.querySelector('[data-pl="exit"]').click();
    assert.equal(doc.querySelector('.player-overlay'), null, 'リストに戻るで閉じる');
  });

  await t.test('チェック済みから再開・完了済みは「完了」扱いで開始', () => {
    const cur = M.findChecklist(store.state, c.id);
    cur.sections[0].items[0].done = true;
    cur.sections[0].items[1].done = false;
    const overlay = T.openPlayer(c.id);
    assert.match(overlay.textContent, /ステップ 2 \/ 2/, '未チェックの最初から再開（決定3）');
    key('Enter'); // Enter でも完了できる → サマリ
    assert.match(overlay.textContent, /実行完了/);
    const stats = [...overlay.querySelectorAll('.pl-stat .v')].map((el) => el.textContent.trim());
    assert.equal(stats[0], '2 / 2', '事前チェック分も完了に数える');
    // もう一度実行 → ステップ表示に戻る
    overlay.querySelector('[data-pl="again"]').click();
    assert.match(overlay.textContent, /ステップ 1 \/ 2/, '全部チェック済みなら先頭から');
    key('Escape');
  });

  await t.test('セクション単位の実行と、空リストではトースト', () => {
    const c2 = M.createChecklist('todo', 'セクション実行');
    M.addSection(c2, '対象');
    const s2 = c2.sections[1];
    s2.items.push(M.createItem('対象セクションの項目'));
    store.commit((s) => M.addChecklist(s, c2));
    const overlay = T.openPlayer(c2.id, s2.id);
    assert.match(overlay.textContent, /ステップ 1 \/ 1/, '対象セクションだけを実行');
    assert.match(overlay.querySelector('.pl-text').textContent, /対象セクションの項目/);
    key('Escape');
    assert.equal(T.openPlayer(c2.id, c2.sections[0].id), undefined, '空セクションは開かない');
    assert.ok(doc.querySelector('#toast-host .toast'), '案内トーストが出る');
  });
});
