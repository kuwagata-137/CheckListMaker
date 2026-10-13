'use strict';
// メニューバー（#topbar）を2段にし、編集画面のボタンと「手順を追加」「フェーズを追加」を置く（v1.0.12）。
// 仕様は docs/spec-editor-menubar.md 6章。見た目（2段・横スクロール）は実機で確認する。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor } = require('./harness');

const STORAGE_KEY = 'checklistmaker.v1';
const plain = (v) => JSON.parse(JSON.stringify(v));
const item = (id, text) => ({ id, text, done: false, note: '', time: '', body: '', images: [] });
const checklist = (id, type, sections) => ({ id, title: 'メニューバー', type, createdAt: 1, updatedAt: 1, sections });
const twoPhases = () => [
  { id: 's1', title: '準備', items: [item('i1', '手順1'), item('i2', '手順2')] },
  { id: 's2', title: '作業', items: [item('i3', '手順3')] },
];

async function boot(t, lists) {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify({ checklists: lists, settings: { theme: 'auto' } }) } });
  t.after(() => app.close());
  const api = await app.api();
  const doc = app.document;
  const actions = (sel) => [...doc.querySelectorAll(`#topbar ${sel} [data-action]`)].map((b) => b.dataset.action);
  const labels = (sel) => [...doc.querySelectorAll(`#topbar ${sel} .tb-lb`)].map((b) => b.textContent);
  const open = async (id, ready) => {
    app.window.location.hash = '#/c/' + id;
    await waitFor(() => doc.querySelector(ready), { label: '編集画面' });
  };
  const goHome = async () => {
    app.window.location.hash = '#/';
    await waitFor(() => doc.querySelector('#app .home'), { label: '一覧画面' });
  };
  const click = (action) => doc.querySelector(`#topbar [data-action="${action}"]`).click();
  const sections = (id) => api.store.state.checklists.find((c) => c.id === id).sections;
  return { app, api, doc, win: app.window, actions, labels, open, goHome, click, sections };
}

test('メニューバー — ボタンの並び（B案）と、一覧画面では編集用のボタンを出さない', async (t) => {
  const b = await boot(t, [checklist('c1', 'template', twoPhases()), checklist('c2', 'todo', twoPhases())]);
  const { doc } = b;
  assert.ok(doc.querySelector('#topbar > .topbar-brand-row .topbar-brand'), '上の段に題名');
  assert.ok(doc.querySelector('#topbar > .topbar-tools [data-action="undo"]'), '下の段にボタン');
  assert.deepEqual(b.actions('.tb-editor-main'), [], '一覧画面では左側は空');
  assert.deepEqual(b.actions('.tb-editor-add'), [], '一覧画面では追加の2つも出さない');

  await b.open('c1', '#app .item[data-item="i3"]');
  assert.equal(doc.querySelector('#app .editor-toolbar'), null, '編集画面の上の段は無くなった');
  assert.deepEqual(b.actions('.tb-editor-main'), ['menu-export', 'print', 'play', 'reset', 'cover']);
  assert.deepEqual(b.labels('.tb-editor-main'), ['ファイルで出力 ▾', '印刷', '作業を開始', '作業をリセット', '表紙を編集']);
  assert.deepEqual(b.actions('.tb-editor-add'), ['add-step-here', 'add-section-here']);
  assert.deepEqual(b.labels('.tb-editor-add'), ['手順を追加', 'フェーズを追加']);
  // ツールの段の中の順：左側 → 余白 → 追加の2つ → 元に戻す・やり直す → 撮影・取り込み
  const order = [...doc.querySelectorAll('#topbar .topbar-tools [data-action]')].map((x) => x.dataset.action);
  assert.deepEqual(order.slice(0, 9), ['menu-export', 'print', 'play', 'reset', 'cover', 'add-step-here', 'add-section-here', 'undo', 'redo']);
  const tools = [...doc.querySelector('#topbar .topbar-tools').children];
  assert.ok(tools.indexOf(doc.querySelector('#topbar .topbar-spacer')) < tools.indexOf(doc.querySelector('#topbar .tb-editor-add')),
    '追加の2つは余白の右（元に戻すの左）');

  await b.open('c2', '#app .is-todo');
  assert.deepEqual(b.actions('.tb-editor-main'), ['menu-export', 'print', 'play', 'clear-completed'], 'ToDo 型は完了を削除・表紙なし');
  assert.deepEqual(b.labels('.tb-editor-add'), ['項目を追加', 'セクションを追加']);

  await b.goHome();
  assert.deepEqual(b.actions('.tb-editor-main'), [], '一覧へ戻ると消える');
});

test('メニューバー — 小窓が使える環境では「作業を開始 ▾」がメニューになる', async (t) => {
  const b = await boot(t, [checklist('c1', 'template', twoPhases())]);
  b.win.guideAPI = {};
  const html = b.api.renderTopbarEditor(b.api.store.state.checklists[0]).main;
  assert.match(html, /data-action="menu-run"/);
  assert.match(html, /作業を開始 ▾/);
});

test('メニューバー — 「作業を開始」は手順が0件なら押せず、入力のたびの保存ではボタンを作り直さない', async (t) => {
  const b = await boot(t, [checklist('c1', 'template', [{ id: 's1', title: '準備', items: [] }])]);
  const { doc } = b;
  await b.open('c1', '#app .section[data-section="s1"]');
  assert.equal(doc.querySelector('#topbar [data-action="play"]').disabled, true);
  b.click('add-step-here');
  await waitFor(() => doc.querySelector('#app .item'), { label: '手順の追加' });
  const play = doc.querySelector('#topbar [data-action="play"]');
  assert.equal(play.disabled, false, '手順ができたら押せる');
  const ta = doc.querySelector('#app .item .item-text');
  ta.value = '文を入力';
  ta.dispatchEvent(new b.win.Event('change', { bubbles: true })); // commitInPlace（再描画しない保存）
  assert.equal(doc.querySelector('#topbar [data-action="play"]'), play, '同じボタンのまま（作り直さない）');
});

test('「手順を追加」— 最後に入力した手順のすぐ下に入れ、入力欄へカーソルを移す。まだなら最後', async (t) => {
  const b = await boot(t, [checklist('c1', 'template', twoPhases())]);
  const { doc } = b;
  await b.open('c1', '#app .item[data-item="i3"]');
  const ids = () => plain(b.sections('c1').map((s) => s.items.map((x) => x.id)));

  b.click('add-step-here'); // どの手順にもさわっていない → 最後のフェーズの末尾
  assert.deepEqual(ids()[1].slice(0, 1), ['i3']);
  assert.equal(ids()[1].length, 2, '最後のフェーズの末尾に入った');
  const added1 = ids()[1][1];
  assert.equal(doc.activeElement && doc.activeElement.closest('.item').dataset.item, added1, '入れた手順の入力欄へ');

  doc.querySelector('#app .item[data-item="i1"] .item-text').focus(); // 手順1にさわる
  b.click('add-step-here');
  assert.deepEqual(ids()[0].length, 3);
  assert.equal(ids()[0][0], 'i1');
  assert.equal(ids()[0][2], 'i2', '手順1のすぐ下（手順2の上）に入った');
  const added2 = ids()[0][1];
  assert.equal(doc.activeElement.closest('.item').dataset.item, added2);

  b.click('add-step-here'); // 続けて押すと、いま入れた手順のすぐ下に続く
  assert.equal(ids()[0][2] !== 'i2' && ids()[0][3], 'i2');

  b.api.store.undo(); // 元に戻す1回で1件ずつ消える
  assert.equal(ids()[0].length, 3);
});

test('「手順を追加」— フェーズが1つも無ければ、フェーズを作ってその中に入れる（元に戻す1回で両方消える）', async (t) => {
  const b = await boot(t, [checklist('c1', 'template', [])]);
  await b.open('c1', '#app .editor');
  b.click('add-step-here');
  assert.equal(b.sections('c1').length, 1);
  assert.equal(b.sections('c1')[0].items.length, 1);
  b.api.store.undo();
  assert.equal(b.sections('c1').length, 0);
});

test('「手順を追加」— 入力欄の無い所（番号など）を押した手順も基準になる', async (t) => {
  const b = await boot(t, [checklist('c1', 'template', twoPhases())]);
  const { doc, win } = b;
  await b.open('c1', '#app .item[data-item="i3"]');
  doc.querySelector('#app .item[data-item="i1"]')
    .dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  b.click('add-step-here');
  const s1 = plain(b.sections('c1')[0].items.map((x) => x.id));
  assert.equal(s1.length, 3);
  assert.deepEqual([s1[0], s1[2]], ['i1', 'i2'], '手順1のすぐ下に入った');
});

test('「フェーズを追加」— 最後に入力した手順のフェーズのすぐ下に入れ、見出しへカーソルを移す。まだなら最後', async (t) => {
  const b = await boot(t, [checklist('c1', 'template', twoPhases())]);
  const { doc } = b;
  await b.open('c1', '#app .item[data-item="i3"]');
  const secIds = () => plain(b.sections('c1').map((s) => s.id));

  b.click('add-section-here'); // さわっていない → いちばん下
  assert.equal(secIds().length, 3);
  assert.deepEqual(secIds().slice(0, 2), ['s1', 's2']);
  const added1 = secIds()[2];
  assert.equal(doc.activeElement.closest('.section').dataset.section, added1, '入れたフェーズの見出しへ');

  doc.querySelector('#app .item[data-item="i2"] .item-text').focus(); // 準備（s1）の手順2にさわる
  b.click('add-section-here');
  assert.equal(secIds()[0], 's1');
  assert.equal(secIds()[2], 's2', '準備のすぐ下（作業の上）に入った');
});

test('「手順を追加」の位置の決め方（addHerePosition）', async (t) => {
  const b = await boot(t, []);
  const T = b.api;
  const c = checklist('c', 'template', twoPhases());
  assert.deepEqual(plain(T.addHerePosition(c, 'i1')), { sectionIndex: 0, itemIndex: 1, found: true });
  assert.deepEqual(plain(T.addHerePosition(c, 'i3')), { sectionIndex: 1, itemIndex: 1, found: true });
  assert.deepEqual(plain(T.addHerePosition(c, 'none')), { sectionIndex: 1, itemIndex: 1, found: false }, '見つからなければ最後');
  assert.deepEqual(plain(T.addHerePosition(c, null)), { sectionIndex: 1, itemIndex: 1, found: false });
  assert.deepEqual(plain(T.addHerePosition(checklist('e', 'template', []), 'i1')), { sectionIndex: -1, itemIndex: 0, found: false });
});

test('単体 HTML の書き出しも2段のメニューバーを持つ', async (t) => {
  const b = await boot(t, [checklist('c1', 'template', twoPhases())]);
  const full = b.api.buildStandaloneHtml(b.api.store.state.checklists[0]);
  const html = full.slice(full.indexOf('<div id="topbar">'), full.indexOf('<main id="app">')); // body のメニューバーだけ
  assert.ok(html.length > 0);
  assert.match(html, /<div class="topbar-brand-row">/);
  assert.match(html, /<div class="topbar-tools">/);
  assert.match(html, /class="tb-group tb-editor-main"/);
  assert.match(html, /class="tb-group tb-editor-add"/);
  assert.doesNotMatch(html, /data-action="record"/, '撮影・取り込みは今までどおり単体 HTML には無い');
});
