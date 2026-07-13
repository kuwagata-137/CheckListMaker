// uia.js — UIA 要素解決の親側ラッパ（ロードマップ 2-R2）
// 録画開始で uia-host.js（utilityProcess・Windows のみ）を起動し、クリックごとに
// {id, x, y} を送って解決結果を Promise で返す。タイムアウト・子プロセスの死亡・
// 非対応プラットフォームはすべて「解決なし（null）」に倒し、呼び出し側は常に
// フォールバック文で続行できる（reject しない）。
//
// 子プロセスが録画中に死んだ場合、セッション内では再起動しない（ログのみ。
// 次回の録画開始で再起動する）。設計判断は docs/spec-2-R2-uia-steptext.md 参照。
'use strict';

const path = require('path');

const UIA_TIMEOUT_MS = 2000; // 解決待ちの上限（実測の最大は 281ms。初期値・調整可）

let child = null;
let nextId = 1;
const pending = new Map(); // id -> { settle(replyOrNull), timer }

function settleAll() {
  for (const p of pending.values()) p.settle(null);
  pending.clear();
}

// 録画開始時に呼ぶ。Windows 以外・起動失敗時は何もしない（resolve が null を返すだけ）。
function start() {
  if (process.platform !== 'win32' || child) return;
  try {
    const { utilityProcess } = require('electron');
    child = utilityProcess.fork(path.join(__dirname, 'uia-host.js'), [], {
      serviceName: 'CheckListMaker UIA resolver',
    });
    child.on('message', (msg) => {
      const p = msg && pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.settle(msg);
      }
    });
    child.on('exit', (code) => {
      // クラッシュ隔離: 子が死んでも録画は続く。以降の解決は null（フォールバック）。
      if (child) {
        console.error(`uia-host が終了しました（code=${code}）。以降はフォールバック文で続行します。`);
        child = null;
        settleAll();
      }
    });
  } catch (err) {
    console.error('uia-host を起動できません（フォールバック文で続行します）:', err);
    child = null;
  }
}

// 録画停止時に呼ぶ。待ちかけの解決はすべて null で確定させる。
function stop() {
  const c = child;
  child = null; // exit ハンドラの二重処理を防ぐため先に外す
  if (c) {
    try {
      c.kill();
    } catch (_) { /* noop */ }
  }
  settleAll();
}

// クリック座標の要素解決を依頼する。返り値は uia-host の返信オブジェクト or null。
// 決して reject しない（呼び出し側の保存処理を止めないため）。
function resolve(x, y) {
  if (!child) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((res) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      res(null);
    }, UIA_TIMEOUT_MS);
    pending.set(id, {
      settle(reply) {
        clearTimeout(timer);
        res(reply);
      },
    });
    try {
      child.postMessage({ id, x, y });
    } catch (_) {
      clearTimeout(timer);
      pending.delete(id);
      res(null);
    }
  });
}

function isActive() {
  return child !== null;
}

module.exports = { start, stop, resolve, isActive };
