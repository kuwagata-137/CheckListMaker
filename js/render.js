// render.js — 状態を受け取り HTML 文字列を組み立てる純粋な描画関数。
// イベントは app.js 側で data-action による委譲で処理するため、ここでは付けない。

import { MODES, progress } from './model.js';

export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const modeLabel = (type) => (type === MODES.TEMPLATE ? 'テンプレート' : 'ToDo');

// ---- ホーム（一覧） ----

export function renderHome(state) {
  const { checklists } = state;
  const cards = checklists.length
    ? checklists.map((c) => renderCard(c)).join('')
    : `<p class="empty">まだチェックリストがありません。「新規作成」から始めましょう。</p>`;

  return `
    <section class="home">
      <div class="home-head">
        <h1>チェックリスト</h1>
        <div class="home-actions">
          <button class="btn primary" data-action="new">＋ 新規作成</button>
          <button class="btn" data-action="import">インポート</button>
          <button class="btn" data-action="export">エクスポート</button>
        </div>
      </div>
      <div class="cards">${cards}</div>
    </section>`;
}

function renderCard(c) {
  const p = progress(c);
  return `
    <article class="card" data-id="${c.id}">
      <button class="card-open" data-action="open" data-id="${c.id}">
        <span class="badge ${c.type}">${modeLabel(c.type)}</span>
        <h2>${escapeHtml(c.title)}</h2>
        <div class="progress"><div class="progress-bar" style="width:${p.percent}%"></div></div>
        <small>${p.done} / ${p.total} 完了（${p.percent}%）</small>
      </button>
      <div class="card-tools">
        <button class="icon" title="複製" data-action="duplicate" data-id="${c.id}">⧉</button>
        <button class="icon" title="名前変更" data-action="rename" data-id="${c.id}">✎</button>
        <button class="icon danger" title="削除" data-action="delete" data-id="${c.id}">🗑</button>
      </div>
    </article>`;
}

// ---- エディタ（1件の編集・利用画面） ----

export function renderEditor(checklist) {
  const p = progress(checklist);
  const isTemplate = checklist.type === MODES.TEMPLATE;

  const sections = checklist.sections
    .map((s, idx) => renderSection(s, p.sections[idx]))
    .join('');

  return `
    <section class="editor" data-id="${checklist.id}">
      <div class="editor-head">
        <button class="btn" data-action="home">← 一覧</button>
        <input class="title-input" data-action="edit-title"
               value="${escapeHtml(checklist.title)}" aria-label="タイトル" />
        <span class="badge ${checklist.type}">${modeLabel(checklist.type)}</span>
      </div>

      <div class="editor-progress">
        <div class="progress"><div class="progress-bar" style="width:${p.percent}%"></div></div>
        <small>${p.done} / ${p.total} 完了（${p.percent}%）</small>
      </div>

      <div class="editor-toolbar">
        <button class="btn" data-action="add-section">＋ セクション</button>
        ${
          isTemplate
            ? `<button class="btn" data-action="reset">↺ 一括リセット</button>`
            : `<button class="btn" data-action="clear-completed">完了を削除</button>`
        }
        <button class="btn" data-action="share">🔗 共有リンク</button>
      </div>

      <div class="sections">${sections}</div>
    </section>`;
}

function renderSection(section, prog) {
  const items = section.items.map((i) => renderItem(section.id, i)).join('');
  return `
    <div class="section" data-section="${section.id}" draggable="false">
      <div class="section-head" draggable="true" data-drag="section">
        <span class="grip" title="ドラッグで並べ替え">⠿</span>
        <input class="section-title" data-action="edit-section" data-section="${section.id}"
               placeholder="セクション名（任意）" value="${escapeHtml(section.title)}" />
        <small class="section-progress">${prog.done}/${prog.total}</small>
        <button class="icon danger" title="セクション削除"
                data-action="delete-section" data-section="${section.id}">🗑</button>
      </div>
      <ul class="items" data-section="${section.id}">${items}</ul>
      <form class="add-item" data-action="add-item" data-section="${section.id}">
        <input class="add-item-input" placeholder="項目を追加してEnter" aria-label="項目を追加" />
      </form>
    </div>`;
}

function renderItem(sectionId, item) {
  return `
    <li class="item ${item.done ? 'done' : ''}" data-item="${item.id}"
        data-section="${sectionId}" draggable="true" data-drag="item">
      <span class="grip" title="ドラッグで並べ替え">⠿</span>
      <input type="checkbox" ${item.done ? 'checked' : ''}
             data-action="toggle" data-section="${sectionId}" data-item="${item.id}" />
      <input class="item-text" data-action="edit-item"
             data-section="${sectionId}" data-item="${item.id}"
             value="${escapeHtml(item.text)}" />
      <button class="icon danger" title="削除"
              data-action="delete-item" data-section="${sectionId}" data-item="${item.id}">✕</button>
    </li>`;
}
