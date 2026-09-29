// capture.js — クリック直前キャプチャの親側ラッパ（v1.0.8 作業2）
// 録画開始で capture-host.js（utilityProcess・Windows のみ）を起動し、クリック・キー押下の
// イベント時刻を渡して「その前に撮り終えた1枚」を Promise で受け取る。タイムアウト・子プロセスの
// 死亡・非対応プラットフォームはすべて null に倒し、呼び出し側は従来の撮影で続行できる
// （reject しない）。作りは uia.js と同じ。仕様は docs/spec-preclick-capture.md 参照。
'use strict';

const path = require('path');

const CAPTURE_TIMEOUT_MS = 1500; // 1枚の受け取り待ちの上限（撮影 約40ms＋8MB の受け渡し）

let child = null;
let nextId = 1;
const pending = new Map(); // id -> { settle(replyOrNull) }

function settleAll() {
  for (const p of pending.values()) p.settle(null);
  pending.clear();
}

// 録画開始時に呼ぶ。Windows 以外・起動失敗時は何もしない（pickBefore / grab が null を返すだけ）。
function start() {
  if (process.platform !== 'win32' || child) return;
  try {
    const { utilityProcess } = require('electron');
    child = utilityProcess.fork(path.join(__dirname, 'capture-host.js'), [], {
      serviceName: 'CheckListMaker preclick capture',
    });
    child.on('message', (msg) => {
      const p = msg && pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.settle(msg);
      }
    });
    child.on('exit', (code) => {
      // クラッシュ隔離: 子が死んでも録画は続く。以降は従来の撮影（screenshot-desktop）。
      if (child) {
        console.error(`capture-host が終了しました（code=${code}）。以降は従来の撮影で続行します。`);
        child = null;
        settleAll();
      }
    });
  } catch (err) {
    console.error('capture-host を起動できません（従来の撮影で続行します）:', err);
    child = null;
  }
}

// 録画停止時に呼ぶ。待ちかけの要求はすべて null で確定させる。
function stop() {
  const c = child;
  child = null; // exit ハンドラの二重処理を防ぐため先に外す
  if (c) {
    try { c.kill(); } catch (_) { /* noop */ }
  }
  settleAll();
}

function request(payload) {
  if (!child) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((res) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      res(null);
    }, CAPTURE_TIMEOUT_MS);
    pending.set(id, {
      settle(reply) {
        clearTimeout(timer);
        res(reply && reply.ok ? reply : null);
      },
    });
    try {
      child.postMessage({ id, ...payload });
    } catch (_) {
      clearTimeout(timer);
      pending.delete(id);
      res(null);
    }
  });
}

// イベント時刻 tick（uiohook の time）より前に撮り終えた1枚。無ければ null。
// 返り値: { source: 'preclick', width, height, rect, start, end, data(BGRA) } | null
function pickBefore(tick, x, y) {
  return request({ type: 'pick', tick, x, y });
}

// その場で1枚撮る（ドラッグの終点・直前の1枚が無いとき）。返り値の source は 'grab'。
function grab(x, y) {
  return request({ type: 'grab', x, y });
}

function isActive() {
  return child !== null;
}

module.exports = { start, stop, pickBefore, grab, isActive };
