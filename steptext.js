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

module.exports = { normalizeUia, stepText, cleanLabel };
