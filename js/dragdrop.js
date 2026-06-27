// dragdrop.js — エディタ内のセクション/項目のドラッグ&ドロップ並べ替え。
// ネイティブ HTML5 Drag and Drop を使い、ドロップ確定時に onMove コールバックへ
// 並べ替え内容を通知する（実際の状態変更とstore.commitは app.js 側が行う）。

// container: エディタのルート要素
// onMove: ({ kind, itemId, fromSection, toSection, toIndex }) を受け取る
//   kind === 'item'    → 項目移動
//   kind === 'section' → セクション移動（toIndex のみ使用）
export function attachDragAndDrop(container, onMove) {
  let dragging = null; // { kind, id, fromSection }

  container.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[data-drag]');
    if (!el) return;
    const kind = el.dataset.drag;
    if (kind === 'item') {
      const li = el.closest('.item');
      dragging = { kind, id: li.dataset.item, fromSection: li.dataset.section };
    } else if (kind === 'section') {
      const sec = el.closest('.section');
      dragging = { kind, id: sec.dataset.section, fromSection: null };
    }
    e.dataTransfer.effectAllowed = 'move';
    // Firefox はデータ設定が無いと dragstart を発火しない
    e.dataTransfer.setData('text/plain', dragging ? dragging.id : '');
    requestAnimationFrame(() => el.closest('.item, .section')?.classList.add('dragging'));
  });

  container.addEventListener('dragend', () => {
    container.querySelectorAll('.dragging, .drop-target')
      .forEach((n) => n.classList.remove('dragging', 'drop-target'));
    dragging = null;
  });

  container.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = dragging.kind === 'item'
      ? e.target.closest('.item, .items, .section')
      : e.target.closest('.section');
    container.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    if (target) target.classList.add('drop-target');
  });

  container.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();

    if (dragging.kind === 'item') {
      const overItem = e.target.closest('.item');
      const overList = e.target.closest('.items');
      let toSection;
      let toIndex;

      if (overItem) {
        toSection = overItem.dataset.section;
        const siblings = [...overItem.parentElement.querySelectorAll('.item')];
        toIndex = siblings.indexOf(overItem);
        // 自分より後ろの要素上に落ちたら、その位置（後ろ）に挿入されるよう補正
        const rect = overItem.getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) toIndex += 1;
      } else if (overList) {
        toSection = overList.dataset.section;
        toIndex = overList.querySelectorAll('.item').length; // 末尾
      } else {
        return;
      }

      onMove({
        kind: 'item',
        itemId: dragging.id,
        fromSection: dragging.fromSection,
        toSection,
        toIndex,
      });
    } else if (dragging.kind === 'section') {
      const overSection = e.target.closest('.section');
      if (!overSection || overSection.dataset.section === dragging.id) return;
      const sections = [...container.querySelectorAll('.section')];
      let toIndex = sections.indexOf(overSection);
      const rect = overSection.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) toIndex += 1;
      onMove({ kind: 'section', sectionId: dragging.id, toIndex });
    }
  });
}
