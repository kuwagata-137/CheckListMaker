// save-before-close.js — 窓を閉じる前と再読み込みの前に、編集中の欄を確定して保存を終える（v1.0.14・計画外）
//
// 手順名・メモ・本文などの欄は、欄を離れた時（change・focusout）に保存する作り。フォーカスを置いたまま
// 窓を閉じる・再読み込みすると、最後の編集が保存されずに消えていた（質問 Q5 の回答 2026-11-17 で直す）。
// 閉じる操作をいったん止め、ページ側の window.clmFlushBeforeUnload()（フォーカスを外して確定し、
// ファイルへの書き込みが終わるのを待つ）を呼んでから閉じる。ページ側が応答しない時は、待ち時間で打ち切る。
// 仕様は docs/spec-file-storage-migration.md「閉じる前と再読み込みの前の保存」。
'use strict';

const FLUSH_SCRIPT = "typeof window.clmFlushBeforeUnload === 'function' ? window.clmFlushBeforeUnload() : true";
const FLUSH_TIMEOUT_MS = 3000;

// ページ側の確定を呼び、終わるまで待つ。確定できた時は true、窓が無い・例外・待ち時間切れは false。
function flushRenderer(win, timeoutMs = FLUSH_TIMEOUT_MS) {
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  let timer = null;
  const run = Promise.resolve()
    .then(() => win.webContents.executeJavaScript(FLUSH_SCRIPT, true))
    .then(() => true, () => false);
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

// 窓を閉じる操作（✕・メニューの「終了」・Alt+F4）を一度止め、確定が終わってから閉じ直す。
function guardCloseUntilSaved(win, { timeoutMs = FLUSH_TIMEOUT_MS } = {}) {
  let ready = false;   // 確定が終わり、閉じてよい
  let flushing = false; // 確定の途中（もう一度閉じる操作が来ても、確定は 1 回だけ）
  win.on('close', (e) => {
    if (ready) return;
    e.preventDefault();
    if (flushing) return;
    flushing = true;
    flushRenderer(win, timeoutMs).finally(() => {
      ready = true;
      flushing = false;
      if (!win.isDestroyed()) win.close();
    });
  });
}

// メニューの「再読み込み」「強制的に再読み込み」。確定が終わってから読み直す。
async function reloadAfterSave(win, ignoreCache) {
  if (!win || win.isDestroyed()) return;
  await flushRenderer(win);
  if (win.isDestroyed()) return;
  if (ignoreCache) win.webContents.reloadIgnoringCache();
  else win.webContents.reload();
}

module.exports = { FLUSH_TIMEOUT_MS, flushRenderer, guardCloseUntilSaved, reloadAfterSave };
