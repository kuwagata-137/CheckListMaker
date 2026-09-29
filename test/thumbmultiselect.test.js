'use strict';
// サムネイルの複数選択（まとめて削除・移動）と Ctrl+Z のテスト（v1.0.8 作業1）。
// 仕様は docs/spec-thumbnail-multiselect.md 参照。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, PX_JPEG } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));
const STORAGE_KEY = 'checklistmaker.v1';

// フェーズ2つ・手順4つ（i4 は文が空）のテンプレート
const seedState = (type = 'template') => ({
  checklists: [{
    id: 'c1', title: 'サーバー点検', type, createdAt: 1, updatedAt: 1,
    sections: [
      { id: 's1', title: '準備', items: [
        { id: 'i1', text: '共有フォルダを開く', done: false, note: '', time: '', body: '', images: [PX_JPEG] },
        { id: 'i2', text: '設定ダイアログを開く', done: false, note: '', time: '', body: '', images: [] },
      ] },
      { id: 's2', title: '確認', items: [
        { id: 'i3', text: '疎通を確認する', done: false, note: '', time: '', body: '', images: [] },
        { id: 'i4', text: '', done: false, note: '', time: '', body: '', images: [] },
      ] },
    ],
  }],
  settings: { theme: 'auto' },
});

// エディタ画面を開き、サイドバーが出るまで待つ。confirm は呼ばれた文言を記録して answer を返す。
async function openEditor(t, type) {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState(type)) } });
  t.after(() => app.close());
  const T = await app.api();
  app.window.location.hash = '#/c/c1';
  await waitFor(() => app.document.querySelector('#thumbs .tsb-card'), { label: 'サイドバー' });
  const confirms = [];
  const ctl = { answer: true };
  app.window.confirm = (m) => { confirms.push(m); return ctl.answer; };
  const doc = app.document;
  const win = app.window;
  const thumbs = doc.getElementById('thumbs');
  const card = (id) => doc.querySelector(`#thumbs .tsb-card[data-item="${id}"]`);
  const click = (el, mods = {}) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
  const key = (el, k, mods = {}) => {
    const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
    el.dispatchEvent(ev);
    return ev;
  };
  const order = () => plain(T.store.state.checklists[0].sections.map((s) => s.items.map((i) => i.id)));
  const selected = () => [...doc.querySelectorAll('#thumbs .tsb-card.is-selected')].map((c) => c.dataset.item);
  return { app, T, doc, win, thumbs, card, click, key, order, selected, confirms, ctl };
}

// ドラッグのイベント（jsdom には DataTransfer が無いので最小の代わりを付ける）
function dragEvent(win, type, clientY = 0) {
  const ev = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { effectAllowed: '', dropEffect: '', setData() {}, getData() { return ''; }, setDragImage() {}, types: [] },
  });
  Object.defineProperty(ev, 'clientY', { value: clientY });
  return ev;
}
// ⠿ を掴んで target の上（clientY=0＝上半分）か下（1＝下半分）に落とす。jsdom は矩形が 0 なので
// 中点は 0。clientY 1 が「下半分＝後ろへ」、0 が「上半分＝前へ」になる。
function dragCard(ctx, fromId, toEl, clientY) {
  const { win, card } = ctx;
  const src = card(fromId);
  src.querySelector('.tsb-grip').dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  src.dispatchEvent(dragEvent(win, 'dragstart'));
  toEl.dispatchEvent(dragEvent(win, 'dragover', clientY));
  toEl.dispatchEvent(dragEvent(win, 'drop', clientY));
}

test('thumbmultiselect — 選択の決め方（nextThumbSelection）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const order = ['i1', 'i2', 'i3', 'i4'];
  const next = (sel, anchor, target, mods) => plain(T.nextThumbSelection(order, sel, anchor, target, mods));

  await t.test('クリックはその1枚だけ（起点になる）', () => {
    assert.deepEqual(next(['i1', 'i3'], 'i1', 'i2', {}), { sel: ['i2'], anchor: 'i2' });
  });
  await t.test('Ctrl+クリックは足す／外す（起点はそのカード）', () => {
    assert.deepEqual(next(['i2'], 'i2', 'i4', { ctrl: true }), { sel: ['i2', 'i4'], anchor: 'i4' });
    assert.deepEqual(next(['i2', 'i4'], 'i4', 'i2', { ctrl: true }), { sel: ['i4'], anchor: 'i2' });
  });
  await t.test('Shift+クリックは起点からの範囲（逆向きも。起点は変えない）', () => {
    assert.deepEqual(next(['i2'], 'i2', 'i4', { shift: true }), { sel: ['i2', 'i3', 'i4'], anchor: 'i2' });
    assert.deepEqual(next(['i3'], 'i3', 'i1', { shift: true }), { sel: ['i1', 'i2', 'i3'], anchor: 'i3' });
  });
  await t.test('Ctrl+Shift+クリックは範囲を足す', () => {
    assert.deepEqual(next(['i1', 'i3'], 'i3', 'i4', { ctrl: true, shift: true }), { sel: ['i1', 'i3', 'i4'], anchor: 'i3' });
  });
  await t.test('起点が無い Shift+クリックはクリックと同じ。知らない手順は何もしない', () => {
    assert.deepEqual(next([], null, 'i3', { shift: true }), { sel: ['i3'], anchor: 'i3' });
    assert.deepEqual(next(['i1'], 'i1', 'x9', { ctrl: true }), { sel: ['i1'], anchor: 'i1' });
  });
});

test('thumbmultiselect — まとめて動かす・消す（M.moveItems / M.removeItems）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const fixture = () => ({ sections: [
    { id: 's1', items: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }] },
    { id: 's2', items: [{ id: 'i4' }] },
  ] });
  const ids = (c) => c.sections.map((s) => s.items.map((i) => i.id));

  await t.test('既存の不具合の再現：M.moveItem は「動かす前の位置」で渡すと1つ下に入る', () => {
    const c = fixture();
    T.M.moveItem(c, 's1', 'i1', 's1', 2); // i3 の上（表示上の位置 2）に落としたつもり
    assert.deepEqual(ids(c)[0], ['i2', 'i3', 'i1'], 'i3 の下に入ってしまう（これが不具合）');
  });
  await t.test('M.moveItems は表示上の位置で受け取る（i1 を i3 の上へ → i2, i1, i3）', () => {
    const c = fixture();
    T.M.moveItems(c, ['i1'], 's1', 2);
    assert.deepEqual(ids(c), [['i2', 'i1', 'i3'], ['i4']]);
  });
  await t.test('複数・フェーズをまたいで、番号順に固まる', () => {
    const c = fixture();
    T.M.moveItems(c, ['i3', 'i1'], 's2', 0);
    assert.deepEqual(ids(c), [['i2'], ['i1', 'i3', 'i4']]);
  });
  await t.test('その場に落としたら並びは変わらない', () => {
    for (const at of [0, 1]) {
      const c = fixture();
      T.M.moveItems(c, ['i1'], 's1', at);
      assert.deepEqual(ids(c)[0], ['i1', 'i2', 'i3'], `位置 ${at}`);
    }
  });
  await t.test('前へまとめて動かす', () => {
    const c = fixture();
    T.M.moveItems(c, ['i2', 'i3'], 's1', 0);
    assert.deepEqual(ids(c)[0], ['i2', 'i3', 'i1']);
  });
  await t.test('M.removeItems はフェーズをまたいで消す', () => {
    const c = fixture();
    T.M.removeItems(c, ['i1', 'i4']);
    assert.deepEqual(ids(c), [['i2', 'i3'], []]);
  });
});

test('thumbmultiselect — クリックで選ぶ（画面）', async (t) => {
  await t.test('Ctrl+クリックで2件選ぶと、選択バーが出て番号が塗られる', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i1'), { ctrlKey: true });
    c.click(c.card('i3'), { ctrlKey: true });
    assert.deepEqual(c.selected(), ['i1', 'i3']);
    assert.ok(c.thumbs.classList.contains('has-multi'), '#thumbs.has-multi');
    const bar = c.doc.querySelector('#thumbs .tsb-selbar');
    assert.ok(bar && !bar.hidden, '選択バーが出る');
    assert.match(bar.textContent, /2件選択中/);
  });
  await t.test('クリックのあと Shift+クリックで範囲（フェーズをまたぐ）', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i1'));
    c.click(c.card('i4'), { shiftKey: true });
    assert.deepEqual(c.selected(), ['i1', 'i2', 'i3', 'i4']);
  });
  await t.test('Esc と空白クリックで選択を外す', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i1'), { ctrlKey: true });
    c.click(c.card('i2'), { ctrlKey: true });
    c.key(c.thumbs, 'Escape');
    assert.deepEqual(c.selected(), []);
    c.click(c.card('i3'), { ctrlKey: true });
    c.click(c.card('i4'), { ctrlKey: true });
    c.click(c.doc.querySelector('#thumbs .tsb-scroll'));
    assert.deepEqual(c.selected(), [], '空白クリック');
  });
  await t.test('Ctrl+A で全部選ぶ', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i2'), { ctrlKey: true });
    c.key(c.thumbs, 'a', { ctrlKey: true });
    assert.deepEqual(c.selected(), ['i1', 'i2', 'i3', 'i4']);
  });
  await t.test('本文の手順にフォーカスが入ると、選択はその1件に戻る', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i1'), { ctrlKey: true });
    c.click(c.card('i3'), { ctrlKey: true });
    c.doc.querySelector('#app .item[data-item="i2"] .item-text').focus();
    assert.deepEqual(c.selected(), ['i2']);
    assert.ok(!c.thumbs.classList.contains('has-multi'));
  });
});

test('thumbmultiselect — 削除（1件でも確認・Ctrl+Z 1回で戻る）', async (t) => {
  await t.test('2件選んで Delete → 確認 → まとめて消え、元に戻す1回で全部戻る', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i1'), { ctrlKey: true });
    c.click(c.card('i3'), { ctrlKey: true });
    c.key(c.thumbs, 'Delete');
    assert.deepEqual(c.confirms, ['選択した 2 件の手順を削除しますか？']);
    assert.deepEqual(c.order(), [['i2'], ['i4']]);
    const toast = c.doc.querySelector('#toast-host .toast');
    assert.ok(toast && /2件の手順を削除しました（Ctrl\+Z で元に戻せます）/.test(toast.textContent), '削除の通知');
    c.T.store.undo();
    assert.deepEqual(c.order(), [['i1', 'i2'], ['i3', 'i4']], '元に戻す1回で全部戻る');
  });
  await t.test('1件でも確認する。いいえなら消さない', async (t) => {
    const c = await openEditor(t);
    c.ctl.answer = false;
    c.click(c.card('i2'), { ctrlKey: true });
    c.key(c.thumbs, 'Delete');
    assert.deepEqual(c.confirms, ['手順 2「設定ダイアログを開く」を削除しますか？']);
    assert.deepEqual(c.order(), [['i1', 'i2'], ['i3', 'i4']]);
  });
  await t.test('カードの ✕ も確認してからその1件だけ消す（文が空なら（未入力））', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i1'), { ctrlKey: true });
    c.click(c.card('i4').querySelector('[data-action="delete-item"]'));
    assert.deepEqual(c.confirms, ['手順 4「（未入力）」を削除しますか？']);
    assert.deepEqual(c.order(), [['i1', 'i2'], ['i3']], '選択中の i1 は消さない');
  });
  await t.test('本文の削除ボタンは今までどおり確認なし', async (t) => {
    const c = await openEditor(t);
    c.click(c.doc.querySelector('#app .item[data-item="i2"] [data-action="delete-item"]'));
    assert.deepEqual(c.confirms, []);
    assert.deepEqual(c.order(), [['i1'], ['i3', 'i4']]);
  });
  await t.test('選択バーの［削除］と［選択解除］', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i1'), { ctrlKey: true });
    c.click(c.card('i2'), { ctrlKey: true });
    c.click(c.doc.querySelector('#thumbs .tsb-selbar [data-action="thumbs-clear-selection"]'));
    assert.deepEqual(c.selected(), []);
    c.click(c.card('i3'), { ctrlKey: true });
    c.click(c.card('i4'), { ctrlKey: true });
    c.click(c.doc.querySelector('#thumbs .tsb-selbar [data-action="thumbs-delete-selected"]'));
    assert.deepEqual(c.confirms, ['選択した 2 件の手順を削除しますか？']);
    assert.deepEqual(c.order(), [['i1', 'i2'], []]);
  });
  await t.test('ToDo 型は「項目」', async (t) => {
    const c = await openEditor(t, 'todo');
    c.click(c.card('i1'), { ctrlKey: true });
    c.click(c.card('i2'), { ctrlKey: true });
    c.key(c.thumbs, 'Delete');
    assert.deepEqual(c.confirms, ['選択した 2 件の項目を削除しますか？']);
  });
});

test('thumbmultiselect — まとめてドラッグ・ドロップ後の片づけ', async (t) => {
  await t.test('選択中のカードを掴むと、選んだ手順がまとめて番号順に移り、選択は残る（元に戻す1回で戻る）', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i1'), { ctrlKey: true });
    c.click(c.card('i2'), { ctrlKey: true });
    dragCard(c, 'i2', c.card('i4'), 1); // i4 の下半分へ
    assert.deepEqual(c.order(), [[], ['i3', 'i4', 'i1', 'i2']]);
    assert.deepEqual(c.selected(), ['i1', 'i2'], '移動後も選択を残す');
    c.T.store.undo();
    assert.deepEqual(c.order(), [['i1', 'i2'], ['i3', 'i4']]);
  });
  await t.test('選択していないカードを掴むと、その1件だけ', async (t) => {
    const c = await openEditor(t);
    c.click(c.card('i1'), { ctrlKey: true });
    c.click(c.card('i2'), { ctrlKey: true });
    dragCard(c, 'i4', c.card('i1'), 0); // i1 の上半分へ
    assert.deepEqual(c.order(), [['i4', 'i1', 'i2'], ['i3']]);
  });
  await t.test('ドロップの後、ドラッグを始めずに別のドロップが来ても動かない（状態が残らない）', async (t) => {
    const c = await openEditor(t);
    dragCard(c, 'i1', c.card('i4'), 1);
    const after = c.order();
    c.card('i3').dispatchEvent(dragEvent(c.win, 'dragover', 0));
    c.card('i3').dispatchEvent(dragEvent(c.win, 'drop', 0));
    assert.deepEqual(c.order(), after);
  });
  await t.test('本文でも、すぐ下の手順の上に落としたら動かない（1つ下に入る不具合の修正）', async (t) => {
    const c = await openEditor(t);
    const undoBefore = c.T.store.canUndo();
    const src = c.doc.querySelector('#app .item[data-item="i1"]');
    const grip = src.querySelector('.grip, .step-rail');
    grip.dispatchEvent(new c.win.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    src.dispatchEvent(dragEvent(c.win, 'dragstart'));
    const target = c.doc.querySelector('#app .item[data-item="i2"]');
    target.dispatchEvent(dragEvent(c.win, 'dragover', 0));
    target.dispatchEvent(dragEvent(c.win, 'drop', 0));
    assert.deepEqual(c.order(), [['i1', 'i2'], ['i3', 'i4']]);
    assert.equal(c.T.store.canUndo(), undoBefore, '位置が変わらないドロップはコミットしない');
  });
});

test('thumbmultiselect — Ctrl+Z／Ctrl+Y をアプリの元に戻す・やり直しに', async (t) => {
  await t.test('入力欄の外なら Ctrl+Z で元に戻り、Ctrl+Y でやり直す', async (t) => {
    const c = await openEditor(t);
    c.click(c.doc.querySelector('#app .item[data-item="i2"] [data-action="delete-item"]'));
    assert.deepEqual(c.order(), [['i1'], ['i3', 'i4']]);
    const ev = c.key(c.doc.body, 'z', { ctrlKey: true });
    assert.ok(ev.defaultPrevented);
    assert.deepEqual(c.order(), [['i1', 'i2'], ['i3', 'i4']]);
    c.key(c.doc.body, 'y', { ctrlKey: true });
    assert.deepEqual(c.order(), [['i1'], ['i3', 'i4']]);
    c.key(c.doc.body, 'Z', { ctrlKey: true, shiftKey: true });
    assert.deepEqual(c.order(), [['i1'], ['i3', 'i4']], 'やり直す先が無ければそのまま');
  });
  await t.test('入力欄の中では横取りしない（文字の取り消しはブラウザに任せる）', async (t) => {
    const c = await openEditor(t);
    c.click(c.doc.querySelector('#app .item[data-item="i2"] [data-action="delete-item"]'));
    const input = c.doc.querySelector('#app .item[data-item="i1"] .item-text');
    const ev = c.key(input, 'z', { ctrlKey: true });
    assert.ok(!ev.defaultPrevented);
    assert.deepEqual(c.order(), [['i1'], ['i3', 'i4']]);
  });
});
