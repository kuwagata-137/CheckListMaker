'use strict';
// model 純関数のテスト。ブラウザモード（localStorage）で1回起動し、
// window.__test__.M 経由で呼ぶ。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, PX_JPEG } = require('./harness');

test('model — チェックリスト操作の純関数', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const { M } = await app.api();

  await t.test('progress — 進捗はセクション別と全体で計算される', () => {
    const c = M.createChecklist('todo', 'p');
    const sid = c.sections[0].id;
    M.addItem(c, sid, 'a');
    M.addItem(c, sid, 'b');
    M.addItem(c, sid, 'c');
    M.toggleItem(c, sid, c.sections[0].items[0].id);
    const p = M.progress(c);
    assert.equal(p.total, 3);
    assert.equal(p.done, 1);
    assert.equal(p.percent, 33);
    assert.equal(p.sections[0].percent, 33);
    assert.equal(M.progress(M.createChecklist('todo')).percent, 0, '0件でも0除算しない');
  });

  await t.test('addItem — 空白のみのテキストは追加されない', () => {
    const c = M.createChecklist('todo');
    M.addItem(c, c.sections[0].id, '   ');
    assert.equal(c.sections[0].items.length, 0);
  });

  await t.test('removeSection — 最後のセクションを消すと空セクションが補われる', () => {
    const c = M.createChecklist('todo');
    M.removeSection(c, c.sections[0].id);
    assert.equal(c.sections.length, 1);
    assert.equal(c.sections[0].items.length, 0);
  });

  await t.test('moveItem — セクション間移動と挿入位置のクランプ', () => {
    const c = M.createChecklist('todo');
    M.addSection(c, '2つ目');
    const [s1, s2] = c.sections;
    M.addItem(c, s1.id, 'a');
    M.addItem(c, s1.id, 'b');
    M.addItem(c, s2.id, 'x');
    const a = s1.items[0];
    M.moveItem(c, s1.id, a.id, s2.id, 99); // 範囲外 → 末尾へクランプ
    assert.equal(s1.items.map((i) => i.text).join('|'), 'b');
    assert.equal(s2.items.map((i) => i.text).join('|'), 'x|a');
    M.moveItem(c, s2.id, a.id, s2.id, 0); // 同一セクション内で先頭へ
    assert.equal(s2.items.map((i) => i.text).join('|'), 'a|x');
  });

  await t.test('moveSection — 並べ替え', () => {
    const c = M.createChecklist('todo');
    M.addSection(c, 'B');
    M.addSection(c, 'C');
    M.moveSection(c, c.sections[2].id, 0);
    assert.equal(c.sections.map((s) => s.title).join('|'), 'C||B');
  });

  await t.test('resetChecklist / clearCompleted', () => {
    const c = M.createChecklist('todo');
    const sid = c.sections[0].id;
    M.addItem(c, sid, 'a');
    M.addItem(c, sid, 'b');
    M.toggleItem(c, sid, c.sections[0].items[0].id);
    M.resetChecklist(c);
    assert.equal(M.progress(c).done, 0, 'reset で全て未完了');
    M.toggleItem(c, sid, c.sections[0].items[1].id);
    M.clearCompleted(c);
    assert.equal(c.sections[0].items.map((i) => i.text).join('|'), 'a', '完了項目だけ消える');
  });

  await t.test('duplicateChecklist — 複製は id が振り直され直後に並ぶ', () => {
    const state = { checklists: [], settings: {} };
    const c = M.createChecklist('template', '元');
    M.addChecklist(state, c);
    M.addItem(c, c.sections[0].id, 'a');
    M.duplicateChecklist(state, c.id);
    assert.equal(state.checklists.length, 2);
    const copy = state.checklists[1];
    assert.equal(copy.title, '元（コピー）');
    assert.notEqual(copy.id, c.id);
    assert.notEqual(copy.sections[0].id, c.sections[0].id);
    assert.notEqual(copy.sections[0].items[0].id, c.sections[0].items[0].id);
  });

  await t.test('画像の並行配列 — replace/remove で imageEdits が images と同期する', () => {
    const c = M.createChecklist('todo');
    const sid = c.sections[0].id;
    M.addItem(c, sid, 'a');
    const item = c.sections[0].items[0];
    M.addItemImage(c, sid, item.id, PX_JPEG);
    M.addItemImage(c, sid, item.id, PX_JPEG);
    assert.equal(item.imageEdits.length, 2, '追加で長さが揃う');
    M.replaceItemImage(c, sid, item.id, 1, PX_JPEG, { v: 1, base: PX_JPEG, strokes: '', objects: [] });
    assert.ok(item.imageEdits[1], '編集ソースが保持される');
    M.removeItemImage(c, sid, item.id, 0);
    assert.equal(item.images.length, 1);
    assert.equal(item.imageEdits.length, 1);
    assert.ok(item.imageEdits[0], '残った画像に対応する編集ソースが残る');
  });

  await t.test('copyItemImage — 手順間コピー（参照共有・元は残る・edit複製・同一は不変）', () => {
    const c = M.createChecklist('template');
    M.addSection(c, 'フェーズ2');
    const [s1, s2] = c.sections;
    M.addItem(c, s1.id, 'src');
    M.addItem(c, s2.id, 'dst');
    const src = s1.items[0];
    const dst = s2.items[0];
    M.addItemImage(c, s1.id, src.id, PX_JPEG, 'img:full-1');
    M.replaceItemImage(c, s1.id, src.id, 0, PX_JPEG, { v: 1, base: PX_JPEG, strokes: '', objects: [] }, 'img:full-1');

    // 別フェーズの手順へコピー
    M.copyItemImage(c, s1.id, src.id, 0, s2.id, dst.id);
    assert.equal(src.images.length, 1, '元の画像は残る（移動ではない）');
    assert.equal(dst.images.length, 1, 'コピー先に1枚追加される');
    assert.equal(dst.images[0], src.images[0], 'サムネ参照は共有（同じ値）');
    assert.equal(dst.imagesFull[0], 'img:full-1', '原寸参照も共有される');
    assert.ok(dst.imageEdits[0], 'edit も引き継がれる');
    assert.notEqual(dst.imageEdits[0], src.imageEdits[0], 'edit は取り違え防止に複製（別オブジェクト）');

    // 同一手順へのコピーは何もしない
    M.copyItemImage(c, s1.id, src.id, 0, s1.id, src.id);
    assert.equal(src.images.length, 1, '同一手順コピーは無視');
  });

  await t.test('sumMinutes — 数値解釈できない time は 0 扱い', () => {
    assert.equal(M.sumMinutes([{ time: '10' }, { time: '5分' }, { time: '' }, { time: 'abc' }]), 15);
  });
});
