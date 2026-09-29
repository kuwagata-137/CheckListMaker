// capture-host.js — クリック直前キャプチャの撮影プロセス（v1.0.8 作業2）
// Electron の utilityProcess として録画中だけ起動される（親側は capture.js）。
// GDI（CreateDIBSection + BitBlt）でカーソルのあるモニタを約 100ms ごとに撮り、直近の数枚を
// リングに持つ。親から { id, type: 'pick', tick, x, y } を受けたら「tick より前に撮り終えた
// 最新の1枚」を、{ id, type: 'grab', x, y } ならその場で1枚撮って返す。
//
// FFI のクラッシュをアプリ本体から隔離するための分離で、このプロセスが死んでも録画は続く
// （親は従来の screenshot-desktop へ倒す）。uia-host.js と同じ作り。
// 仕様は docs/spec-preclick-capture.md 参照。
'use strict';

const port = process.parentPort;
if (!port) {
  console.error('capture-host: utilityProcess として起動されていません。');
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.error('capture-host: Windows 専用です。');
  process.exit(2);
}

let koffi;
try {
  koffi = require('koffi');
} catch (err) {
  console.error('capture-host: koffi を読み込めません:', err);
  process.exit(2);
}
const { pickFrameBefore, fillAlpha, ringSizeFor, nextCaptureDelay } = require('./preclick-frames');

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

// uiohook（親側）の座標は物理 px。DPI 非対応のままだとモニタの矩形が仮想化されてずれるため、
// 最初に Per-Monitor V2 を宣言する（uia-host.js と同じ）。
try {
  const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)');
  if (!SetProcessDpiAwarenessContext(-4 /* PER_MONITOR_AWARE_V2 */)) throw new Error('fallback');
} catch (_) {
  try { user32.func('bool __stdcall SetProcessDPIAware()')(); } catch (_) { /* そのまま続行 */ }
}

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const MONITORINFO = koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });

const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)');
const MonitorFromPoint = user32.func('void * __stdcall MonitorFromPoint(POINT pt, uint32 flags)');
const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *hmon, _Inout_ MONITORINFO *mi)');
const GetDC = user32.func('void * __stdcall GetDC(void *hwnd)');
const CreateCompatibleDC = gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)');
const CreateDIBSection = gdi32.func('void * __stdcall CreateDIBSection(void *hdc, uint8 *bmi, uint32 usage, _Out_ void **bits, void *section, uint32 offset)');
const SelectObject = gdi32.func('void * __stdcall SelectObject(void *hdc, void *h)');
const BitBlt = gdi32.func('bool __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *h)');
const GdiFlush = gdi32.func('bool __stdcall GdiFlush()');
const GetTickCount = kernel32.func('uint32 __stdcall GetTickCount()');
// DIB のメモリをリングの枠（Node の Buffer）へ写す。koffi.view で DIB のメモリを直接のぞく方法は、
// Electron の中では外部メモリの ArrayBuffer が禁止されていてプロセスごと落ちる（2026-09-29 に実測）。
const RtlMoveMemory = kernel32.func('void __stdcall RtlMoveMemory(uint8 *dst, void *src, size_t len)');

const SRCCOPY = 0x00cc0020; // CAPTUREBLT は付けない（撮るたびにカーソルがちらつくことがあるため）
const MONITOR_DEFAULTTONEAREST = 2;

// 物理 px の点を含むモニタの矩形
function monitorRectAt(x, y) {
  const hmon = MonitorFromPoint({ x, y }, MONITOR_DEFAULTTONEAREST);
  const mi = { cbSize: koffi.sizeof(MONITORINFO) };
  GetMonitorInfoW(hmon, mi);
  const r = mi.rcMonitor;
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}
function cursorMonitorRect() {
  const pt = {};
  GetCursorPos(pt);
  return monitorRectAt(pt.x, pt.y);
}
// 32bpp・上から下（biHeight を負）の BITMAPINFO（ヘッダ 40 バイト＋色表 4 バイト）
function bitmapInfo(w, h) {
  const b = Buffer.alloc(44);
  b.writeUInt32LE(40, 0);
  b.writeInt32LE(w, 4);
  b.writeInt32LE(-h, 8);
  b.writeUInt16LE(1, 12);
  b.writeUInt16LE(32, 14);
  return b;
}
const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const screenDC = GetDC(null);
const memDC = CreateCompatibleDC(screenDC);
// 今撮っているモニタ用の DIB とリング。モニタが変わったら作り直す（前のモニタの枚は捨てる）。
let surf = null; // { rect, hbm, old, bits, len, ring: [{ buf, start, end, rect, filled }], slot }

function surfaceFor(rect) {
  if (surf && sameRect(surf.rect, rect)) return surf;
  if (surf) {
    SelectObject(memDC, surf.old);
    DeleteObject(surf.hbm);
    surf = null;
  }
  const bitsOut = [null];
  const hbm = CreateDIBSection(memDC, bitmapInfo(rect.w, rect.h), 0 /* DIB_RGB_COLORS */, bitsOut, null, 0);
  if (!hbm || !bitsOut[0]) throw new Error('CreateDIBSection に失敗しました');
  const old = SelectObject(memDC, hbm);
  const len = rect.w * rect.h * 4;
  const ring = Array.from({ length: ringSizeFor(rect.w, rect.h) }, () => ({ buf: Buffer.alloc(len), start: 0, end: 0, rect, filled: false }));
  surf = { rect, hbm, old, bits: bitsOut[0], len, ring, slot: 0 };
  return surf;
}

// 1枚撮ってリングの次の枠に入れ、その枠を返す。
function captureInto(rect) {
  const s = surfaceFor(rect);
  const start = GetTickCount();
  BitBlt(memDC, 0, 0, rect.w, rect.h, screenDC, rect.x, rect.y, SRCCOPY);
  GdiFlush();
  const end = GetTickCount();
  const slot = s.ring[s.slot];
  RtlMoveMemory(slot.buf, s.bits, s.len);
  slot.start = start;
  slot.end = end;
  slot.rect = rect;
  slot.filled = true;
  s.slot = (s.slot + 1) % s.ring.length;
  return slot;
}

// 撮り続けるループ（間隔を守り、大きいモニタで1枚が長いときも最低限休む）
function loop() {
  const t0 = Date.now();
  try {
    captureInto(cursorMonitorRect());
  } catch (err) {
    // 一時的な失敗（画面ロック中など）は次の回に任せる
  }
  setTimeout(loop, nextCaptureDelay(Date.now() - t0));
}

// 親へ返す形（BGRA・アルファ 255。リングの枠は使い回すので複製して送る）
function frameReply(id, slot, source) {
  return {
    id, ok: true, source,
    width: slot.rect.w, height: slot.rect.h, rect: slot.rect,
    start: slot.start, end: slot.end,
    data: fillAlpha(Buffer.from(slot.buf)),
  };
}

port.on('message', (e) => {
  const msg = e && e.data;
  if (!msg || typeof msg.id !== 'number') return;
  let reply;
  try {
    if (msg.type === 'pick') {
      const frames = surf ? surf.ring.filter((r) => r.filled) : [];
      const slot = pickFrameBefore(frames, msg.tick, msg.x, msg.y, msg.maxAge);
      reply = slot ? frameReply(msg.id, slot, 'preclick') : { id: msg.id, ok: false };
    } else if (msg.type === 'grab') {
      reply = frameReply(msg.id, captureInto(monitorRectAt(msg.x, msg.y)), 'grab');
    } else {
      reply = { id: msg.id, ok: false, error: 'unknown type' };
    }
  } catch (err) {
    reply = { id: msg.id, ok: false, error: String((err && err.message) || err) };
  }
  try {
    port.postMessage(reply);
  } catch (_) { /* 親が先に終了した場合など。無視 */ }
});

loop();
