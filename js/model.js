// model.js — チェックリストのデータモデルと純粋な操作関数。
// 状態を引数に取り、新しい状態（または値）を返す副作用のない関数群。
// 永続化やDOMには一切触れない。

const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

export const MODES = {
  TEMPLATE: 'template', // 繰り返し使う点検表など（チェック→一括リセットで再利用）
  TODO: 'todo',         // その都度追加して消化する使い捨て
};

// ---- ファクトリ ----

export function createItem(text = '') {
  return { id: uid(), text, done: false, note: '' };
}

export function createSection(title = '') {
  return { id: uid(), title, items: [] };
}

export function createChecklist(type = MODES.TODO, title = '') {
  const now = Date.now();
  return {
    id: uid(),
    title: title || (type === MODES.TEMPLATE ? '新しいテンプレート' : '新しいリスト'),
    type,
    sections: [createSection('')], // 既定で1セクション（タイトル空＝見出しなし扱い）
    createdAt: now,
    updatedAt: now,
  };
}

export function createInitialState() {
  return {
    checklists: [],
    settings: { theme: 'auto' }, // 'auto' | 'light' | 'dark'
  };
}

// ---- 取得ヘルパー ----

export const findChecklist = (state, id) =>
  state.checklists.find((c) => c.id === id) || null;

const findSection = (checklist, sectionId) =>
  checklist.sections.find((s) => s.id === sectionId) || null;

// 進捗集計（全体 + セクション別）
export function progress(checklist) {
  let total = 0;
  let done = 0;
  const sections = checklist.sections.map((s) => {
    const t = s.items.length;
    const d = s.items.filter((i) => i.done).length;
    total += t;
    done += d;
    return { id: s.id, total: t, done: d, percent: t ? Math.round((d / t) * 100) : 0 };
  });
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0, sections };
}

// ---- 変更操作 ----
// すべて checklist を直接書き換える（呼び出し側が store.commit でスナップショット管理する前提）。
// updatedAt を更新して返す。

function touch(checklist) {
  checklist.updatedAt = Date.now();
  return checklist;
}

export function addChecklist(state, checklist) {
  state.checklists.unshift(checklist);
  return state;
}

export function removeChecklist(state, id) {
  state.checklists = state.checklists.filter((c) => c.id !== id);
  return state;
}

export function duplicateChecklist(state, id) {
  const src = findChecklist(state, id);
  if (!src) return state;
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  copy.title = src.title + '（コピー）';
  copy.createdAt = copy.updatedAt = Date.now();
  // 内部IDも振り直す
  copy.sections.forEach((s) => {
    s.id = uid();
    s.items.forEach((i) => (i.id = uid()));
  });
  const idx = state.checklists.findIndex((c) => c.id === id);
  state.checklists.splice(idx + 1, 0, copy);
  return state;
}

export function renameChecklist(checklist, title) {
  checklist.title = title;
  return touch(checklist);
}

export function addSection(checklist, title = '') {
  checklist.sections.push(createSection(title));
  return touch(checklist);
}

export function renameSection(checklist, sectionId, title) {
  const s = findSection(checklist, sectionId);
  if (s) s.title = title;
  return touch(checklist);
}

export function removeSection(checklist, sectionId) {
  checklist.sections = checklist.sections.filter((s) => s.id !== sectionId);
  if (checklist.sections.length === 0) checklist.sections.push(createSection(''));
  return touch(checklist);
}

export function addItem(checklist, sectionId, text) {
  const s = findSection(checklist, sectionId);
  if (s && text.trim()) s.items.push(createItem(text.trim()));
  return touch(checklist);
}

export function editItem(checklist, sectionId, itemId, text) {
  const s = findSection(checklist, sectionId);
  const i = s && s.items.find((x) => x.id === itemId);
  if (i) i.text = text;
  return touch(checklist);
}

export function toggleItem(checklist, sectionId, itemId) {
  const s = findSection(checklist, sectionId);
  const i = s && s.items.find((x) => x.id === itemId);
  if (i) i.done = !i.done;
  return touch(checklist);
}

export function removeItem(checklist, sectionId, itemId) {
  const s = findSection(checklist, sectionId);
  if (s) s.items = s.items.filter((x) => x.id !== itemId);
  return touch(checklist);
}

// テンプレート再利用：全項目を未完了に戻す
export function resetChecklist(checklist) {
  checklist.sections.forEach((s) => s.items.forEach((i) => (i.done = false)));
  return touch(checklist);
}

// 完了済みを一括削除（ToDo型向け）
export function clearCompleted(checklist) {
  checklist.sections.forEach((s) => (s.items = s.items.filter((i) => !i.done)));
  return touch(checklist);
}

// ---- 並べ替え（Drag & Drop から呼ばれる） ----

// 項目を移動：fromSection の itemId を toSection の toIndex に挿入
export function moveItem(checklist, fromSectionId, itemId, toSectionId, toIndex) {
  const from = findSection(checklist, fromSectionId);
  const to = findSection(checklist, toSectionId);
  if (!from || !to) return checklist;
  const idx = from.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return checklist;
  const [item] = from.items.splice(idx, 1);
  const insertAt = Math.max(0, Math.min(toIndex, to.items.length));
  to.items.splice(insertAt, 0, item);
  return touch(checklist);
}

// セクションを並べ替え
export function moveSection(checklist, sectionId, toIndex) {
  const idx = checklist.sections.findIndex((s) => s.id === sectionId);
  if (idx < 0) return checklist;
  const [sec] = checklist.sections.splice(idx, 1);
  const insertAt = Math.max(0, Math.min(toIndex, checklist.sections.length));
  checklist.sections.splice(insertAt, 0, sec);
  return touch(checklist);
}
