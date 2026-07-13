// keys.js — キーボードイベントの分類とコンボ組み立て（ロードマップ 2-R2b）
// uiohook の keydown イベント（keycode＋modifier フラグ）を、録画エンジンが扱う
// 操作種類（文字入力・Enter・ショートカット等）へ分類する。
//
// 純関数のみ（uiohook-napi・Electron 非依存）。キーコード値は libuiohook の
// VC_ 定数（uiohook-napi の UiohookKey と同値）を自前の表として持つ。実行時に
// uiohook-napi を import しないのは、テストをネイティブモジュール非依存に
// 保つため。仕様は docs/spec-2-R2b-input-ops.md 参照。
'use strict';

// ── キーコード → 表示名（ショートカット文用）────────────────
// libuiohook uiohook.h の VC_ 値（uiohook-napi v1.5 の UiohookKey と同値）。
const KEY_LABELS = {
  1: 'Esc', 14: 'Backspace', 15: 'Tab', 28: 'Enter', 57: 'Space', 58: 'CapsLock',
  3612: 'Enter', // NumpadEnter
  3657: 'PageUp', 3665: 'PageDown', 3663: 'End', 3655: 'Home',
  57419: '←', 57416: '↑', 57421: '→', 57424: '↓',
  3666: 'Insert', 3667: 'Delete',
  // 数字（上段）
  2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
  // 英字
  30: 'A', 48: 'B', 46: 'C', 32: 'D', 18: 'E', 33: 'F', 34: 'G', 35: 'H', 23: 'I',
  36: 'J', 37: 'K', 38: 'L', 50: 'M', 49: 'N', 24: 'O', 25: 'P', 16: 'Q', 19: 'R',
  31: 'S', 20: 'T', 22: 'U', 47: 'V', 17: 'W', 45: 'X', 21: 'Y', 44: 'Z',
  // 記号
  12: '-', 13: '=', 26: '[', 27: ']', 39: ';', 40: "'", 41: '`', 43: '\\',
  51: ',', 52: '.', 53: '/',
  // テンキー
  82: '0', 79: '1', 80: '2', 81: '3', 75: '4', 76: '5', 77: '6', 71: '7', 72: '8', 73: '9',
  55: '*', 78: '+', 74: '-', 83: '.', 3637: '/',
  // ファンクション
  59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6', 65: 'F7', 66: 'F8',
  67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12',
};

// 修飾キー（単独では操作にならない）。左右どちらも。
const MODIFIER_KEYS = new Set([
  29, 3613, // Ctrl L/R
  56, 3640, // Alt L/R
  42, 54, // Shift L/R
  3675, 3676, // Meta(Win) L/R
]);

// 印字キー＝タイピングバーストを開始するキー（文字・数字・記号・スペース・テンキー）。
const TYPING_KEYS = new Set([
  57, // Space
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, // 数字（上段）
  30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44, // 英字
  12, 13, 26, 27, 39, 40, 41, 43, 51, 52, 53, // 記号
  82, 79, 80, 81, 75, 76, 77, 71, 72, 73, 55, 78, 74, 83, 3637, // テンキー
]);

// 編集キー＝バースト中なら入力の続きとみなす（開始はしない）。
const EDITING_KEYS = new Set([
  14, 3667, // Backspace / Delete
  57419, 57416, 57421, 57424, // 矢印
  3655, 3663, 3657, 3665, 3666, // Home / End / PageUp / PageDown / Insert
]);

const ENTER_KEYS = new Set([28, 3612]); // Enter / NumpadEnter
const FUNCTION_KEYS = new Set([59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88]);
const TAB_KEY = 15;

// modifier フラグ＋キーから "Ctrl+Shift+S" 形式のコンボ文字列を組み立てる。
// 表示順は Ctrl → Alt → Shift → Win で固定。表に無いキーは null（コンボにしない）。
function comboOf(e) {
  const label = KEY_LABELS[e.keycode];
  if (!label) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Win');
  parts.push(label);
  return parts.join('+');
}

// keydown イベント1件の分類。戻り値 { type, combo? }:
//   'modifier' … 修飾キー単独（無視）
//   'shortcut' … Ctrl/Alt/Win を含むコンボ、または単独ファンクションキー（combo 付き）
//   'enter'    … Enter 単独（バースト中は入力の確定、それ以外は combo:"Enter" のキーステップ）
//   'tab'      … Tab 単独（バーストの確定のみ。ステップにはしない）
//   'typing'   … 印字キー（バースト開始/継続）。Shift のみの組み合わせを含む
//   'edit'     … 編集キー（バースト中の継続のみ）
//   'other'    … 上記以外（Esc・CapsLock 等。無視）
function classifyKeydown(e) {
  if (MODIFIER_KEYS.has(e.keycode)) return { type: 'modifier' };
  if (e.ctrlKey || e.altKey || e.metaKey) {
    const combo = comboOf(e);
    return combo ? { type: 'shortcut', combo } : { type: 'other' };
  }
  if (ENTER_KEYS.has(e.keycode)) return { type: 'enter', combo: 'Enter' };
  if (FUNCTION_KEYS.has(e.keycode)) {
    // 単独 F キー（F5 更新・F2 名前の変更など）はショートカットとして扱う。
    // Shift+F キーも同様（comboOf が Shift を付ける）。
    return { type: 'shortcut', combo: comboOf(e) };
  }
  if (e.keycode === TAB_KEY) return { type: 'tab' };
  if (TYPING_KEYS.has(e.keycode)) return { type: 'typing' };
  if (EDITING_KEYS.has(e.keycode)) return { type: 'edit' };
  return { type: 'other' };
}

module.exports = { classifyKeydown, comboOf, KEY_LABELS };
