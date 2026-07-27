#!/usr/bin/env node
// json-to-html.mjs — .checklist.json から「CheckListMaker 取り込み用 HTML」を作る。
//
// 使い方:
//   node json-to-html.mjs input.checklist.json [-o output.html]
//   （-o 省略時は入力と同じ場所に <入力名>.html を書く）
//
// 出力する HTML は2つの役割を兼ねる:
//   ① ブラウザで開くと手順書として読める静的レンダリング
//   ② <script type="application/json" id="clm-data"> に取り込み用データを埋め込む
//
// なぜ HTML を作るのか:
//   CheckListMaker の HTML 取り込みは「同一 id なら更新・無ければ追加」＝マージ。
//   JSON 取り込みの「全置換」と違い、ユーザーの既存データを壊さない。
//   本体の parseChecklistFromHtml は DOMParser で id="clm-data" を探すだけなので、
//   アプリを丸ごと埋め込んだ自己完結 HTML である必要はない。
//
// ⚠ これはアプリの「自己完結HTML（名前を付けて保存）」ではない。
//   アプリ本体を埋め込んでいないため、ブラウザで開いても編集はできない（読めるだけ）。
//
// 設計方針: 外部依存ゼロ（Node 標準モジュールのみ）。
'use strict';

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, extname } from 'node:path';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

// 画像は dataURL のみ埋め込む。img:<uuid> 参照は実体を持たないので落とす
// （静的レンダリング側だけの話で、clm-data には元の値がそのまま入る）。
const isDataUrl = (s) => typeof s === 'string' && s.startsWith('data:image/');

// ISO(yyyy-mm-dd) を「yyyy年m月d日」に整形する（index.html の formatCoverDate と同じ）。
// 解釈できない値はそのまま返す。
function formatDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v).trim());
  return m ? `${+m[1]}年${+m[2]}月${+m[3]}日` : String(v == null ? '' : v);
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0 auto; padding: 32px 20px 64px; max-width: 900px;
  font-family: "Yu Gothic", "游ゴシック", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif;
  line-height: 1.75; color: #1c2024; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e6e8ea; background: #16181a; } }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
.meta { color: #6b7280; font-size: .85rem; margin: 0 0 28px; }
.cover { border: 1px solid #d5d9df; border-radius: 10px; padding: 20px 22px; margin: 0 0 28px; }
.cover dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 12px 0 0; font-size: .9rem; }
.cover dt { color: #6b7280; }
.cover dd { margin: 0; }
.cover table { border-collapse: collapse; margin: 14px 0 0; font-size: .85rem; }
.cover th, .cover td { border: 1px solid #cfd3da; padding: 4px 10px; text-align: left; }
.cover thead th { background: #f2f4f7; }
@media (prefers-color-scheme: dark) { .cover thead th { background: #23262a; } }
h2 { font-size: 1.15rem; margin: 32px 0 12px; padding: 6px 0 6px 12px;
  border-left: 5px solid var(--accent, #3b6ea5); }
.step { border: 1px solid #d5d9df; border-radius: 8px; padding: 12px 16px; margin: 0 0 12px; }
.step > h3 { display: flex; align-items: baseline; gap: 10px; font-size: 1rem; margin: 0; }
.no { flex: none; min-width: 1.9em; height: 1.9em; display: inline-flex; align-items: center;
  justify-content: center; border-radius: 999px; background: var(--accent, #3b6ea5);
  color: #fff; font-size: .8rem; }
.time { margin-left: auto; flex: none; color: #6b7280; font-size: .85rem; font-weight: normal; }
.rb { margin: 10px 0 0; }
.rb table { border-collapse: collapse; }
.rb th, .rb td { border: 1px solid #cfd3da; padding: 5px 9px; }
.rb thead th { background: #f2f4f7; }
@media (prefers-color-scheme: dark) { .rb thead th { background: #23262a; } }
.note { margin: 10px 0 0; color: #4b5563; font-size: .92rem; }
@media (prefers-color-scheme: dark) { .note, .meta, .time, .cover dt { color: #9aa3ad; } }
figure { margin: 12px 0 0; }
figure img { max-width: 100%; height: auto; border: 1px solid #d5d9df; border-radius: 6px; }
.hint { margin: 36px 0 0; padding: 12px 16px; border-radius: 8px; background: #f2f4f7;
  color: #4b5563; font-size: .85rem; }
@media (prefers-color-scheme: dark) { .hint { background: #23262a; color: #9aa3ad; } }
`.trim();

function renderCover(cover, fallbackTitle) {
  if (!cover || cover.enabled === false) return '';
  const rows = [
    ['文書番号', cover.docNumber],
    ['版数', cover.version],
    ['作成者', cover.author],
    ['発行日', escapeHtml(formatDate(cover.date))],
  ].filter(([, v]) => v);
  // 表紙のテキスト欄はアプリ側でもリッチ編集（HTML）なのでそのまま出す
  const title = cover.title || escapeHtml(fallbackTitle || '');
  const sub = cover.subtitle ? `<p>${cover.subtitle}</p>` : '';
  const dl = rows.length
    ? `<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
    : '';
  const revs = (Array.isArray(cover.revisions) ? cover.revisions : [])
    .filter((r) => r && (r.version || r.date || r.author || r.note));
  const revTable = revs.length
    ? `<table class="rev"><thead><tr><th>版</th><th>日付</th><th>作成者</th><th>内容</th></tr></thead><tbody>` +
      revs.map((r) => `<tr><td>${escapeHtml(r.version)}</td><td>${escapeHtml(formatDate(r.date))}</td>` +
        `<td>${escapeHtml(r.author)}</td><td>${escapeHtml(r.note)}</td></tr>`).join('') +
      `</tbody></table>`
    : '';
  return `<div class="cover"><strong>${title}</strong>${sub}${dl}${revTable}</div>`;
}

function renderChecklist(c) {
  const isTemplate = c.type === 'template';
  const accent = /^#[0-9a-fA-F]{3,8}$/.test((c.coverPage && c.coverPage.accent) || '')
    ? c.coverPage.accent
    : '#3b6ea5';
  const total = (c.sections || []).reduce((n, s) => n + (s.items || []).length, 0);
  const mins = isTemplate
    ? (c.sections || []).reduce(
        (a, s) => a + (s.items || []).reduce((b, i) => b + (parseInt(i.time, 10) || 0), 0), 0)
    : 0;

  let no = 0;
  const sections = (c.sections || []).map((s) => {
    const items = (s.items || []).map((it) => {
      no += 1;
      // isTemplate の出し分けはアプリ本体（index.html の renderDocxView / buildXlsxSheetData）と揃える
      const time = isTemplate && it.time ? `<span class="time">⏱${escapeHtml(it.time)}分</span>` : '';
      const body = isTemplate && it.body ? `<div class="rb">${it.body}</div>` : '';
      const note = isTemplate && it.note ? `<p class="note">（メモ）${escapeHtml(it.note)}</p>` : '';
      const imgs = (Array.isArray(it.images) ? it.images : [])
        .filter(isDataUrl)
        .map((src) => `<figure><img src="${escapeHtml(src)}" alt="" /></figure>`)
        .join('');
      const box = isTemplate ? '' : `${it.done ? '☑' : '☐'} `;
      return `<article class="step"><h3><span class="no">${no}</span>` +
        `<span>${box}${escapeHtml(it.text)}</span>${time}</h3>${body}${note}${imgs}</article>`;
    }).join('\n');
    const head = s.title ? `<h2>${escapeHtml(s.title)}</h2>` : '';
    return `${head}\n${items}`;
  }).join('\n');

  const meta = [`${total}手順`, mins ? `総所要 約${mins}分` : ''].filter(Boolean).join(' ・ ');
  return `<div style="--accent:${escapeHtml(accent)}">\n` +
    `<h1>${escapeHtml(c.title)}</h1>\n<p class="meta">${escapeHtml(meta)}</p>\n` +
    `${renderCover(c.coverPage, c.title)}\n${sections}\n</div>`;
}

function buildHtml(state) {
  const first = state.checklists[0];
  const title = (first && first.title) || 'チェックリスト';
  // </ を退避してスクリプト要素が途中で閉じないようにする（index.html の buildStandaloneHtml と同じ）
  const dataJson = JSON.stringify(state).replace(/<\//g, '<\\/');
  const body = state.checklists.map(renderChecklist).join('\n<hr />\n');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>${STYLE}</style>
</head>
<body>
${body}
<p class="hint">このファイルは CheckListMaker に取り込めます（ホーム画面の「インポート」）。
同じ ID のチェックリストがあれば更新、無ければ追加されるため、既存のデータは消えません。
なお、このページ自体は閲覧専用です（編集は CheckListMaker で行ってください）。</p>
<script type="application/json" id="clm-data">${dataJson}</script>
</body>
</html>
`;
}

// ---- main ----
const argv = process.argv.slice(2);
let input = null;
let output = null;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '-o' || a === '--out') { output = argv[i + 1] || null; i += 1; }
  else if (!a.startsWith('-') && input === null) input = a;
}

if (!input) {
  console.error('使い方: node json-to-html.mjs <input.checklist.json> [-o output.html]');
  process.exit(2);
}

let state;
try {
  state = JSON.parse(readFileSync(input, 'utf8'));
} catch (e) {
  console.error(`読み込み／解析に失敗しました: ${input} — ${e.message}`);
  process.exit(1);
}
if (!state || !Array.isArray(state.checklists) || state.checklists.length === 0) {
  console.error('checklists 配列が見つからないか空です。先に validate-checklist.mjs で確認してください。');
  process.exit(1);
}

const out = output || join(dirname(input), basename(input, extname(input)) + '.html');
writeFileSync(out, buildHtml(state), 'utf8');
console.log(`${out} を書き出しました（チェックリスト ${state.checklists.length} 件）。`);
console.log('CheckListMaker のホーム画面「インポート」から取り込めます（既存データはマージされます）。');
