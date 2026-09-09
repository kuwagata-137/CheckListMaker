#!/usr/bin/env node
// validate-checklist.mjs — CheckListMaker の state JSON を取り込み前に検証する。
//
// 使い方:
//   node validate-checklist.mjs <file.json> [--max-mb 8] [--quiet]
//
// 設計方針:
//   - **外部依存ゼロ**。別プロジェクトでは npm install できない前提のため、
//     Node 標準モジュールだけで動くこと。
//   - 「エラー」＝アプリが取り込めない／壊れて表示される。終了コード 1。
//   - 「警告」＝取り込めるが意図した見た目にならない可能性が高い。終了コード 0。
//
// 判定根拠はすべて CheckListMaker 本体のコードに対応する（コメントに出典を書く）。
'use strict';

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// index.html の RB_ALLOWED_TAGS と同一（サニタイズで残るタグ）
const ALLOWED_BODY_TAGS = new Set([
  'P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'SPAN',
  'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DIV',
]);
// index.html の MODES
const TYPES = new Set(['template', 'todo']);
// index.html の COVER_PRESETS
const COVER_PRESETS = new Set([
  'centered', 'left-top', 'top-band', 'side-band', 'framed',
  'hero', 'logo-top', 'split', 'minimal', 'doc-header',
]);
// storage.js の IMG_REF_PREFIX + IMG_FILE_RE
const IMG_REF_RE = /^img:[0-9a-fA-F-]{36}\.(jpg|png)$/;
// index.html の renderCoverHtml — これに一致しない accent は既定色に落ちる
const ACCENT_RE = /^#[0-9a-fA-F]{3,8}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// body の HTML から使われているタグ名を拾う（サニタイズと同じ粒度の近似）
function tagsIn(html) {
  const found = new Set();
  for (const m of String(html).matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    found.add(m[1].toUpperCase());
  }
  return found;
}

function validateCover(cover, where) {
  if (cover === undefined || cover === null) return;
  if (typeof cover !== 'object' || Array.isArray(cover)) {
    err(where, 'coverPage はオブジェクトである必要があります');
    return;
  }
  if (cover.enabled !== undefined && typeof cover.enabled !== 'boolean') {
    err(`${where}.enabled`, 'boolean である必要があります');
  }
  if (cover.includeToc !== undefined && typeof cover.includeToc !== 'boolean') {
    err(`${where}.includeToc`, 'boolean である必要があります');
  }
  if (cover.preset !== undefined && !COVER_PRESETS.has(cover.preset)) {
    warn(`${where}.preset`,
      `"${cover.preset}" は未知のプリセットです。'centered' として描画されます（有効値: ${[...COVER_PRESETS].join(', ')}）`);
  }
  if (cover.accent !== undefined && cover.accent !== '' && !ACCENT_RE.test(cover.accent)) {
    warn(`${where}.accent`, `"${cover.accent}" は #RRGGBB 形式でないため既定色 #3b6ea5 になります`);
  }
  if (cover.date !== undefined && cover.date !== '' && !ISO_DATE_RE.test(cover.date)) {
    err(`${where}.date`, `"${cover.date}" は yyyy-mm-dd 形式である必要があります`);
  }
  // 表紙のテキスト欄も本文と同じサニタイズを通る（renderCoverHtml の richCover）
  for (const key of ['title', 'subtitle', 'author', 'version', 'docNumber']) {
    const v = cover[key];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string') { err(`${where}.${key}`, '文字列である必要があります'); continue; }
    const bad = [...tagsIn(v)].filter((t) => !ALLOWED_BODY_TAGS.has(t));
    if (bad.length) warn(`${where}.${key}`, `許可されていないタグは削除されます: ${bad.join(', ')}`);
  }
  if (cover.logo !== undefined && cover.logo !== '' && !String(cover.logo).startsWith('data:image/')) {
    warn(`${where}.logo`, 'ロゴは dataURL（data:image/...）で埋め込む必要があります');
  }
  if (cover.revisions !== undefined) {
    if (!Array.isArray(cover.revisions)) {
      err(`${where}.revisions`, '配列である必要があります');
    } else {
      cover.revisions.forEach((r, i) => {
        const w = `${where}.revisions[${i}]`;
        if (typeof r !== 'object' || r === null) { err(w, 'オブジェクトである必要があります'); return; }
        if (r.date !== undefined && r.date !== '' && !ISO_DATE_RE.test(r.date)) {
          err(`${w}.date`, `"${r.date}" は yyyy-mm-dd 形式である必要があります`);
        }
      });
    }
  }
}

function validateItem(item, where, isTodo, seenIds) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    err(where, 'item はオブジェクトである必要があります');
    return;
  }
  if (!isNonEmptyString(item.id)) err(`${where}.id`, '非空の文字列が必要です');
  else if (seenIds.has(item.id)) err(`${where}.id`, `id "${item.id}" が重複しています`);
  else seenIds.add(item.id);

  if (typeof item.text !== 'string') err(`${where}.text`, '文字列が必要です');
  else if (item.text.trim() === '') warn(`${where}.text`, '空の手順です（アプリ上は空行として表示されます）');

  if (item.done !== undefined && typeof item.done !== 'boolean') {
    err(`${where}.done`, 'boolean である必要があります');
  }
  if (item.note !== undefined && typeof item.note !== 'string') {
    err(`${where}.note`, '文字列である必要があります（note はプレーンテキスト）');
  }

  // time は parseInt される（index.html の sumMinutes）。数値型でも動くが文字列が正
  if (item.time !== undefined && item.time !== '') {
    if (typeof item.time === 'number') {
      warn(`${where}.time`, '数値ではなく文字列（例 "5"）で持つのがアプリの既定形式です');
    } else if (typeof item.time !== 'string') {
      err(`${where}.time`, '文字列である必要があります');
    } else if (!/^\d+$/.test(item.time.trim())) {
      warn(`${where}.time`, `"${item.time}" は parseInt で解釈されます。半角数字（分）だけにしてください`);
    }
    if (isTodo) {
      warn(`${where}.time`, 'type が "todo" のチェックリストでは 標準時間 は Word/Excel に出力されません');
    }
  }

  if (item.body !== undefined && item.body !== '') {
    if (typeof item.body !== 'string') {
      err(`${where}.body`, '文字列（サニタイズ済み HTML）である必要があります');
    } else {
      const bad = [...tagsIn(item.body)].filter((t) => !ALLOWED_BODY_TAGS.has(t));
      if (bad.length) {
        err(`${where}.body`,
          `許可されていないタグが含まれます（サニタイズで削除されます）: ${bad.join(', ')}。` +
          `許可: ${[...ALLOWED_BODY_TAGS].join(', ')}`);
      }
      if (isTodo) {
        warn(`${where}.body`, 'type が "todo" のチェックリストでは body（詳細）は Word/Excel に出力されません');
      }
    }
  }

  const images = item.images;
  if (images !== undefined) {
    if (!Array.isArray(images)) {
      err(`${where}.images`, '配列である必要があります');
    } else {
      images.forEach((src, i) => {
        if (typeof src !== 'string') { err(`${where}.images[${i}]`, '文字列である必要があります'); return; }
        if (src.startsWith('data:image/')) return;
        if (IMG_REF_RE.test(src)) {
          warn(`${where}.images[${i}]`,
            'ファイル参照（img:<uuid>）です。参照先の画像を持たない環境では表示できません');
          return;
        }
        err(`${where}.images[${i}]`,
          'dataURL（data:image/...）か img:<uuid>.jpg|png 形式である必要があります');
      });
      // 並行配列はインデックス整合が前提（index.html の normalizeParallel）
      for (const key of ['imageEdits', 'imagesFull']) {
        const arr = item[key];
        if (arr === undefined) continue;
        if (!Array.isArray(arr)) { err(`${where}.${key}`, '配列である必要があります'); continue; }
        if (arr.length !== images.length) {
          warn(`${where}.${key}`,
            `長さ ${arr.length} が images（${images.length}）と一致しません。読み込み時に切り詰め／穴埋めされます`);
        }
      }
    }
  }
}

function validateState(data, byteLength, maxBytes) {
  // アプリ本体の取り込み判定と同一（index.html: JSON に checklists 配列が見つかりません）
  if (!data || typeof data !== 'object' || !Array.isArray(data.checklists)) {
    err('(root)', 'トップレベルに checklists 配列が必要です（これが無いと取り込み時にエラーになります）');
    return;
  }
  if (data.checklists.length === 0) {
    warn('(root).checklists', '空です。取り込むとアプリのデータが空になります');
  }
  if (data.settings !== undefined && (typeof data.settings !== 'object' || Array.isArray(data.settings))) {
    err('(root).settings', 'オブジェクトである必要があります（例 {"theme":"auto"}）');
  }

  const seenIds = new Set();
  data.checklists.forEach((c, ci) => {
    const where = `checklists[${ci}]`;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      err(where, 'オブジェクトである必要があります');
      return;
    }
    if (!isNonEmptyString(c.id)) err(`${where}.id`, '非空の文字列が必要です');
    else if (seenIds.has(c.id)) err(`${where}.id`, `id "${c.id}" が重複しています`);
    else seenIds.add(c.id);

    if (!isNonEmptyString(c.title)) err(`${where}.title`, '非空の文字列が必要です');

    if (!TYPES.has(c.type)) {
      err(`${where}.type`, `"${c.type}" は無効です。"template"（手順書）か "todo" のどちらかにしてください`);
    }
    const isTodo = c.type === 'todo';

    for (const key of ['createdAt', 'updatedAt']) {
      if (c[key] !== undefined && typeof c[key] !== 'number') {
        err(`${where}.${key}`, 'epoch ミリ秒（数値）である必要があります');
      }
    }

    if (c.coverPage !== undefined) {
      validateCover(c.coverPage, `${where}.coverPage`);
      if (isTodo && c.coverPage && c.coverPage.enabled) {
        warn(`${where}.coverPage`, 'type が "todo" のチェックリストでは表紙は描画されません');
      }
    }
    if (c.cover !== undefined) {
      warn(`${where}.cover`, '表紙のフィールド名は coverPage です。cover は読まれません');
    }

    if (!Array.isArray(c.sections)) {
      err(`${where}.sections`, '配列である必要があります');
      return;
    }
    if (c.sections.length === 0) {
      warn(`${where}.sections`, '空です。アプリは空セクションを1つ補います');
    }
    c.sections.forEach((s, si) => {
      const sw = `${where}.sections[${si}]`;
      if (typeof s !== 'object' || s === null || Array.isArray(s)) {
        err(sw, 'オブジェクトである必要があります');
        return;
      }
      if (!isNonEmptyString(s.id)) err(`${sw}.id`, '非空の文字列が必要です');
      else if (seenIds.has(s.id)) err(`${sw}.id`, `id "${s.id}" が重複しています`);
      else seenIds.add(s.id);

      if (s.title !== undefined && typeof s.title !== 'string') {
        err(`${sw}.title`, '文字列である必要があります');
      }
      if (!Array.isArray(s.items)) {
        err(`${sw}.items`, '配列である必要があります');
        return;
      }
      s.items.forEach((it, ii) => validateItem(it, `${sw}.items[${ii}]`, isTodo, seenIds));
    });
  });

  if (byteLength > maxBytes) {
    warn('(root)',
      `ファイルサイズ ${(byteLength / 1024 / 1024).toFixed(1)}MB が目安 ${(maxBytes / 1024 / 1024).toFixed(0)}MB を超えています。` +
      '画像 dataURL を埋め込むと簡単に肥大化します（ブラウザ版は localStorage 上限に当たります）');
  }
}

function summarize(data) {
  if (!data || !Array.isArray(data.checklists)) return '';
  let sections = 0, items = 0;
  for (const c of data.checklists) {
    for (const s of Array.isArray(c.sections) ? c.sections : []) {
      sections += 1;
      items += Array.isArray(s.items) ? s.items.length : 0;
    }
  }
  return `チェックリスト ${data.checklists.length} 件 / セクション ${sections} / 手順 ${items}`;
}

// ---- main ----
const argv = process.argv.slice(2);
let quiet = false;
let maxMb = 8;
let file = null;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--quiet') quiet = true;
  else if (a === '--max-mb') { maxMb = Number(argv[i + 1]) || maxMb; i += 1; }
  else if (!a.startsWith('--') && file === null) file = a;
}
const maxBytes = maxMb * 1024 * 1024;

if (!file) {
  console.error('使い方: node validate-checklist.mjs <file.json> [--max-mb 8] [--quiet]');
  process.exit(2);
}

let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`読み込めません: ${file} — ${e.message}`);
  process.exit(2);
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`JSON として解析できません: ${basename(file)} — ${e.message}`);
  process.exit(1);
}

validateState(data, Buffer.byteLength(raw, 'utf8'), maxBytes);

if (!quiet) {
  console.log(`${basename(file)} — ${summarize(data)}`);
}
if (errors.length) {
  console.error(`\n✗ エラー ${errors.length} 件（このままでは正しく取り込めません）`);
  for (const m of errors) console.error(`  - ${m}`);
}
if (warnings.length && !quiet) {
  console.warn(`\n△ 警告 ${warnings.length} 件（取り込めますが意図と違う可能性があります）`);
  for (const m of warnings) console.warn(`  - ${m}`);
}
if (!errors.length && !quiet) {
  console.log(warnings.length ? '\n✓ 取り込み可能（警告あり）' : '\n✓ 問題なし');
}
process.exit(errors.length ? 1 : 0);
