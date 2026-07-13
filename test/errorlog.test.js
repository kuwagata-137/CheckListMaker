'use strict';
// errorlog.js（メインプロセス側のエラーログ）の単体テスト。
// app / ipcMain をスタブして log:write ハンドラを直接叩く。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function createErrorLog() {
  const { initErrorLog } = require(path.join(__dirname, '..', 'errorlog.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clm-log-'));
  const handlers = {};
  initErrorLog({ getPath: () => tmp }, { handle: (ch, fn) => { handlers[ch] = fn; } });
  return {
    logFile: path.join(tmp, 'logs', 'error.log'),
    ipc: (ch, ...args) => handlers[ch](null, ...args),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test('errorlog.js — エラーのローカルログ', async (t) => {
  const st = createErrorLog();
  t.after(() => st.cleanup());

  const readLines = () =>
    fs.readFileSync(st.logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  await t.test('log:write が JSONL 1行を追記する', async () => {
    const r = await st.ipc('log:write', { kind: 'error', message: 'boom', stack: 'at x', extra: 'a.js:1:2' });
    assert.equal(r.ok, true);
    const rows = readLines();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'error');
    assert.equal(rows[0].message, 'boom');
    assert.equal(rows[0].stack, 'at x');
    assert.equal(rows[0].source, 'renderer');
    assert.ok(!Number.isNaN(Date.parse(rows[0].ts)), 'ts が ISO 日時');
  });

  await t.test('文字列などオブジェクト以外の入力も message に正規化される', async () => {
    const r = await st.ipc('log:write', 'ただの文字列');
    assert.equal(r.ok, true);
    const rows = readLines();
    assert.equal(rows[1].message, 'ただの文字列');
  });

  await t.test('巨大なフィールドは 4000 文字に切り詰められる', async () => {
    await st.ipc('log:write', { message: 'x'.repeat(20000) });
    const rows = readLines();
    assert.equal(rows[2].message.length, 4000);
  });

  await t.test('512KB を超えると error.log.1 へローテーションする', async () => {
    fs.writeFileSync(st.logFile, 'x'.repeat(600 * 1024) + '\n');
    await st.ipc('log:write', { message: 'after-rotate' });
    assert.ok(fs.existsSync(st.logFile + '.1'), '旧ログが .1 に退避される');
    const rows = readLines();
    assert.equal(rows.length, 1, '新ログは書き込んだ1行だけ');
    assert.equal(rows[0].message, 'after-rotate');
  });
});
