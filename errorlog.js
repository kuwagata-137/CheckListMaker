// errorlog.js — エラーのローカルログ（ロードマップ 1-3）
// 役割:
//  - レンダラーからの log:write IPC を <userData>/logs/error.log へ JSONL で追記
//  - メインプロセス自身の uncaughtException / unhandledRejection も同じログへ記録
//  - 512KB を超えたら error.log.1 へローテーション（1世代のみ保持）
//
// 外部送信は一切しない。仕様は docs/spec-1-3-error-visibility.md 参照。
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const MAX_LOG_BYTES = 512 * 1024;
const MAX_FIELD_LEN = 4000; // 1フィールドの上限（巨大 stack でログが膨れるのを防ぐ）

function initErrorLog(app, ipcMain) {
  const logDir = () => path.join(app.getPath('userData'), 'logs');
  const logFile = () => path.join(logDir(), 'error.log');

  const clip = (v) => String(v == null ? '' : v).slice(0, MAX_FIELD_LEN);

  // 入力（レンダラー由来＝信頼しない）を固定の形に正規化する
  function normalize(entry, source) {
    const e = entry && typeof entry === 'object' ? entry : { message: entry };
    return {
      ts: new Date().toISOString(),
      source: clip(e.source || source || 'renderer'),
      kind: clip(e.kind || 'error'),
      message: clip(e.message),
      stack: e.stack ? clip(e.stack) : undefined,
      extra: e.extra ? clip(e.extra) : undefined,
    };
  }

  // 追記は直列化する（ローテーションの rename と追記が交錯しないように）
  let chain = Promise.resolve();
  function write(record) {
    const task = chain.then(async () => {
      await fsp.mkdir(logDir(), { recursive: true });
      try {
        const st = await fsp.stat(logFile());
        if (st.size > MAX_LOG_BYTES) await fsp.rename(logFile(), logFile() + '.1');
      } catch (_) {
        /* 初回はファイルが無い */
      }
      await fsp.appendFile(logFile(), JSON.stringify(record) + '\n', 'utf8');
    });
    chain = task.catch(() => {}); // ログ書き込み失敗でアプリを止めない
    return task;
  }

  ipcMain.handle('log:write', async (_e, entry) => {
    try {
      await write(normalize(entry, 'renderer'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // メインプロセス自身のエラーも記録する。uncaughtException は通常のリスナーを
  // 足すと既定のクラッシュ動作が消えるため、観測専用の Monitor イベントを使う。
  const logMain = (kind) => (err) => {
    console.error(kind + ':', err);
    write(normalize({ kind, message: (err && err.message) || err, stack: err && err.stack }, 'main'))
      .catch(() => {});
  };
  process.on('uncaughtExceptionMonitor', logMain('uncaughtException'));
  process.on('unhandledRejection', logMain('unhandledRejection'));

  return { write, logFile };
}

module.exports = { initErrorLog };
