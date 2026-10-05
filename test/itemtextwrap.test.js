'use strict';
// 項目・手順の文字欄を、文字の量に合わせて縦に伸ばす（Enter で改行可）のテスト（v1.0.11）。
// 仕様は docs/spec-item-text-wrap.md 参照。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { bootApp, waitFor, ROOT } = require('./harness');
const { buildXlsxWorkbook } = require('../xlsx-export');

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const GUIDE = fs.readFileSync(path.join(ROOT, 'guide.html'), 'utf8');
const STORAGE_KEY = 'checklistmaker.v1';

// 行頭がそのセレクタで始まる CSS 規則の本体（{ … }）。`.item.done .item-text {` のような
// 子孫セレクタの途中一致を拾わないよう、行頭（字下げのみ）からの一致に限る。
function ruleBody(src, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^[ \\t]*${esc} \\{[^}]*\\}`, 'm').exec(src);
  return m ? m[0] : null;
}

const item = (id, text, extra = {}) => ({ id, text, done: false, note: '', time: '', body: '', images: [], ...extra });
const seedState = () => ({
  checklists: [
    {
      id: 'c1', title: '買い物', type: 'todo', createdAt: 1, updatedAt: 1,
      sections: [{ id: 's1', title: '', items: [
        item('i1', '牛乳\nパン'),
        item('i2', '\n先頭が改行'),
        item('i3', '短い'),
      ] }],
    },
    {
      id: 't1', title: 'サーバー点検', type: 'template', createdAt: 1, updatedAt: 1,
      sections: [{ id: 's2', title: '準備', items: [
        item('j1', '電源を\n入れる', { note: 'メモ1\nメモ2', time: '2' }),
        item('j2', '確認する'),
      ] }],
    },
  ],
  settings: { theme: 'auto' },
});

async function openEditor(t, id) {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
  t.after(() => app.close());
  const T = await app.api();
  app.window.location.hash = '#/c/' + id;
  await waitFor(() => app.document.querySelector('#app .item'), { label: '編集画面' });
  const field = (itemId, cls) => app.document.querySelector(`#app .item[data-item="${itemId}"] .${cls}`);
  return { app, T, field };
}

test('編集画面: 項目・手順・メモの欄は複数行の textarea', async (t) => {
  await t.test('ToDo 型の項目の文字欄', async (tt) => {
    const { field } = await openEditor(tt, 'c1');
    const ta = field('i1', 'item-text');
    assert.equal(ta.tagName, 'TEXTAREA');
    assert.equal(ta.getAttribute('rows'), '1');
    assert.equal(ta.value, '牛乳\nパン', '改行がそのまま入る');
    assert.equal(field('i2', 'item-text').value, '\n先頭が改行', '先頭の改行も落ちない');
    assert.equal(field('i3', 'item-text').value, '短い');
  });

  await t.test('テンプレート型の手順の文字欄とメモ欄', async (tt) => {
    const { field } = await openEditor(tt, 't1');
    const text = field('j1', 'step-text');
    assert.equal(text.tagName, 'TEXTAREA');
    assert.equal(text.getAttribute('rows'), '1');
    assert.equal(text.value, '電源を\n入れる');
    assert.equal(text.getAttribute('placeholder'), '手順の内容');
    const note = field('j1', 'step-note-input');
    assert.equal(note.tagName, 'TEXTAREA');
    assert.equal(note.getAttribute('rows'), '1');
    assert.equal(note.value, 'メモ1\nメモ2', '統合で改行の入ったメモが詰まらずに出る');
    assert.equal(note.getAttribute('placeholder'), 'メモ（任意）');
  });
});

test('編集画面: 改行を入れた値がそのまま保存される', async (t) => {
  const { app, T, field } = await openEditor(t, 't1');
  const change = (el, v) => {
    el.value = v;
    el.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  };
  change(field('j2', 'step-text'), '確認\nする');
  change(field('j2', 'step-note-input'), '1行目\n2行目');
  const saved = T.store.state.checklists[1].sections[0].items[1];
  assert.equal(saved.text, '確認\nする');
  assert.equal(saved.note, '1行目\n2行目');
});

test('CSS: 欄の高さを文に合わせ、出力の本文は改行で行を変える', async (t) => {
  await t.test('編集画面の欄は field-sizing: content', () => {
    for (const sel of ['.item-text', '.step-note-input']) {
      const body = ruleBody(HTML, sel);
      assert.ok(body, `${sel} の規則がある`);
      assert.match(body, /field-sizing:\s*content/, `${sel} は内容に合わせて伸びる`);
      assert.match(body, /resize:\s*none/, `${sel} はつまみで大きさを変えない`);
    }
  });
  await t.test('印刷・PDF の本文は pre-line、目次は1行のまま', () => {
    for (const sel of ['.print-step-text', '.print-note', '.print-todo .print-text']) {
      assert.match(ruleBody(HTML, sel) || '', /white-space:\s*pre-line/, `${sel} は改行で行を変える`);
    }
    assert.doesNotMatch(ruleBody(HTML, '.print-toc-step') || '', /pre-line/, '目次は1行にまとめる');
  });
  await t.test('作業開始の全画面と小窓は pre-line、小窓のたたんだ状態は1行', () => {
    assert.match(ruleBody(HTML, '.pl-text') || '', /white-space:\s*pre-line/);
    assert.match(ruleBody(HTML, '.pl-note') || '', /white-space:\s*pre-line/);
    assert.match(ruleBody(GUIDE, '.text') || '', /white-space:\s*pre-line/);
    assert.match(ruleBody(GUIDE, '.note') || '', /white-space:\s*pre-line/);
    assert.match(ruleBody(GUIDE, '.card.mini .text') || '', /white-space:\s*nowrap/);
  });
});

test('出力: 印刷と Word に改行が届く', async (t) => {
  const { T } = await openEditor(t, 't1');
  const [todo, tpl] = T.store.state.checklists;

  await t.test('印刷の HTML に改行が残る（CSS の pre-line で行が変わる）', () => {
    const step = T.printItemHtml({ it: tpl.sections[0].items[0], no: 1 }, true, '');
    assert.match(step, /<span class="print-step-text">電源を\n入れる<\/span>/);
    assert.match(step, /（メモ）<\/span>メモ1\nメモ2<\/div>/);
    const td = T.printItemHtml({ it: todo.sections[0].items[0], no: 0 }, false, '');
    assert.match(td, /<span class="print-text">牛乳\nパン<\/span>/);
  });

  await t.test('Word 用 HTML では改行が <br> になる', () => {
    const tplHtml = T.renderDocxView(tpl).html;
    assert.match(tplHtml, /電源を<br>入れる@@/, '手順名の改行');
    assert.match(tplHtml, /（メモ）メモ1<br>メモ2/, 'メモの改行');
    const todoHtml = T.renderDocxView(todo).html;
    assert.match(todoHtml, /☐ 牛乳<br>パン/, 'ToDo 項目の改行');
    assert.match(todoHtml, /☐ <br>先頭が改行/, '先頭の改行');
  });
});

test('出力: Excel の行の高さは text・note・詳細の最大行数で決まる', async () => {
  const data = {
    sheetName: 'S', cover: null,
    columns: [
      { header: 'No', width: 6 }, { header: '項目', width: 40 }, { header: 'チェック', width: 9 },
      { header: '標準時間(分)', width: 13 }, { header: 'メモ', width: 25 }, { header: '詳細', width: 50 },
    ],
    rows: [
      { kind: 'header' },
      { kind: 'item', no: 1, text: '1行目\n2行目\n3行目', check: '', time: '', note: '', detail: '' },
      { kind: 'item', no: 2, text: '1行', check: '', time: '', note: 'a\nb', detail: 'x' },
      { kind: 'item', no: 3, text: '1行', check: '', time: '', note: '', detail: '' },
    ],
  };
  const wb = buildXlsxWorkbook(ExcelJS, data);
  const rb = new ExcelJS.Workbook();
  await rb.xlsx.load(await wb.xlsx.writeBuffer());
  const ws = rb.worksheets[0];
  assert.equal(ws.getCell('B2').value, '1行目\n2行目\n3行目');
  assert.ok(ws.getRow(2).height >= 14 * 3, `text が3行 → 行高 ${ws.getRow(2).height}`);
  assert.ok(ws.getRow(3).height >= 14 * 2, `note が2行 → 行高 ${ws.getRow(3).height}`);
  assert.ok(!ws.getRow(4).height || ws.getRow(4).height < 28, '1行だけの行は高さを指定しない');
});
