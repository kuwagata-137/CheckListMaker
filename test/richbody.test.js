'use strict';
// 手順の本文（リッチ編集）の不具合の直し（v1.0.14・計画外）の試験。
//  - 暗い表示で、本文に入れた表の見出し行の文字が読めなかった（背景が明るい色のままだった）
//  - 本文で選んだ文字をドラッグすると、手順を並べ替える処理が文字のノードで closest を呼び、TypeError になっていた

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, waitFor, ROOT } = require('./harness');

const STORAGE_KEY = 'checklistmaker.v1';
const seedState = () => ({
  checklists: [{
    id: 't1', title: '本文の確認', type: 'template', createdAt: 1, updatedAt: 1,
    sections: [{ id: 's1', title: '準備', items: [{ id: 'j1', text: '手順1', done: false, note: '', time: '', body: '<p>領収書の写真を添付する</p>', images: [] }] }],
  }],
  settings: { theme: 'auto' },
});

// 相対輝度とコントラスト比（WCAG 2.x の式）
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('暗い表示では、本文に入れた表の見出し行の背景を暗い色にし、文字と十分な差を付ける', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme\]\) \.rb-body thead th \{ background: (#[0-9a-fA-F]{6}); \}/.exec(html);
  assert.ok(m, '暗い表示の時の、見出し行の背景の規則がある');
  const darkText = /:root:not\(\[data-theme\]\) \{[^}]*--text: (#[0-9a-fA-F]{6});/.exec(html);
  assert.ok(darkText, '暗い表示の文字色（--text）が読める');
  assert.ok(contrast(m[1], darkText[1]) >= 4.5, `見出し行の背景 ${m[1]} と文字色 ${darkText[1]} のコントラスト比が 4.5 以上`);
});

test('本文で選んだ文字をドラッグしても（文字のノードで dragstart が起きても）、エラーにならない', async (t) => {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
  t.after(() => app.close());
  await app.api();
  app.window.location.hash = '#/c/t1';
  const editor = await waitFor(() => app.document.querySelector('#app [data-rb-edit]'), { label: '手順の本文' });
  const errors = [];
  app.window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  const text = editor.querySelector('p').firstChild;
  const ev = new app.window.Event('dragstart', { bubbles: true, cancelable: true });
  text.dispatchEvent(ev);
  assert.deepEqual(errors, []);
  assert.equal(ev.defaultPrevented, false, '文字のドラッグそのものは止めない');
});
