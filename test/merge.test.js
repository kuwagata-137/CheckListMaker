'use strict';
// 手順/項目の「上と統合」（通常編集）の純関数テスト。
// ブラウザモードで1回起動し、window.__test__.M 経由で呼ぶ。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./harness');

// 3つの項目を持つセクションを1つ作り、[c, sid, items] を返すヘルパ。
function threeItems(M) {
  const c = M.createChecklist('template', 'p');
  const sid = c.sections[0].id;
  M.addBlankItem(c, sid);
  M.addBlankItem(c, sid);
  M.addBlankItem(c, sid);
  return { c, sid, items: c.sections[0].items };
}

test('merge — 上の手順と統合（通常編集）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const { M } = await app.api();

  await t.test('mergeTimeValue — 合算/片方/なし', () => {
    assert.equal(M.mergeTimeValue('3', '5'), '8');
    assert.equal(M.mergeTimeValue('3', ''), '3');
    assert.equal(M.mergeTimeValue('', '5'), '5');
    assert.equal(M.mergeTimeValue('', ''), '');
    assert.equal(M.mergeTimeValue('abc', '5'), '5', '非数値は無視');
  });

  await t.test('text は「、」連結（片方空はもう片方）', () => {
    const { c, sid, items } = threeItems(M);
    items[0].text = '保存を押す';
    items[1].text = '閉じる';
    M.mergeItemUp(c, sid, items[1].id);
    assert.equal(c.sections[0].items.length, 2);
    assert.equal(c.sections[0].items[0].text, '保存を押す、閉じる');
  });

  await t.test('片方の text が空なら連結記号を入れない', () => {
    const { c, sid, items } = threeItems(M);
    items[0].text = '';
    items[1].text = '閉じる';
    M.mergeItemUp(c, sid, items[1].id);
    assert.equal(c.sections[0].items[0].text, '閉じる');
  });

  await t.test('body は段落として連結・note は改行連結・time は合算', () => {
    const { c, sid, items } = threeItems(M);
    Object.assign(items[0], { body: '<p>A</p>', note: 'メモ1', time: '3' });
    Object.assign(items[1], { body: '<p>B</p>', note: 'メモ2', time: '5' });
    M.mergeItemUp(c, sid, items[1].id);
    const merged = c.sections[0].items[0];
    assert.equal(merged.body, '<p>A</p><p>B</p>');
    assert.equal(merged.note, 'メモ1\nメモ2');
    assert.equal(merged.time, '8');
  });

  await t.test('done は両方完了のときだけ完了', () => {
    const { c, sid, items } = threeItems(M);
    items[0].done = true; items[1].done = true;
    M.mergeItemUp(c, sid, items[1].id);
    assert.equal(c.sections[0].items[0].done, true);

    const b = threeItems(M);
    b.items[0].done = true; b.items[1].done = false;
    M.mergeItemUp(b.c, b.sid, b.items[1].id);
    assert.equal(b.c.sections[0].items[0].done, false, 'どちらか未完なら未完');
  });

  await t.test('画像は並行配列(images/imageEdits/imagesFull)を揃えて連結', () => {
    const { c, sid, items } = threeItems(M);
    // 上: 画像1枚（原寸あり・編集なし）
    items[0].images = ['thumbA'];
    items[0].imagesFull = ['fullA'];
    // 下: 画像1枚（原寸なし・編集あり）— imagesFull 未設定でも揃うこと
    items[1].images = ['thumbB'];
    items[1].imageEdits = [{ v: 1, base: 'bB' }];
    M.mergeItemUp(c, sid, items[1].id);
    const merged = c.sections[0].items[0];
    assert.deepEqual(merged.images, ['thumbA', 'thumbB']);
    assert.deepEqual(merged.imagesFull, ['fullA', null], '原寸は無い側を null で揃える');
    assert.equal(merged.imageEdits.length, 2);
    assert.equal(merged.imageEdits[0], null, '編集の無い側は null');
    assert.deepEqual(merged.imageEdits[1], { v: 1, base: 'bB' });
  });

  await t.test('先頭手順は統合しない（no-op）', () => {
    const { c, sid, items } = threeItems(M);
    items[0].text = 'X';
    M.mergeItemUp(c, sid, items[0].id);
    assert.equal(c.sections[0].items.length, 3, '件数は変わらない');
    assert.equal(c.sections[0].items[0].text, 'X');
  });

  await t.test('存在しない itemId は no-op', () => {
    const { c, sid } = threeItems(M);
    M.mergeItemUp(c, sid, 'no-such-id');
    assert.equal(c.sections[0].items.length, 3);
  });

  await t.test('セクション境界を跨がない（別セクションの先頭は統合先を持たない）', () => {
    const c = M.createChecklist('template');
    const s1 = c.sections[0].id;
    M.addSection(c, '2つ目');
    const s2 = c.sections[1].id;
    M.addBlankItem(c, s1); c.sections[0].items[0].text = 'S1-1';
    M.addBlankItem(c, s2); c.sections[1].items[0].text = 'S2-1';
    // s2 の先頭手順を統合しようとしても何も起きない（上のセクションへは吸わない）
    M.mergeItemUp(c, s2, c.sections[1].items[0].id);
    assert.equal(c.sections[0].items.length, 1);
    assert.equal(c.sections[1].items.length, 1);
    assert.equal(c.sections[0].items[0].text, 'S1-1');
    assert.equal(c.sections[1].items[0].text, 'S2-1');
  });
});
