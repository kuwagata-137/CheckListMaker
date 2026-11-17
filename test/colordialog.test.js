'use strict';
// 「色の設定」画面（色パレットの［🎨 その他の色…］で開く。v1.0.14）の試験。
// 仕様は docs/spec-color-dialog.md。見た目・ドラッグの座標・画像編集画面からの操作は、実物の Electron で確認する。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor } = require('./harness');

const STORAGE_KEY = 'checklistmaker.v1';
const item = (id, text, body) => ({ id, text, done: false, note: '', time: '', body, images: [] });
const seedState = (body) => ({
  checklists: [{
    id: 't1', title: '色の設定', type: 'template', createdAt: 1, updatedAt: 1,
    sections: [{ id: 's1', title: '準備', items: [item('j1', '手順1', body)] }],
  }],
  settings: { theme: 'auto' },
});

async function boot(t, body = '<p>本文</p>', extraStorage = {}) {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState(body)), ...extraStorage } });
  t.after(() => app.close());
  const api = await app.api();
  const win = app.window, doc = app.document;
  const key = (target, k, init = {}) => {
    const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  const mouse = (target, type, init = {}) => {
    const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  const dlg = () => doc.getElementById('ocd-dlg');
  const q = (s) => dlg().querySelector(s);
  const bgOf = (sel) => api.ocdParseColor(q(sel).style.background || q(sel).style.backgroundColor);
  const setValue = (el, v, type = 'input') => { el.value = v; el.dispatchEvent(new win.Event(type, { bubbles: true })); };
  // 「色の設定」画面を開き、onOK・onCancel の呼び出しを記録する
  const open = (current) => {
    const calls = { ok: [], cancel: 0 };
    api.ocdOpen({ current, onOK: (c) => calls.ok.push(c), onCancel: () => { calls.cancel++; } });
    return calls;
  };
  return { app, api, win, doc, key, mouse, dlg, q, bgOf, setValue, open };
}

// 手順の本文（リッチ編集）を開き、文字範囲を選ぶ。
// 実機ではマウスで文字を選んだ時点で本文にフォーカスがある。jsdom はフォーカスのない本文へ focus() すると
// 選択を本文の先頭へ移すので、先にフォーカスを移してから選ぶ。
async function openBody(b) {
  b.win.location.hash = '#/c/t1';
  const editor = await waitFor(() => b.doc.querySelector('#app [data-rb-edit]'), { label: '手順の本文' });
  const select = (node, start, end) => {
    editor.focus();
    const r = b.doc.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    const sel = b.win.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  };
  const toolbarBtn = (cmd) => editor.closest('.rb').querySelector(`[data-rb-cmd="${cmd}"]`);
  return { editor, select, toolbarBtn };
}

test('色の変換 — ocdParseColor は 16 進・rgb()・rgba() を #RRGGBB にし、「なし」と読めない値は null', async (t) => {
  const { api } = await boot(t);
  assert.equal(api.ocdParseColor('#abc'), '#AABBCC');
  assert.equal(api.ocdParseColor('#a1B2c3'), '#A1B2C3');
  assert.equal(api.ocdParseColor('rgb(255, 0, 0)'), '#FF0000');
  assert.equal(api.ocdParseColor('rgba(51, 102, 153, 0.5)'), '#336699');
  assert.equal(api.ocdParseColor('rgb(10 20 30 / 50%)'), '#0A141E');
  for (const v of ['rgba(0, 0, 0, 0)', 'transparent', 'none', null, undefined, '', 'canvastext', '#12345']) {
    assert.equal(api.ocdParseColor(v), null, String(v));
  }
});

test('色の変換 — RGB → HSL → RGB で元の色に戻る（MDM と同じ式）', async (t) => {
  const { api } = await boot(t);
  // jsdom 側の配列は realm が違うので、展開してから比べる
  assert.deepEqual([...api.ocdRgbToHsl(255, 0, 0)], [0, 1, 0.5]);
  const [h, s, l] = api.ocdRgbToHsl(51, 102, 153);
  assert.ok(Math.abs(h - 210) < 1e-9 && Math.abs(s - 0.5) < 1e-9 && Math.abs(l - 0.4) < 1e-9);
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 51) {
      for (let bl = 0; bl <= 255; bl += 85) {
        assert.deepEqual([...api.ocdHslToRgb(...api.ocdRgbToHsl(r, g, bl))], [r, g, bl], `${r},${g},${bl}`);
      }
    }
  }
});

test('タブ「標準」の色見本 — 六角形 127 色（中心が白）と灰色 15 段（白から黒）', async (t) => {
  const { api } = await boot(t);
  const cells = api.ocdStandardCells();
  assert.equal(cells.length, 142);
  const hex = cells.slice(0, 127), gray = cells.slice(127);
  assert.equal(hex.find((p) => p.x === 0 && p.y === 0).c, '#FFFFFF', '中心は白');
  assert.equal(new Set(cells.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)).size, 142, '位置が重ならない');
  for (const p of hex) {
    const n = parseInt(p.c.slice(1), 16);
    for (const v of [(n >> 16) & 255, (n >> 8) & 255, n & 255]) assert.equal(v % 51, 0, `${p.c} は 51 刻み`);
  }
  assert.equal(gray[0].c, '#FFFFFF');
  assert.equal(gray[14].c, '#000000');
  gray.forEach((p) => assert.equal(p.c.slice(1, 3).repeat(3), p.c.slice(1), `${p.c} は灰色`));
});

test('画面構成 — 題・タブ・ボタンの並び、開いた時は「ユーザー設定」タブで［OK］にフォーカス', async (t) => {
  const b = await boot(t);
  b.open('#336699');
  const { q, dlg, doc } = b;
  assert.ok(dlg(), '画面が開く');
  assert.equal(q('.ocd-tt b').textContent, '色の設定');
  assert.equal(q('.ocd-box').getAttribute('role'), 'dialog');
  assert.deepEqual([...dlg().querySelectorAll('.ocd-tabs [data-t]')].map((d) => d.textContent), ['標準', 'ユーザー設定']);
  assert.equal(q('.ocd-tabs .on').textContent, 'ユーザー設定');
  assert.deepEqual([...dlg().querySelectorAll('.ocd-right .ocd-btn')].map((x) => x.textContent), ['OK', 'キャンセル'], 'OK が上');
  assert.equal(doc.activeElement, q('[data-a="ok"]'));
  assert.equal(q('.ocd-newcur').textContent, '新規現在');
  assert.equal(b.bgOf('.cu'), '#336699', '現在');
  assert.equal(b.bgOf('.nw'), '#336699', '開いた時の新規は現在と同じ');
  assert.deepEqual([...dlg().querySelectorAll('.ocd-n')].map((n) => n.value), ['51', '102', '153']);
  assert.equal(q('.ocd-hx').value, '#336699');
  assert.deepEqual([...dlg().querySelectorAll('.ocd-f label')].map((l) => l.textContent),
    ['カラー モデル(D):', '赤(R):', '緑(G):', '青(B):', '16 進(H):']);
  assert.equal(q('.ocd-alpha'), null, '透過性の行はない');
});

test('「現在」の色が分からない時と「なし」の時は白', async (t) => {
  const b = await boot(t);
  for (const v of [null, 'none', 'transparent', 'rgba(0, 0, 0, 0)', 'canvastext']) {
    b.open(v);
    assert.equal(b.bgOf('.cu'), '#FFFFFF', String(v));
    b.q('[data-a="cancel"]').click();
  }
});

test('［OK］は新規の色を返し、［キャンセル］・［✕］・Esc・背景のクリックは何も返さずに閉じる', async (t) => {
  const b = await boot(t);
  let calls = b.open('#336699');
  b.setValue(b.q('.ocd-hx'), '#00ff00');
  b.q('[data-a="ok"]').click();
  assert.deepEqual(calls.ok, ['#00FF00']);
  assert.equal(b.dlg(), null, '閉じる');

  const closers = {
    キャンセル: () => b.q('[data-a="cancel"]').click(),
    '✕': () => b.q('.ocd-x').click(),
    Esc: () => b.key(b.doc.activeElement, 'Escape'),
    背景: () => { b.mouse(b.q('.ocd-bg'), 'mousedown'); b.mouse(b.q('.ocd-bg'), 'click'); },
  };
  for (const [name, close] of Object.entries(closers)) {
    calls = b.open('#336699');
    b.setValue(b.q('.ocd-hx'), '#00ff00');
    close();
    assert.deepEqual(calls.ok, [], `${name}: 色を返さない`);
    assert.equal(calls.cancel, 1, `${name}: onCancel`);
    assert.equal(b.dlg(), null, `${name}: 閉じる`);
  }
});

test('背景は、押した所と離した所が背景の時だけ閉じる', async (t) => {
  const b = await boot(t);
  const calls = b.open('#336699');
  b.mouse(b.q('.ocd-bg'), 'click'); // 押した所は背景ではない（ボタンを押してから背景で離した場合など）
  assert.ok(b.dlg(), '閉じない');
  assert.equal(calls.cancel, 0);
});

test('Enter は OK（ボタン上と日本語入力の変換中は除く）', async (t) => {
  const b = await boot(t);
  let calls = b.open('#336699');
  b.q('.ocd-hx').focus();
  b.key(b.q('.ocd-hx'), 'Enter', { isComposing: true });
  assert.ok(b.dlg(), '変換中の Enter では閉じない');
  b.key(b.q('[data-a="cancel"]'), 'Enter');
  assert.ok(b.dlg(), '［キャンセル］上の Enter は、ボタンの既定の動作に任せる');
  b.key(b.q('.ocd-hx'), 'Enter');
  assert.deepEqual(calls.ok, ['#336699']);
  assert.equal(b.dlg(), null);
  calls = b.open('#336699');
  b.key(b.q('.ocd-model'), 'Enter');
  assert.deepEqual(calls.ok, ['#336699'], 'カラー モデルの欄でも OK');
});

test('キー操作は「色の設定」画面だけで処理し、後ろの画面へ届かない', async (t) => {
  const b = await boot(t);
  const seen = [];
  const onDoc = (e) => seen.push(e.key);
  b.doc.addEventListener('keydown', onDoc);
  b.doc.addEventListener('keydown', onDoc, true);
  t.after(() => { b.doc.removeEventListener('keydown', onDoc); b.doc.removeEventListener('keydown', onDoc, true); });
  b.open('#336699');
  const ok = b.q('[data-a="ok"]');
  for (const k of ['Delete', 'Backspace', 'ArrowLeft', 'a']) b.key(ok, k);
  // Ctrl＋Z・Ctrl＋Y は、アプリのメニュー（元に戻す・やり直す）を通して後ろの本文に効くので止める
  assert.ok(b.key(ok, 'z', { ctrlKey: true }).defaultPrevented, 'Ctrl＋Z を止める');
  assert.ok(b.key(b.q('.ocd-hx'), 'y', { ctrlKey: true }).defaultPrevented, '入力欄でも Ctrl＋Y を止める');
  assert.ok(b.key(ok, 'v', { ctrlKey: true }).defaultPrevented, '入力欄の外の貼り付けを止める');
  assert.equal(b.key(b.q('.ocd-hx'), 'v', { ctrlKey: true }).defaultPrevented, false, '入力欄の貼り付けは使える');
  assert.ok(b.key(ok, 'ArrowDown').defaultPrevented, 'ボタン上の矢印キーで後ろの画面をスクロールさせない');
  assert.equal(b.key(b.q('.ocd-n'), 'ArrowUp').defaultPrevented, false, '数値欄の矢印キーは欄の操作に使う');
  // フォーカスが後ろの画面に残っていた時も、文字を入れずに画面の中へ戻す
  const outside = b.doc.createElement('input');
  b.doc.body.appendChild(outside);
  outside.focus();
  assert.ok(b.key(outside, 'x').defaultPrevented);
  assert.equal(b.doc.activeElement, ok);
  b.key(ok, 'Escape');
  assert.deepEqual(seen, [], 'document の keydown は呼ばれない');
  assert.equal(b.dlg(), null);
  b.key(b.doc.body, 'Delete');
  assert.deepEqual(seen, ['Delete', 'Delete'], '閉じた後は届く');
});

test('Tab は画面の中だけを順に移り、Ctrl＋Tab でタブを切り替える', async (t) => {
  const b = await boot(t);
  b.open('#336699');
  const { q, doc } = b;
  const tab = (init = {}) => b.key(doc.activeElement, 'Tab', init); // フォーカスのある項目で押す
  assert.equal(doc.activeElement, q('[data-a="ok"]'));
  assert.ok(tab().defaultPrevented);
  assert.equal(doc.activeElement, q('[data-a="cancel"]'));
  tab();
  assert.equal(doc.activeElement, q('.ocd-model'), '最後の項目から最初の項目へ');
  tab();
  assert.equal(doc.activeElement, q('.ocd-n[data-i="0"]'));
  tab({ shiftKey: true });
  tab({ shiftKey: true });
  assert.equal(doc.activeElement, q('[data-a="cancel"]'), 'Shift＋Tab で最初の項目から最後の項目へ');
  q('.ocd-hx').focus();
  tab({ ctrlKey: true });
  assert.equal(q('.ocd-tabs .on').textContent, '標準');
  assert.equal(doc.activeElement, q('[data-a="ok"]'), '中身を作り直したら［OK］へ');
  tab();
  assert.equal(doc.activeElement, q('[data-a="cancel"]'));
  tab();
  assert.equal(doc.activeElement, q('[data-a="ok"]'), 'タブ「標準」では OK とキャンセルの 2 つ');
  tab({ ctrlKey: true });
  assert.equal(q('.ocd-tabs .on').textContent, 'ユーザー設定');
});

test('Alt＋下線の文字で、タブ「ユーザー設定」の項目へ移る', async (t) => {
  const b = await boot(t);
  b.open('#336699');
  const { q, doc } = b;
  const alt = (code) => b.key(doc.activeElement, code.slice(3).toLowerCase(), { altKey: true, code });
  assert.ok(alt('KeyG').defaultPrevented);
  assert.equal(doc.activeElement, q('.ocd-n[data-i="1"]'), 'G: 緑');
  alt('KeyH');
  assert.equal(doc.activeElement, q('.ocd-hx'), 'H: 16 進');
  alt('KeyD');
  assert.equal(doc.activeElement, q('.ocd-model'), 'D: カラー モデル');
  b.setValue(q('.ocd-model'), 'HSL', 'change');
  alt('KeyU');
  assert.equal(doc.activeElement, q('.ocd-n[data-i="0"]'), 'HSL では U: 色合い');
  assert.equal(alt('KeyR').defaultPrevented, false, 'HSL では R は使わない');
});

test('数値欄・16 進・カラー モデルは互いに反映する', async (t) => {
  const b = await boot(t);
  b.open('#336699');
  const { q, dlg } = b;
  const ns = () => [...dlg().querySelectorAll('.ocd-n')];
  b.setValue(ns()[0], '255');
  assert.equal(q('.ocd-hx').value, '#FF6699');
  assert.equal(b.bgOf('.nw'), '#FF6699', '新規の見本');
  b.setValue(q('.ocd-hx'), 'abcdef');
  assert.deepEqual(ns().map((n) => n.value), ['171', '205', '239'], '# なしの 16 進も読む');
  assert.equal(q('.ocd-hx').value, 'abcdef', '入力中の欄は書き換えない');
  b.setValue(q('.ocd-hx'), 'abcdef', 'change');
  assert.equal(q('.ocd-hx').value, '#ABCDEF', '欄を離れた時にそろえる');
  b.setValue(q('.ocd-hx'), '#12', 'input');
  assert.equal(b.bgOf('.nw'), '#ABCDEF', '6 桁でない間は反映しない');
  b.setValue(ns()[1], '300');
  assert.equal(q('.ocd-hx').value, '#ABFFEF', '0〜255 に収める');
  assert.equal(ns()[1].value, '300', '入力中は書き換えない');
  ns()[1].dispatchEvent(new b.win.Event('change', { bubbles: true }));
  assert.equal(ns()[1].value, '255', '欄を離れた時に 255 を表示する');

  b.setValue(q('.ocd-hx'), '#336699');
  b.setValue(q('.ocd-model'), 'HSL', 'change');
  assert.deepEqual([...dlg().querySelectorAll('.ocd-f label')].map((l) => l.textContent),
    ['カラー モデル(D):', '色合い(U):', '鮮やかさ(S):', '明るさ(L):', '16 進(H):']);
  // 色合い 210°・鮮やかさ 50%・明るさ 40% を 0〜255 で表示する（鮮やかさは 127.5 の丸めなので ±1 まで許す）
  ns().map((n) => Number(n.value)).forEach((v, i) => assert.ok(Math.abs(v - [149, 127.5, 102][i]) <= 1, `${i}: ${v}`));
  b.setValue(ns()[2], '255');
  assert.equal(q('.ocd-hx').value, '#FFFFFF', '明るさ 255 は白');
  b.setValue(ns()[2], '0');
  assert.equal(q('.ocd-hx').value, '#000000', '明るさ 0 は黒');
});

test('色の面と明るさのバーのドラッグ', async (t) => {
  const b = await boot(t);
  const calls = b.open('#FFFFFF');
  const { q } = b;
  const rect = (el, w, h) => { el.getBoundingClientRect = () => ({ left: 10, top: 20, width: w, height: h, right: 10 + w, bottom: 20 + h }); };
  rect(q('.ocd-field'), 200, 100);
  rect(q('.ocd-lum'), 14, 100);
  b.mouse(q('.ocd-field'), 'mousedown', { clientX: 110, clientY: 20 });
  assert.equal(q('.ocd-hx').value, '#00FFFF', '中央・上（色合い 180°・鮮やかさ 100%）。白からは明るさ 50%');
  b.mouse(b.doc, 'mousemove', { clientX: -50, clientY: 500 });
  assert.equal(q('.ocd-hx').value, '#808080', '外へ出ても端の値（色合い 0°・鮮やかさ 0%）');
  b.mouse(b.doc, 'mouseup');
  b.mouse(b.doc, 'mousemove', { clientX: 110, clientY: 20 });
  assert.equal(q('.ocd-hx').value, '#808080', '離した後は動かない');
  b.mouse(q('.ocd-field'), 'mousedown', { clientX: 10, clientY: 20 });
  b.mouse(b.doc, 'mouseup');
  assert.equal(q('.ocd-hx').value, '#FF0000');
  b.mouse(q('.ocd-lum'), 'mousedown', { clientX: 15, clientY: 45 });
  b.mouse(b.doc, 'mouseup');
  assert.equal(q('.ocd-hx').value, '#FF8080', '明るさ 75%');
  assert.equal(q('.ocd-lum i').style.top, '25%');
  q('[data-a="ok"]').click();
  assert.deepEqual(calls.ok, ['#FF8080']);
});

test('タブ「標準」 — 今の色に選択枠、クリックで選び、ダブルクリックで決定する', async (t) => {
  const b = await boot(t);
  const calls = b.open('#FFFFFF');
  const { q, dlg } = b;
  b.mouse(q('.ocd-tabs [data-t="std"]'), 'click');
  const cells = [...dlg().querySelectorAll('.ocd-hex .hx')];
  assert.equal(cells.length, 142);
  const center = cells.find((p) => p.dataset.c === '#FFFFFF');
  assert.equal(q('.hxsel').getAttribute('d'), center.getAttribute('d'), '白に選択枠');
  // 同じ色の六角形が 2 つあると選択枠は先の方に付くので、1 つしかない色で試す
  const unique = cells.filter((p) => cells.filter((x) => x.dataset.c === p.dataset.c).length === 1);
  const pick = unique[20], pick2 = unique[unique.length - 1];
  b.mouse(pick, 'click');
  assert.equal(b.bgOf('.nw'), pick.dataset.c);
  assert.equal(q('.hxsel').getAttribute('d'), pick.getAttribute('d'));
  assert.ok(b.dlg(), 'クリックでは閉じない');
  b.mouse(q('.ocd-tabs [data-t="custom"]'), 'click');
  assert.equal(q('.ocd-hx').value, pick.dataset.c, 'タブを替えても色は同じ');
  b.mouse(q('.ocd-tabs [data-t="std"]'), 'click');
  assert.equal(q('.hxsel').getAttribute('d'), pick.getAttribute('d'), '戻った時も選択枠');
  const again = [...dlg().querySelectorAll('.ocd-hex .hx')].find((p) => p.dataset.c === pick2.dataset.c);
  b.mouse(again, 'dblclick');
  assert.deepEqual(calls.ok, [pick2.dataset.c]);
  assert.equal(b.dlg(), null);
});

test('画面の上のホイールで、後ろの画面をスクロールさせない', async (t) => {
  const b = await boot(t);
  b.open('#336699');
  const ev = new b.win.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
  b.q('.ocd-pane').dispatchEvent(ev);
  assert.ok(ev.defaultPrevented);
});

test('手順の本文のセル塗りつぶし — ［🎨 その他の色…］で開き、［OK］の色がセルに付いて保存される', async (t) => {
  const b = await boot(t, '<table class="rb-table"><thead><tr><th>項目</th><th>値</th></tr></thead>' +
    '<tbody><tr><td>A</td><td style="background-color: rgb(255, 255, 0)">B</td></tr></tbody></table>');
  const { editor, select, toolbarBtn } = await openBody(b);
  const [td1, td2] = editor.querySelectorAll('td');
  select(td2.firstChild, 0, 1);
  b.mouse(toolbarBtn('cellFill'), 'mousedown');
  const more = b.doc.querySelector('#rb-palette .op-more');
  assert.ok(more, '色パレットが開く');
  assert.equal(b.doc.querySelector('#rb-palette input[type="color"]'), null, 'OS の色ダイアログは使わない');
  assert.ok(b.mouse(more, 'mousedown').defaultPrevented, '押した時は本文のフォーカスと選択を残す');
  assert.equal(b.dlg(), null, '押しただけでは開かない');
  more.click();
  assert.equal(b.doc.getElementById('rb-palette'), null, '色パレットは閉じる');
  assert.ok(b.dlg(), '「色の設定」画面が開く');
  assert.equal(b.bgOf('.cu'), '#FFFF00', '現在はセルの背景色');
  b.q('[data-a="cancel"]').click();

  select(td1.firstChild, 0, 1);
  b.mouse(toolbarBtn('cellFill'), 'mousedown');
  b.doc.querySelector('#rb-palette .op-more').click();
  assert.equal(b.bgOf('.cu'), '#FFFFFF', '背景がなければ白');
  b.win.getSelection().removeAllRanges(); // 画面へフォーカスが移って選択が外れた時と同じ状態にする
  b.setValue(b.q('.ocd-hx'), '#00FF00');
  b.q('[data-a="ok"]').click();
  assert.equal(td1.style.backgroundColor, 'rgb(0, 255, 0)', '開く前に選んでいたセルに付く');
  const body = b.api.store.state.checklists[0].sections[0].items[0].body;
  assert.match(body, /background-color: ?(rgb\(0, ?255, ?0\)|#00ff00)/i, '保存される');
});

test('手順の本文の文字色 — ［OK］では選んでいた文字範囲を戻してから色を付け、［キャンセル］では付けない', async (t) => {
  const b = await boot(t, '<p>赤い文字にする</p>');
  const { editor, select, toolbarBtn } = await openBody(b);
  const calls = [];
  b.doc.execCommand = (cmd, ui, val) => { calls.push([cmd, val, String(b.win.getSelection())]); return true; };
  const text = editor.querySelector('p').firstChild;

  select(text, 0, 2);
  b.mouse(toolbarBtn('foreColor'), 'mousedown');
  b.doc.querySelector('#rb-palette .op-more').click();
  b.win.getSelection().removeAllRanges();
  b.q('[data-a="cancel"]').click();
  assert.deepEqual(calls.filter((c) => c[0] === 'foreColor'), [], '［キャンセル］では色を付けない');
  assert.equal(String(b.win.getSelection()), '赤い', '［キャンセル］でも文字範囲を戻す');

  select(text, 0, 2);
  b.mouse(toolbarBtn('foreColor'), 'mousedown');
  b.doc.querySelector('#rb-palette .op-more').click();
  b.win.getSelection().removeAllRanges();
  b.setValue(b.q('.ocd-hx'), '#C00000');
  b.key(b.q('.ocd-hx'), 'Enter');
  assert.deepEqual(calls.filter((c) => c[0] === 'foreColor'), [['foreColor', '#C00000', '赤い']], 'Enter（OK）で、戻した範囲に付ける');
});

test('手順の本文のハイライト — 「現在」はハイライトの色。付けていなければ白', async (t) => {
  const b = await boot(t, '<p><span style="background-color: rgb(255, 255, 0);">黄色</span>と白</p>');
  const { editor, select, toolbarBtn } = await openBody(b);
  const calls = [];
  b.doc.execCommand = (cmd, ui, val) => { calls.push([cmd, val]); return true; };
  select(editor.querySelector('span').firstChild, 0, 1);
  assert.equal(b.api.rbSelectionColor(editor, 'highlight'), 'rgb(255, 255, 0)');
  b.mouse(toolbarBtn('hiliteColor'), 'mousedown');
  b.doc.querySelector('#rb-palette .op-more').click();
  assert.equal(b.bgOf('.cu'), '#FFFF00');
  b.q('[data-a="ok"]').click();
  assert.deepEqual(calls.filter((c) => c[0] === 'hiliteColor'), [['hiliteColor', '#FFFF00']]);

  const plain = editor.querySelector('p').lastChild; // 「と白」
  select(plain, 0, 1);
  assert.equal(b.api.rbSelectionColor(editor, 'highlight'), null);
  b.mouse(toolbarBtn('hiliteColor'), 'mousedown');
  b.doc.querySelector('#rb-palette .op-more').click();
  assert.equal(b.bgOf('.cu'), '#FFFFFF');
  b.key(b.doc.activeElement, 'Escape');
  assert.equal(b.dlg(), null);
});

test('rbOpenPalette — opts.current の色を「現在」に表示し、［OK］で onPick を呼ぶ（画像編集画面と同じ呼び方）', async (t) => {
  const b = await boot(t);
  const btn = b.doc.createElement('button');
  b.doc.body.appendChild(btn);
  btn.focus();
  const picked = [];
  b.api.rbOpenPalette(btn, true, (c) => picked.push(c), '線なし', { current: () => '#ff3b30' });
  assert.equal(b.doc.querySelector('#rb-palette .op-none').textContent, '線なし');
  b.doc.querySelector('#rb-palette .op-more').click();
  assert.equal(b.bgOf('.cu'), '#FF3B30');
  b.setValue(b.q('.ocd-hx'), '#123456');
  b.q('[data-a="ok"]').click();
  assert.deepEqual(picked, ['#123456']);
  assert.equal(b.doc.activeElement, btn, '閉じた後は、開く前のフォーカスへ戻す');
});

// ---- 最近使用した色（docs/spec-color-dialog.md 8 章。質問 Q2 の回答） ----
const RECENT_KEY = 'checklistmaker.recentColors';
// 色パレットを開く・「色の設定」画面で色を決める・「最近使用した色」の行を読む
function paletteHelpers(b) {
  const btn = b.doc.createElement('button');
  b.doc.body.appendChild(btn);
  const picked = [];
  const openPalette = () => {
    b.api.rbOpenPalette(btn, true, (c) => picked.push(c), undefined, { current: '#336699' });
    return b.doc.getElementById('rb-palette');
  };
  const titles = () => [...openPalette().querySelectorAll('.op-title')].map((x) => x.textContent);
  const recentRow = () => {
    const head = [...openPalette().querySelectorAll('.op-title')].find((x) => x.textContent === '最近使用した色');
    return head ? [...head.nextElementSibling.querySelectorAll('.op-swatch')].map((s) => s.title) : null;
  };
  const decide = (hex) => {
    openPalette().querySelector('.op-more').click();
    b.setValue(b.q('.ocd-hx'), hex);
    b.q('[data-a="ok"]').click();
  };
  const stored = () => b.win.localStorage.getItem(RECENT_KEY);
  return { btn, picked, openPalette, titles, recentRow, decide, stored };
}

test('最近使用した色 — 1 色目を決めるまでは表示せず、決めた色を「標準の色」の下に新しい順で表示する', async (t) => {
  const b = await boot(t);
  const p = paletteHelpers(b);
  assert.deepEqual(p.titles(), ['テーマの色', '標準の色'], '1 色目を決めるまでは見出しも行もない');
  assert.equal(p.recentRow(), null);
  p.decide('#112233');
  assert.deepEqual(p.titles(), ['テーマの色', '標準の色', '最近使用した色'], '見出しは「標準の色」の下');
  assert.deepEqual(p.recentRow(), ['#112233']);
  p.decide('#445566');
  p.decide('#112233');
  assert.deepEqual(p.recentRow(), ['#112233', '#445566'], '決め直した色は先頭へ移す');
  for (let i = 0; i < 12; i++) p.decide('#0000' + (16 + i).toString(16).toUpperCase());
  const row = p.recentRow();
  assert.equal(row.length, 10, '10 色まで');
  assert.equal(row[0], '#00001B', '先頭が最後に決めた色');
  assert.equal(row[9], '#000012');
  assert.deepEqual(JSON.parse(p.stored()), row, 'localStorage の別のキーに保存する');
  const state = b.win.localStorage.getItem(STORAGE_KEY);
  assert.ok(!/#00001B|recentColors/i.test(state), '手順書データには入れない');
});

test('最近使用した色 — Enter と六角形のダブルクリックで決めた時も記録し、［キャンセル］では記録しない', async (t) => {
  const b = await boot(t);
  const p = paletteHelpers(b);
  b.open('#336699');
  b.key(b.q('.ocd-hx'), 'Enter');
  b.open('#FFFFFF');
  b.mouse(b.q('.ocd-tabs [data-t="std"]'), 'click');
  const black = [...b.dlg().querySelectorAll('.ocd-hex .hx')].find((x) => x.dataset.c === '#000000');
  b.mouse(black, 'dblclick');
  assert.deepEqual(p.recentRow(), ['#000000', '#336699']);
  b.open('#ABCDEF');
  b.setValue(b.q('.ocd-hx'), '#FEDCBA');
  b.q('[data-a="cancel"]').click();
  b.open('#ABCDEF');
  b.key(b.doc.activeElement, 'Escape');
  assert.deepEqual(p.recentRow(), ['#000000', '#336699'], '［キャンセル］・Esc では記録しない');
});

test('最近使用した色 — 開き直しても残り、行の色見本は onPick で色を反映する。色見本・「なし」・行の色見本では記録しない', async (t) => {
  // アプリを開き直した時と同じく、localStorage に保存済みの状態で起動する
  const b = await boot(t, '<p>本文</p>', { [RECENT_KEY]: JSON.stringify(['#ABCDEF', '#123456']) });
  const p = paletteHelpers(b);
  assert.deepEqual(p.recentRow(), ['#ABCDEF', '#123456'], '開き直しても行が残る');
  const before = p.stored();
  b.mouse(p.openPalette().querySelector('.op-row .op-swatch'), 'mousedown'); // テーマの色の左上
  b.mouse(p.openPalette().querySelector('.op-none'), 'mousedown');
  const head = [...p.openPalette().querySelectorAll('.op-title')].find((x) => x.textContent === '最近使用した色');
  b.mouse(head.nextElementSibling.querySelectorAll('.op-swatch')[1], 'mousedown');
  assert.deepEqual(p.picked, ['#FFFFFF', 'none', '#123456'], '行の色見本は、ほかの色見本と同じく onPick で反映する');
  assert.equal(b.doc.getElementById('rb-palette'), null, '色見本を押すと色パレットは閉じる');
  assert.equal(p.stored(), before, '色見本・「なし」・行の色見本では記録しない（順番も変えない）');
});

test('最近使用した色 — 保存した値が読めない時は行を表示せず、localStorage に書けなくても色は決まる', async (t) => {
  const b = await boot(t, '<p>本文</p>', { [RECENT_KEY]: '{壊れた値' });
  const p = paletteHelpers(b);
  assert.deepEqual(p.titles(), ['テーマの色', '標準の色'], '読めない値では行を表示しない');
  b.win.localStorage.setItem(RECENT_KEY, JSON.stringify(['#zzz', 5, '#abcdef', null]));
  assert.deepEqual(p.recentRow(), ['#ABCDEF'], '色として読める値だけを表示する');
  const proto = b.win.Storage.prototype, orig = proto.setItem;
  proto.setItem = function () { throw new Error('容量不足'); };
  try {
    const calls = b.open('#336699');
    b.q('[data-a="ok"]').click();
    assert.deepEqual(calls.ok, ['#336699'], '書けなくても［OK］の色は返す');
  } finally {
    proto.setItem = orig;
  }
  assert.deepEqual(p.recentRow(), ['#ABCDEF']);
});
