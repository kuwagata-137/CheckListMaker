'use strict';
// アプリのメニュー「ヘルプ」→「操作マニュアル」で開く Word のファイル（docs/spec-manual.md）。
// インストーラは マニュアル/ の .docx を resources/マニュアル/ に入れる（package.json の extraResources）。
// 開くときは一時フォルダへ写してから、OS の既定のアプリ（Word）で開く。インストール先のファイルを
// Word が掴んだままだと、次の版のインストーラが上書きできなくなるため。
// Electron に触る部分は main.js の openManual()。ここは node だけで動く関数（テスト対象）。

const fs = require('fs');
const path = require('path');

const MANUAL_RE = /^CheckListMaker_操作マニュアル_v(.+)\.docx$/;

// ファイル名の並びから開くものを選ぶ。アプリの版と同じものがあればそれ、なければ名前の順で最後のもの。
function pickManualFile(names, version) {
  const hits = (names || []).filter((n) => MANUAL_RE.test(n)).sort();
  if (!hits.length) return null;
  const same = hits.find((n) => n.match(MANUAL_RE)[1] === String(version || ''));
  return same || hits[hits.length - 1];
}

// マニュアルのフォルダ（インストールした版は resources/マニュアル、開発中はリポジトリの マニュアル）
function manualDir({ isPackaged, resourcesPath, appDir }) {
  return isPackaged ? path.join(resourcesPath, 'マニュアル') : path.join(appDir, 'マニュアル');
}

// 開くファイルを一時フォルダに写し、写した先の場所を返す。見つからなければ null
function prepareManual({ dir, version, tmpDir }) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  const name = pickManualFile(names, version);
  if (!name) return null;
  const outDir = path.join(tmpDir, 'CheckListMaker');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, name);
  try {
    fs.copyFileSync(path.join(dir, name), out);
  } catch (err) {
    // 前に開いた写しを Word が開いたままだと上書きできない。そのときは前の写しを開く
    if (!fs.existsSync(out)) throw err;
  }
  return out;
}

module.exports = { MANUAL_RE, pickManualFile, manualDir, prepareManual };
