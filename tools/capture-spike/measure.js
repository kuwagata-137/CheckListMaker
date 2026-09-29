// capture-spike/measure.js — クリック直前キャプチャ（v1.0.8 作業2）のスパイク。
// GDI（CreateDIBSection + BitBlt）でカーソルのあるモニタを一定間隔で撮り続け、
// 1枚あたりの所要時間と CPU 負荷を測る。撮った画面はメモリ上のリングに置くだけで、
// ファイルには一切保存しない（画面の内容を残さないため）。
//
// 使い方（Windows・リポジトリ直下で）:
//   node tools/capture-spike/measure.js [秒数=8] [間隔ms…=100 150 200]
// 結果は docs/spec-preclick-capture.md の「スパイクの結果」に転記する。
'use strict';

const path = require('path');

if (process.platform !== 'win32') {
  console.error('Windows 専用です。');
  process.exit(2);
}
const koffi = require(path.join(__dirname, '..', '..', 'node_modules', 'koffi'));

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

// 物理ピクセルで座標・大きさを扱うため Per-Monitor V2 を宣言する（uia-host.js と同じ）。
try {
  const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)');
  if (!SetProcessDpiAwarenessContext(-4)) throw new Error('fallback');
} catch (_) {
  try { user32.func('bool __stdcall SetProcessDPIAware()')(); } catch (_) { /* そのまま */ }
}

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const MONITORINFO = koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });

const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)');
const MonitorFromPoint = user32.func('void * __stdcall MonitorFromPoint(POINT pt, uint32 flags)');
const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *hmon, _Inout_ MONITORINFO *mi)');
const GetDC = user32.func('void * __stdcall GetDC(void *hwnd)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(void *hwnd, void *hdc)');
const CreateCompatibleDC = gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)');
const CreateDIBSection = gdi32.func('void * __stdcall CreateDIBSection(void *hdc, uint8 *bmi, uint32 usage, _Out_ void **bits, void *section, uint32 offset)');
const SelectObject = gdi32.func('void * __stdcall SelectObject(void *hdc, void *h)');
const BitBlt = gdi32.func('bool __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *h)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(void *hdc)');
const GdiFlush = gdi32.func('bool __stdcall GdiFlush()');
const GetTickCount = kernel32.func('uint32 __stdcall GetTickCount()');
// 本番（capture-host.js）と同じく RtlMoveMemory で写す（koffi.view は Electron の中では使えない）
const RtlMoveMemory = kernel32.func('void __stdcall RtlMoveMemory(uint8 *dst, void *src, size_t len)');

const SRCCOPY = 0x00cc0020;
const MONITOR_DEFAULTTONEAREST = 2;

function cursorMonitorRect() {
  const pt = {};
  GetCursorPos(pt);
  const hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
  const mi = { cbSize: koffi.sizeof(MONITORINFO) };
  GetMonitorInfoW(hmon, mi);
  const r = mi.rcMonitor;
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

// 32bpp・上から下（biHeight を負）の BITMAPINFO（ヘッダ 40 バイト＋色表 4 バイト）
function bitmapInfo(w, h) {
  const b = Buffer.alloc(44);
  b.writeUInt32LE(40, 0);   // biSize
  b.writeInt32LE(w, 4);     // biWidth
  b.writeInt32LE(-h, 8);    // biHeight（負＝上から下）
  b.writeUInt16LE(1, 12);   // biPlanes
  b.writeUInt16LE(32, 14);  // biBitCount
  b.writeUInt32LE(0, 16);   // biCompression = BI_RGB
  return b;
}

function measure(intervalMs, seconds, ringSize) {
  const mon = cursorMonitorRect();
  const screenDC = GetDC(null);
  const memDC = CreateCompatibleDC(screenDC);
  const bitsOut = [null];
  const hbm = CreateDIBSection(memDC, bitmapInfo(mon.w, mon.h), 0, bitsOut, null, 0);
  const old = SelectObject(memDC, hbm);
  const len = mon.w * mon.h * 4;
  const ring = Array.from({ length: ringSize }, () => ({ buf: Buffer.alloc(len), tick: 0 }));
  let slot = 0;
  const times = [];
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const s = process.hrtime.bigint();
      BitBlt(memDC, 0, 0, mon.w, mon.h, screenDC, mon.x, mon.y, SRCCOPY);
      GdiFlush();
      const tick = GetTickCount();
      // DIB のメモリをリングの枠へ写す（複製1回）
      RtlMoveMemory(ring[slot].buf, bitsOut[0], len);
      ring[slot].tick = tick;
      slot = (slot + 1) % ringSize;
      times.push(Number(process.hrtime.bigint() - s) / 1e6);
    }, intervalMs);
    setTimeout(() => {
      clearInterval(timer);
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      const cpu = process.cpuUsage(cpu0);
      // 中身の確認：最後の枠で、0 でない画素の割合（真っ黒＝撮れていない、を見分ける）
      const last = ring[(slot + ringSize - 1) % ringSize].buf;
      let nonzero = 0;
      for (let i = 0; i < last.length; i += 4 * 97) if (last[i] | last[i + 1] | last[i + 2]) nonzero++;
      SelectObject(memDC, old);
      DeleteObject(hbm);
      DeleteDC(memDC);
      ReleaseDC(null, screenDC);
      times.sort((a, b) => a - b);
      const q = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
      resolve({
        intervalMs,
        monitor: `${mon.w}×${mon.h}`,
        frames: times.length,
        captureMs: { avg: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +times[times.length - 1].toFixed(1) },
        cpuPercentOfOneCore: +(((cpu.user + cpu.system) / 1000) / wall * 100).toFixed(1),
        ringMB: +(len * ringSize / 1048576).toFixed(1),
        nonBlackSample: +(nonzero / Math.ceil(last.length / (4 * 97)) * 100).toFixed(1) + '%',
      });
    }, seconds * 1000);
  });
}

(async () => {
  const seconds = Number(process.argv[2] || 8);
  const intervals = process.argv.slice(3).map(Number).filter((n) => n > 0);
  const list = intervals.length ? intervals : [100, 150, 200];
  const out = [];
  for (const iv of list) out.push(await measure(iv, seconds, 4));
  console.log(JSON.stringify(out, null, 1));
})();
