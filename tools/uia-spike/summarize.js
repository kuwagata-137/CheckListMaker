#!/usr/bin/env node
'use strict';
// results-*.jsonl（measure.js / measure.ps1 どちらの出力でも可）を読み直して
// 要素名の取得率をアプリ別に再集計する。
//   node summarize.js results-XXXX.jsonl [results-YYYY.jsonl ...]
// 引数なしならフォルダ内の results-*.jsonl を全部まとめて集計する。

const fs = require('fs');
const path = require('path');

let files = process.argv.slice(2);
if (!files.length) {
  files = fs.readdirSync(__dirname)
    .filter((f) => /^results-.*\.jsonl$/.test(f))
    .map((f) => path.join(__dirname, f));
}
if (!files.length) {
  console.error('results-*.jsonl が見つかりません。');
  process.exit(1);
}

const records = [];
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch (_) { /* 壊れた行はスキップ */ }
  }
}

const byApp = new Map();
for (const r of records) {
  const key = (r.appName || '(不明)').toLowerCase();
  if (!byApp.has(key)) byApp.set(key, { app: r.appName || '(不明)', total: 0, resolved: 0, named: 0, ms: [] });
  const a = byApp.get(key);
  a.total += 1;
  if (r.ok) a.resolved += 1;
  if (r.ok && r.name && String(r.name).trim()) a.named += 1;
  if (typeof r.elapsedMs === 'number') a.ms.push(r.elapsedMs);
}
const rows = [...byApp.values()].sort((a, b) => b.total - a.total).map((a) => ({
  app: a.app,
  total: a.total,
  resolved: a.resolved,
  named: a.named,
  namedRate: a.total ? Math.round((a.named / a.total) * 100) : 0,
  medianMs: a.ms.length ? a.ms.sort((x, y) => x - y)[Math.floor(a.ms.length / 2)] : 0,
}));
const total = records.length;
const named = records.filter((r) => r.ok && r.name && String(r.name).trim()).length;

console.log('対象: ' + files.map((f) => path.basename(f)).join(', '));
console.log('全体: ' + named + '/' + total + ' = ' + (total ? Math.round((named / total) * 100) : 0) + '%\n');
console.log('| app | clicks | 名前あり | 取得率 | 解決時間(中央値) |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  console.log(`| ${r.app} | ${r.total} | ${r.named} | ${r.namedRate}% | ${r.medianMs}ms |`);
}
