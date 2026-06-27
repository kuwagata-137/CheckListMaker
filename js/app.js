// app.js — エントリポイント。ストア・ルーター・描画・イベントを結線する。

import { LocalStorageAdapter, Store } from './storage.js';
import * as M from './model.js';
import { renderHome, renderEditor } from './render.js';
import { attachDragAndDrop } from './dragdrop.js';
import {
  exportStateToFile,
  readStateFromFile,
  encodeShareLink,
  readShareFromHash,
} from './io.js';
import { parseHash, goHome, goEditor, startRouter } from './router.js';

const store = new Store(new LocalStorageAdapter());
const app = document.getElementById('app');
const fileInput = document.getElementById('file-input');

// ---- テーマ ----
function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const cur = store.state.settings.theme || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  store.commit((s) => (s.settings.theme = next), { history: false });
  applyTheme(next);
}

// ---- 描画 ----
function render() {
  const route = parseHash();
  if (route.name === 'editor') {
    const checklist = M.findChecklist(store.state, route.id);
    if (!checklist) {
      goHome();
      return;
    }
    app.innerHTML = renderEditor(checklist);
    attachDragAndDrop(app, handleMove);
  } else {
    app.innerHTML = renderHome(store.state);
  }
  updateTopbar();
}

function updateTopbar() {
  document.querySelector('[data-action="undo"]').disabled = !store.canUndo();
  document.querySelector('[data-action="redo"]').disabled = !store.canRedo();
}

// 現在編集中のチェックリスト（エディタ画面のとき）
function currentChecklist() {
  const route = parseHash();
  return route.name === 'editor' ? M.findChecklist(store.state, route.id) : null;
}

// ---- ドラッグ&ドロップ確定 ----
function handleMove(move) {
  const c = currentChecklist();
  if (!c) return;
  if (move.kind === 'item') {
    store.commit((s) => {
      const cc = M.findChecklist(s, c.id);
      M.moveItem(cc, move.fromSection, move.itemId, move.toSection, move.toIndex);
    });
  } else if (move.kind === 'section') {
    store.commit((s) => {
      const cc = M.findChecklist(s, c.id);
      M.moveSection(cc, move.sectionId, move.toIndex);
    });
  }
}

// ---- 新規作成ダイアログ ----
function openNewDialog() {
  const overlay = buildModal(`
    <h3>新しいチェックリスト</h3>
    <p>使い方に合わせて種類を選んでください。</p>
    <div class="mode-choices">
      <button class="mode-card" data-mode="template">
        <strong>テンプレート型</strong>
        <span>点検表・持ち物・手順など、繰り返し使う。チェック後に一括リセットして再利用。</span>
      </button>
      <button class="mode-card" data-mode="todo">
        <strong>ToDo型</strong>
        <span>その都度追加して消化する使い捨てのリスト。</span>
      </button>
    </div>
    <label class="field">タイトル
      <input class="new-title" placeholder="（後で変更できます）" />
    </label>
    <div class="modal-actions">
      <button class="btn" data-close>キャンセル</button>
    </div>
  `);
  overlay.querySelectorAll('.mode-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      const title = overlay.querySelector('.new-title').value.trim();
      const checklist = M.createChecklist(mode, title);
      store.commit((s) => M.addChecklist(s, checklist));
      closeModal(overlay);
      goEditor(checklist.id);
    });
  });
}

// ---- 共有リンクダイアログ ----
function openShareDialog(checklist) {
  const { url, length } = encodeShareLink(checklist);
  const warn =
    length > 2000
      ? `<p class="warn">⚠ リンクが長い（${length}文字）ため一部の環境で開けない場合があります。大きなリストはエクスポート(JSON)での共有を推奨します。</p>`
      : '';
  const overlay = buildModal(`
    <h3>共有リンク</h3>
    <p>このリンクを開くと、相手の端末にこのチェックリストを取り込めます（サーバー不要）。</p>
    <textarea class="share-url" readonly rows="4">${url}</textarea>
    ${warn}
    <div class="modal-actions">
      <button class="btn primary" data-copy>コピー</button>
      <button class="btn" data-close>閉じる</button>
    </div>
  `);
  const ta = overlay.querySelector('.share-url');
  overlay.querySelector('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      ta.select();
      document.execCommand('copy');
    }
    overlay.querySelector('[data-copy]').textContent = 'コピーしました ✓';
  });
}

// ---- 共有データの取り込み（#share=...） ----
function maybeImportShare() {
  const route = parseHash();
  if (route.name !== 'share') return false;
  const checklist = readShareFromHash();
  if (!checklist) {
    goHome();
    return true;
  }
  const ok = confirm(`「${checklist.title}」を取り込みますか？`);
  if (ok) {
    // ID重複を避けて新規IDで取り込む
    const copy = JSON.parse(JSON.stringify(checklist));
    copy.id = M.createChecklist().id;
    copy.createdAt = copy.updatedAt = Date.now();
    store.commit((s) => M.addChecklist(s, copy));
    goEditor(copy.id);
  } else {
    goHome();
  }
  return true;
}

// ---- モーダル基盤 ----
function buildModal(innerHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.hasAttribute('data-close')) closeModal(overlay);
  });
  return overlay;
}
function closeModal(overlay) {
  overlay.remove();
}

// ---- イベント委譲 ----

// クリック系
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const sectionId = btn.dataset.section;
  const itemId = btn.dataset.item;
  const c = currentChecklist();

  switch (action) {
    case 'undo': return store.undo();
    case 'redo': return store.redo();
    case 'theme': return cycleTheme();
    case 'home': return goHome();
    case 'new': return openNewDialog();
    case 'open': return goEditor(id);
    case 'import': return fileInput.click();
    case 'export': return exportStateToFile(store.state);

    case 'duplicate':
      return store.commit((s) => M.duplicateChecklist(s, id));
    case 'rename': {
      const cur = M.findChecklist(store.state, id);
      const title = prompt('新しい名前', cur ? cur.title : '');
      if (title != null) store.commit((s) => M.renameChecklist(M.findChecklist(s, id), title));
      return;
    }
    case 'delete': {
      const cur = M.findChecklist(store.state, id);
      if (confirm(`「${cur ? cur.title : ''}」を削除しますか？`))
        store.commit((s) => M.removeChecklist(s, id));
      return;
    }

    // --- エディタ内 ---
    case 'add-section':
      return c && store.commit((s) => M.addSection(M.findChecklist(s, c.id)));
    case 'delete-section':
      return c && store.commit((s) => M.removeSection(M.findChecklist(s, c.id), sectionId));
    case 'delete-item':
      return c && store.commit((s) => M.removeItem(M.findChecklist(s, c.id), sectionId, itemId));
    case 'reset':
      if (c && confirm('すべての項目を未完了に戻します。よろしいですか？'))
        store.commit((s) => M.resetChecklist(M.findChecklist(s, c.id)));
      return;
    case 'clear-completed':
      return c && store.commit((s) => M.clearCompleted(M.findChecklist(s, c.id)));
    case 'share':
      return c && openShareDialog(c);
  }
});

// チェックボックスのトグル
document.addEventListener('change', (e) => {
  const el = e.target;
  const c = currentChecklist();
  if (el.matches('[data-action="toggle"]') && c) {
    store.commit((s) =>
      M.toggleItem(M.findChecklist(s, c.id), el.dataset.section, el.dataset.item)
    );
  }
});

// テキスト編集（フォーカスを失った時に確定）
document.addEventListener('change', (e) => {
  const el = e.target;
  const c = currentChecklist();
  if (!c) return;
  if (el.matches('[data-action="edit-title"]')) {
    store.commit((s) => M.renameChecklist(M.findChecklist(s, c.id), el.value));
  } else if (el.matches('[data-action="edit-section"]')) {
    store.commit((s) => M.renameSection(M.findChecklist(s, c.id), el.dataset.section, el.value));
  } else if (el.matches('[data-action="edit-item"]')) {
    store.commit((s) =>
      M.editItem(M.findChecklist(s, c.id), el.dataset.section, el.dataset.item, el.value)
    );
  }
});

// 項目追加フォーム（Enterで送信）
document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-action="add-item"]');
  if (!form) return;
  e.preventDefault();
  const c = currentChecklist();
  if (!c) return;
  const input = form.querySelector('.add-item-input');
  const text = input.value;
  const sectionId = form.dataset.section;
  if (!text.trim()) return;
  pendingFocusSection = sectionId; // 追加後に同じ入力欄へ再フォーカス
  store.commit((s) => M.addItem(M.findChecklist(s, c.id), sectionId, text));
});

// 追加後のフォーカス復帰（連続入力を快適にする）
let pendingFocusSection = null;
function restoreFocus() {
  if (!pendingFocusSection) return;
  const input = app.querySelector(
    `.add-item[data-section="${pendingFocusSection}"] .add-item-input`
  );
  pendingFocusSection = null;
  if (input) input.focus();
}

// ファイルインポート
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const data = await readStateFromFile(file);
    if (confirm('現在のデータを、読み込んだ内容で置き換えます。よろしいですか？')) {
      store.replaceState(data);
      goHome();
    }
  } catch (err) {
    alert(err.message);
  }
});

// ---- 起動 ----
store.subscribe(() => {
  render();
  restoreFocus();
});

applyTheme(store.state.settings.theme || 'auto');

// ルーティング開始。共有リンクで来た場合は取り込みフローを先に処理。
startRouter(() => {
  if (maybeImportShare()) return;
  render();
});
