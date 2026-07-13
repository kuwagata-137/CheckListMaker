// steptext.js — テンプレート文法による手順文の決定的生成（ロードマップ 2-R2）
// UIA の解決結果（uia-host.js の返信）から「『保存』ボタンをクリック」のような
// 日本語の手順文を生成する。AI不要・オフライン・幻覚なし。
//
// 純関数のみ（fs・Electron 非依存）。文面の一覧と生成規則は
// docs/spec-2-R2-uia-steptext.md 参照。文面の変更はこのファイルとテストだけで完結する。
'use strict';

const NAME_MAX = 40; // 手順文に埋め込む要素名の最大長（超過は「…」省略）

// 要素名・ウィンドウタイトルの正規化: 改行/連続空白を1つに・トリム・長すぎは省略。
function cleanLabel(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > NAME_MAX ? t.slice(0, NAME_MAX) + '…' : t;
}

// 「要素は取れたがコンテナ止まり」の種類。名前がウィンドウタイトル相当になるため
// 要素名として使わず、フォールバック文へ倒す（RemoteApp 業務システムが該当。2-R0 発見①）。
const CONTAINER_TYPES = new Set(['Window', 'Pane', 'Document', 'TitleBar']);

// Excel のセル番地（「B5」「AB12」等）。DataItem のセル特化文に使う。
const CELL_RE = /^[A-Z]{1,3}[0-9]{1,7}$/;

function isExcel(appName) {
  return /excel/i.test(String(appName || ''));
}

// UIA 解決結果（uia-host.js の返信 or null）→ サイドカーの uia オブジェクト（スキーマ v2）。
// 解決なし（null・失敗・タイムアウト）は resolved: false・各項目 null の形に揃える。
function normalizeUia(raw) {
  if (!raw || !raw.ok) {
    return {
      resolved: false,
      name: null,
      controlType: null,
      localizedType: null,
      className: null,
      frameworkId: null,
      rect: null,
      windowTitle: (raw && raw.windowTitle) || null,
      appName: (raw && raw.appName) || null,
      elapsedMs: raw && typeof raw.elapsedMs === 'number' ? raw.elapsedMs : null,
    };
  }
  return {
    resolved: true,
    name: raw.name || null,
    controlType: raw.controlTypeName || (raw.controlType ? String(raw.controlType) : null),
    localizedType: raw.localizedType || null,
    className: raw.className || null,
    frameworkId: raw.frameworkId || null,
    rect: Array.isArray(raw.rect) ? raw.rect : null,
    windowTitle: raw.windowTitle || null,
    appName: raw.appName || null,
    elapsedMs: typeof raw.elapsedMs === 'number' ? raw.elapsedMs : null,
  };
}

// フォールバック文: ウィンドウ「◯◯」内の図の位置をクリック（右クリック版あり）。
// 「図の位置」= 撮影画像のクリックマーカー（画像とセットで読む前提の文言）。
function fallbackText(windowTitle, clickWord) {
  const wt = cleanLabel(windowTitle);
  return wt ? `ウィンドウ「${wt}」内の図の位置を${clickWord}` : `図の位置を${clickWord}`;
}

// 手順文の生成。uia は normalizeUia 済みのオブジェクト、opts.button は 'left' | 'right'。
function stepText(uia, opts = {}) {
  const right = opts.button === 'right';
  const clickWord = right ? '右クリック' : 'クリック';
  const u = uia || {};
  const name = cleanLabel(u.name);
  const type = u.controlType || '';

  if (!u.resolved || !name || CONTAINER_TYPES.has(type)) {
    return fallbackText(u.windowTitle, clickWord);
  }
  // 右クリックは種類を問わず「対象を右クリック」（コンテキストメニューを開く操作）。
  if (right) return `「${name}」を右クリック`;

  switch (type) {
    case 'Button':
    case 'SplitButton':
      return `「${name}」ボタンをクリック`;
    case 'TabItem':
      return `「${name}」タブを選択`;
    case 'MenuItem':
      return `メニューから「${name}」を選択`;
    case 'CheckBox':
      return `「${name}」にチェック`;
    case 'RadioButton':
    case 'ListItem':
    case 'TreeItem':
      return `「${name}」を選択`;
    case 'ComboBox':
      return `「${name}」を開く`;
    case 'Edit':
      // クリック時点で分かるのは「欄を選んだ」ことまで。入力の検出は R2b で
      // 「『◯◯』に入力」へ昇格する（spec のスコープ境界参照）。
      return `「${name}」欄をクリック`;
    case 'Hyperlink':
      return `リンク「${name}」をクリック`;
    case 'DataItem':
      // Excel はセル番地が名前で取れる（2-R0 実測）。セル特化の文にする。
      if (isExcel(u.appName) && CELL_RE.test(name)) return `セル「${name}」をクリック`;
      return `「${name}」を選択`;
    default:
      // Text / Image / Group / Custom など。名前が取れていれば汎用文で十分読める。
      return `「${name}」をクリック`;
  }
}

// ── 2-R2b: 操作種類の拡張（ダブルクリック・入力・キー・ドラッグ）──
// 仕様は docs/spec-2-R2b-input-ops.md 参照。

// 対象の要素名が文に使えるか（クリック系と同じ判定）。
function usableName(uia) {
  const u = uia || {};
  const name = cleanLabel(u.name);
  if (!u.resolved || !name || CONTAINER_TYPES.has(u.controlType || '')) return null;
  return name;
}

// ダブルクリック文（①）。種類別テンプレートは使わず一律「ダブルクリック」
//（clicks >= 2 は一律この文言。実クリック数はサイドカーに残る）。
function dblClickText(uia) {
  const u = uia || {};
  const name = usableName(u);
  if (!name) return fallbackText(u.windowTitle, 'ダブルクリック');
  if (u.controlType === 'DataItem' && isExcel(u.appName) && CELL_RE.test(name)) {
    return `セル「${name}」をダブルクリック`;
  }
  return `「${name}」をダブルクリック`;
}

// 文字入力文（②）。uia はフォーカス要素の解決結果。入力内容は文に含めない
//（そもそも記録しない）。opts.enter = Enter で確定したか。
// フォーカス要素は Document（Word 本文・メモ帳等）でも入力対象として意味を持つため、
// コンテナ判定から Document を除いた集合で判定する。
const INPUT_CONTAINER_TYPES = new Set(['Window', 'Pane', 'TitleBar']);
function inputText(uia, opts = {}) {
  const u = uia || {};
  const suffix = opts.enter ? 'して Enter' : '';
  const name = cleanLabel(u.name);
  if (u.resolved && name && !INPUT_CONTAINER_TYPES.has(u.controlType || '')) {
    return `「${name}」欄に入力${suffix}`;
  }
  const wt = cleanLabel(u.windowTitle);
  return wt ? `ウィンドウ「${wt}」内で文字を入力${suffix}` : `文字を入力${suffix}`;
}

// キー操作文（③）。combo は keys.js の "Ctrl+S" 形式。既知の操作は名前で言い切る。
const SHORTCUT_ACTIONS = {
  'Ctrl+S': '保存', 'Ctrl+C': 'コピー', 'Ctrl+V': '貼り付け', 'Ctrl+X': '切り取り',
  'Ctrl+Z': '元に戻す', 'Ctrl+Y': 'やり直し', 'Ctrl+P': '印刷', 'Ctrl+F': '検索',
  'Ctrl+A': 'すべて選択', 'Ctrl+N': '新規作成', 'Ctrl+O': '開く', 'Ctrl+W': '閉じる',
  'Alt+F4': 'ウィンドウを閉じる', F5: '更新', F2: '名前の変更',
};
function keyStepText(combo) {
  const c = String(combo || '');
  const action = SHORTCUT_ACTIONS[c];
  if (action) return `${c} で${action}`;
  return c ? `${c} キーを押す` : 'キーを押す';
}

// ドラッグ文（④）。startUia / endUia は始点・終点それぞれの解決結果。
function dragText(startUia, endUia) {
  const from = usableName(startUia);
  const to = usableName(endUia);
  if (from && to) return `「${from}」から「${to}」へドラッグ`;
  if (from) return `「${from}」から図の終点位置へドラッグ`;
  if (to) return `図の始点位置から「${to}」へドラッグ`;
  const wt = cleanLabel((startUia || {}).windowTitle);
  return wt
    ? `ウィンドウ「${wt}」内の図の始点から終点へドラッグ`
    : `図の始点から終点へドラッグ`;
}

// CONTAINER_TYPES は zoomcrop.js（2-R3）が矩形の採用判定で同じ集合を使う。
module.exports = {
  normalizeUia, stepText, cleanLabel, CONTAINER_TYPES,
  dblClickText, inputText, keyStepText, dragText,
};
