// preclick-frames.js — クリック直前キャプチャ（v1.0.8 作業2）の純関数。
// 撮影プロセス（capture-host.js）が持つリングから「イベントより前に撮り終えた最新の1枚」を選ぶ
// 規則と、リングの大きさ・撮影の間隔の決め方をここにまとめる（test/preclickframes.test.js で検証）。
// 仕様は docs/spec-preclick-capture.md 参照。
'use strict';

const PRECLICK_INTERVAL_MS = 100;  // 撮る間隔（スパイクで決定。CPU は1コアの約 6%）
const PRECLICK_MIN_REST_MS = 30;   // 1枚が長いとき（大きいモニタ）でも次の撮影まで休む最短時間
const PRECLICK_MAX_AGE_MS = 1000;  // これより前に撮り終えた1枚は使わない（撮影が止まっていたとき）
const RING_BYTES_MAX = 64 * 1024 * 1024; // リング全体のメモリの上限
const RING_MIN = 2;
const RING_MAX = 5;

// GetTickCount（32bit・約 49.7 日で一周）の差 a − b を符号付き 32bit で返す。
function tickDiff(a, b) {
  return (Number(a) - Number(b)) | 0;
}

// frames: [{ start, end, rect: { x, y, w, h } }]（rect はモニタの物理 px）。
// イベント時刻 eventTick 以前に撮り終え（end）、古すぎず（maxAgeMs 以内）、イベントの座標 (x, y) が
// そのモニタの中にある1枚のうち、撮り終えが最も新しいものを返す。無ければ null。
function pickFrameBefore(frames, eventTick, x, y, maxAgeMs = PRECLICK_MAX_AGE_MS) {
  let best = null;
  for (const fr of Array.isArray(frames) ? frames : []) {
    if (!fr || !fr.rect) continue;
    const age = tickDiff(eventTick, fr.end);
    if (age < 0 || age > maxAgeMs) continue;
    const r = fr.rect;
    if (!(x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) continue;
    if (!best || tickDiff(fr.end, best.end) > 0) best = fr;
  }
  return best;
}

// GDI の 32bpp は BGRA のアルファが 0 のまま。PNG にすると透明になるので 255 に埋める（その場で書き換え）。
function fillAlpha(buf) {
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
  return buf;
}

// リングの枚数：1枚（幅×高さ×4 バイト）の大きさから、合計 RING_BYTES_MAX 以内で 2〜5 枚。
function ringSizeFor(w, h) {
  const bytes = Number(w) * Number(h) * 4;
  if (!(bytes > 0)) return RING_MIN;
  return Math.max(RING_MIN, Math.min(RING_MAX, Math.floor(RING_BYTES_MAX / bytes)));
}

// 1枚の撮影にかかった時間から、次の撮影までの待ち時間を決める（間隔を守り、最低でも少し休む）。
function nextCaptureDelay(elapsedMs, intervalMs = PRECLICK_INTERVAL_MS, minRestMs = PRECLICK_MIN_REST_MS) {
  const e = Number(elapsedMs);
  if (!Number.isFinite(e)) return intervalMs;
  return Math.max(minRestMs, intervalMs - e);
}

module.exports = {
  PRECLICK_INTERVAL_MS, PRECLICK_MIN_REST_MS, PRECLICK_MAX_AGE_MS,
  tickDiff, pickFrameBefore, fillAlpha, ringSizeFor, nextCaptureDelay,
};
