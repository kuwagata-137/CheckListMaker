// 完了した ToDo 項目の見た目（灰色のみ・取り消し線なし）の回帰テスト。
// ユーザー要望 2026-09-11: 取り消し線は「無効」に見えて誤解を招くので付けない。
// 画面（.item.done .item-text）と印刷／PDF（.print-todo.done .print-text）の両方を見る。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// セレクタで始まる CSS 規則の本体（{ … }）を取り出す。無ければ null。
function ruleBody(selector) {
  const i = HTML.indexOf(selector + ' {');
  if (i < 0) return null;
  return HTML.slice(i, HTML.indexOf('}', i) + 1);
}

test('完了した ToDo 項目に取り消し線を付けない', async (t) => {
  await t.test('画面: .item.done .item-text は灰色だけ', () => {
    const body = ruleBody('.item.done .item-text');
    assert.ok(body, '規則が存在する');
    assert.doesNotMatch(body, /line-through/);
    assert.match(body, /color:\s*var\(--muted\)/);
  });

  await t.test('印刷・PDF: .print-todo.done .print-text も灰色だけ', () => {
    const body = ruleBody('.print-todo.done .print-text');
    assert.ok(body, '規則が存在する');
    assert.doesNotMatch(body, /line-through/);
    assert.match(body, /color:\s*#666/);
  });
});
