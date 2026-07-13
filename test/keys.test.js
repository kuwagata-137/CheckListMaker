'use strict';
// keys.js（キーボードイベントの分類とコンボ組み立て 2-R2b）の単体テスト。
// キーコードは libuiohook の VC_ 値（uiohook-napi の UiohookKey と同値）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyKeydown, comboOf } = require('../keys');

// uiohook の keydown イベントを模す（フラグは既定ですべて false）
function ev(keycode, over = {}) {
  return { keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over };
}

const VC = {
  S: 31, A: 30, K: 37, Digit1: 2, Space: 57, Comma: 51, Numpad5: 76,
  Enter: 28, NumpadEnter: 3612, Tab: 15, Esc: 1, CapsLock: 58,
  Backspace: 14, Delete: 3667, ArrowLeft: 57419, Home: 3655,
  F2: 60, F4: 62, F5: 63,
  CtrlL: 29, CtrlR: 3613, AltL: 56, ShiftL: 42, MetaL: 3675,
};

test('comboOf — コンボ文字列の組み立て', async (t) => {
  await t.test('修飾の表示順は Ctrl → Alt → Shift → Win で固定', () => {
    assert.equal(
      comboOf(ev(VC.S, { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true })),
      'Ctrl+Alt+Shift+Win+S'
    );
  });
  await t.test('単純な Ctrl+S', () => {
    assert.equal(comboOf(ev(VC.S, { ctrlKey: true })), 'Ctrl+S');
  });
  await t.test('表に無いキーコードは null', () => {
    assert.equal(comboOf(ev(0x9999, { ctrlKey: true })), null);
  });
});

test('classifyKeydown — 操作種類の分類', async (t) => {
  await t.test('修飾キー単独は modifier（左右どちらも）', () => {
    for (const k of [VC.CtrlL, VC.CtrlR, VC.AltL, VC.ShiftL, VC.MetaL]) {
      assert.equal(classifyKeydown(ev(k)).type, 'modifier');
    }
    // Ctrl 押下中に届く Ctrl 自身の keydown も modifier のまま
    assert.equal(classifyKeydown(ev(VC.CtrlL, { ctrlKey: true })).type, 'modifier');
  });

  await t.test('Ctrl/Alt/Win を含むコンボは shortcut', () => {
    assert.deepEqual(classifyKeydown(ev(VC.S, { ctrlKey: true })), { type: 'shortcut', combo: 'Ctrl+S' });
    assert.deepEqual(classifyKeydown(ev(VC.K, { ctrlKey: true, shiftKey: true })), { type: 'shortcut', combo: 'Ctrl+Shift+K' });
    assert.deepEqual(classifyKeydown(ev(VC.F4, { altKey: true })), { type: 'shortcut', combo: 'Alt+F4' });
  });

  await t.test('コンボでも表に無いキーは other（記録しない）', () => {
    assert.equal(classifyKeydown(ev(0x9999, { ctrlKey: true })).type, 'other');
  });

  await t.test('単独ファンクションキーは shortcut（F5・F2）', () => {
    assert.deepEqual(classifyKeydown(ev(VC.F5)), { type: 'shortcut', combo: 'F5' });
    assert.deepEqual(classifyKeydown(ev(VC.F2)), { type: 'shortcut', combo: 'F2' });
  });

  await t.test('Enter / テンキー Enter は enter', () => {
    assert.deepEqual(classifyKeydown(ev(VC.Enter)), { type: 'enter', combo: 'Enter' });
    assert.deepEqual(classifyKeydown(ev(VC.NumpadEnter)), { type: 'enter', combo: 'Enter' });
  });

  await t.test('印字キーは typing（Shift のみの組み合わせを含む）', () => {
    for (const k of [VC.S, VC.Digit1, VC.Space, VC.Comma, VC.Numpad5]) {
      assert.equal(classifyKeydown(ev(k)).type, 'typing');
    }
    assert.equal(classifyKeydown(ev(VC.A, { shiftKey: true })).type, 'typing');
  });

  await t.test('編集キーは edit（バースト継続のみ・開始しない判定は呼び出し側）', () => {
    for (const k of [VC.Backspace, VC.Delete, VC.ArrowLeft, VC.Home]) {
      assert.equal(classifyKeydown(ev(k)).type, 'edit');
    }
  });

  await t.test('Tab 単独は tab・Esc / CapsLock は other', () => {
    assert.equal(classifyKeydown(ev(VC.Tab)).type, 'tab');
    assert.equal(classifyKeydown(ev(VC.Esc)).type, 'other');
    assert.equal(classifyKeydown(ev(VC.CapsLock)).type, 'other');
  });
});
