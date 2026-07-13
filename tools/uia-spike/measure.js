#!/usr/bin/env node
'use strict';
// =============================================================================
// 2-R0 UIA検証スパイク 計測ツール（koffi 版・本命）
//
// 目的: クリックのたびに Windows UI Automation (UIA) の ElementFromPoint で
//       UI 要素を解決し、「要素名 / 種類 / 矩形 / ウィンドウタイトル / アプリ名 /
//       取得可否 / 所要時間」を JSONL に記録する。録画エンジン v2（2-R2）の
//       実装可否と期待値を実測で判断するための使い捨て計測ツール。
//
// 使い方:
//   npm install
//   npm run selftest        … カーソル位置の要素を1回だけ解決して動作確認
//   npm run measure         … 計測開始（クリックするたびに記録）
//   停止: コンソールで q + Enter（または Ctrl+C）→ 集計を表示・保存して終了
//
// 本番実装（2-R2）と同じ経路（koffi FFI + UIA COM）を使う。これが動くこと自体が
// 検証項目のひとつ。動かない場合は measure.ps1（PowerShell 版・予備）で計測する。
// =============================================================================

const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') {
  console.error('このツールは Windows 専用です（Windows 実機で実行してください）。');
  process.exit(1);
}
if (!['x64', 'arm64'].includes(process.arch)) {
  console.error('64bit 版の Node.js で実行してください（現在: ' + process.arch + '）。');
  process.exit(1);
}

let koffi;
try {
  koffi = require('koffi');
} catch (e) {
  console.error('依存パッケージが見つかりません。このフォルダで `npm install` を実行してください。');
  process.exit(1);
}

const SELFTEST = process.argv.includes('--selftest');

// ── Win32 プレーン API ───────────────────────────────────────
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const ole32 = koffi.load('ole32.dll');
const oleaut32 = koffi.load('oleaut32.dll');

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

// uiohook は物理ピクセル座標を返す。プロセスが DPI 非対応のままだと
// WindowFromPoint / ElementFromPoint に渡す座標が仮想化されてズレるため、
// 最初に Per-Monitor V2 の DPI 対応を宣言する（失敗したら旧 API へフォールバック）。
try {
  const SetProcessDpiAwarenessContext = user32.func(
    'bool __stdcall SetProcessDpiAwarenessContext(intptr_t ctx)'
  );
  if (!SetProcessDpiAwarenessContext(-4 /* PER_MONITOR_AWARE_V2 */)) throw new Error('fallback');
} catch (_) {
  try {
    user32.func('bool __stdcall SetProcessDPIAware()')();
  } catch (_) { /* 非対応環境はそのまま続行 */ }
}

const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)');
const WindowFromPoint = user32.func('void * __stdcall WindowFromPoint(POINT pt)');
const GetAncestor = user32.func('void * __stdcall GetAncestor(void *hwnd, uint32 flags)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, uint8 *buf, int max)');
const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'
);
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const QueryFullProcessImageNameW = kernel32.func(
  'bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, uint8 *buf, _Inout_ uint32 *size)'
);
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');

const CoInitializeEx = ole32.func('long __stdcall CoInitializeEx(void *reserved, uint32 coinit)');
const CoCreateInstance = ole32.func(
  'long __stdcall CoCreateInstance(uint8 *clsid, void *outer, uint32 ctx, uint8 *iid, _Out_ void **ppv)'
);
const VariantClear = oleaut32.func('long __stdcall VariantClear(uint8 *v)');
const SafeArrayAccessData = oleaut32.func('long __stdcall SafeArrayAccessData(void *psa, _Out_ void **data)');
const SafeArrayUnaccessData = oleaut32.func('long __stdcall SafeArrayUnaccessData(void *psa)');

// UTF-16 出力バッファ（Buffer 渡し）→ JS 文字列
function wideBufToString(buf) {
  const s = buf.toString('utf16le');
  const nul = s.indexOf('\0');
  return nul >= 0 ? s.slice(0, nul) : s;
}

// "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" → GUID 16バイト（リトルエンディアン混在形式）
function guidBuf(str) {
  const hex = str.replace(/[{}-]/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}
const CLSID_CUIAutomation = guidBuf('ff48dba4-60ef-4201-aa87-54103eef594e');
const IID_IUIAutomation = guidBuf('30cbe57d-d9d0-452a-ab13-7ac5ac4825ee');

// ── COM vtable 呼び出しヘルパ ────────────────────────────────
// COM インスタンス（void*）の先頭は vtable へのポインタ。vtable の index 番目の
// 関数ポインタを prototype 付きで呼び出せる形に復元する。
const protoCache = new Map();
function comMethod(objPtr, index, signature) {
  let proto = protoCache.get(signature);
  if (!proto) {
    proto = koffi.proto(signature);
    protoCache.set(signature, proto);
  }
  const vtbl = koffi.decode(objPtr, 'void *');
  const fns = koffi.decode(vtbl, koffi.array('void *', index + 1));
  return koffi.decode(fns[index], koffi.pointer(proto));
}
function comRelease(objPtr) {
  try {
    comMethod(objPtr, 2, 'uint32 __stdcall IUnknown_Release(void *self)')(objPtr);
  } catch (_) { /* Release 失敗は無視（計測継続を優先） */ }
}

// ── VARIANT の読み取り ───────────────────────────────────────
// GetCurrentPropertyValue の出力（24バイト）。vt で分岐して値を取り出す。
const VariantBstr = koffi.struct('VariantBstr', {
  vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', str: 'str16', pad: 'uint64',
});
const VariantPtr = koffi.struct('VariantPtr', {
  vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', ptr: 'void *', pad: 'uint64',
});
const VT_I4 = 3, VT_BSTR = 8, VT_ARRAY_R8 = 0x2000 | 5;

function readVariant(buf) {
  const vt = buf.readUInt16LE(0);
  try {
    if (vt === VT_BSTR) return koffi.decode(buf, VariantBstr).str || '';
    if (vt === VT_I4) return buf.readInt32LE(8);
    if (vt === VT_ARRAY_R8) {
      const psa = koffi.decode(buf, VariantPtr).ptr;
      if (!psa) return null;
      const out = [null];
      if (SafeArrayAccessData(psa, out) !== 0 || !out[0]) return null;
      const arr = koffi.decode(out[0], koffi.array('double', 4));
      SafeArrayUnaccessData(psa);
      return arr; // [left, top, width, height]
    }
    return null; // VT_EMPTY など
  } finally {
    VariantClear(buf);
  }
}

// ── UIA プロパティ ID（公開定数・vtable 順序に依存しない）─────
const PROP = {
  BoundingRectangle: 30001,
  ProcessId: 30002,
  ControlType: 30003,
  LocalizedControlType: 30004,
  Name: 30005,
  ClassName: 30012,
  FrameworkId: 30024,
};
const CONTROL_TYPE_NAMES = {
  50000: 'Button', 50001: 'Calendar', 50002: 'CheckBox', 50003: 'ComboBox', 50004: 'Edit',
  50005: 'Hyperlink', 50006: 'Image', 50007: 'ListItem', 50008: 'List', 50009: 'Menu',
  50010: 'MenuBar', 50011: 'MenuItem', 50012: 'ProgressBar', 50013: 'RadioButton',
  50014: 'ScrollBar', 50015: 'Slider', 50016: 'Spinner', 50017: 'StatusBar', 50018: 'Tab',
  50019: 'TabItem', 50020: 'Text', 50021: 'ToolBar', 50022: 'ToolTip', 50023: 'Tree',
  50024: 'TreeItem', 50025: 'Custom', 50026: 'Group', 50027: 'Thumb', 50028: 'DataGrid',
  50029: 'DataItem', 50030: 'Document', 50031: 'SplitButton', 50032: 'Window', 50033: 'Pane',
  50034: 'Header', 50035: 'HeaderItem', 50036: 'Table', 50037: 'TitleBar', 50038: 'Separator',
  50039: 'SemanticZoom', 50040: 'AppBar',
};

// ── UIA 初期化 ───────────────────────────────────────────────
let uia = null;
function initUia() {
  // COINIT_MULTITHREADED = 0（UIA クライアントは MTA 推奨）
  const hr = CoInitializeEx(null, 0);
  if (hr < 0) throw new Error('CoInitializeEx failed: 0x' + (hr >>> 0).toString(16));
  const out = [null];
  const hr2 = CoCreateInstance(CLSID_CUIAutomation, null, 0x1 /* INPROC_SERVER */, IID_IUIAutomation, out);
  if (hr2 !== 0 || !out[0]) throw new Error('CoCreateInstance(CUIAutomation) failed: 0x' + (hr2 >>> 0).toString(16));
  uia = out[0];
}

// IUIAutomation vtable: 0-2 IUnknown, 3 CompareElements, 4 CompareRuntimeIds,
// 5 GetRootElement, 6 ElementFromHandle, 7 ElementFromPoint, ...
function elementFromPoint(x, y) {
  const fn = comMethod(uia, 7,
    'long __stdcall UIA_ElementFromPoint(void *self, POINT pt, _Out_ void **el)');
  const out = [null];
  const hr = fn(uia, { x, y }, out);
  if (hr !== 0 || !out[0]) throw new Error('ElementFromPoint failed: 0x' + (hr >>> 0).toString(16));
  return out[0];
}

// IUIAutomationElement vtable: 0-2 IUnknown, ..., 10 GetCurrentPropertyValue
function elementProp(el, propId) {
  const fn = comMethod(el, 10,
    'long __stdcall UIAEl_GetCurrentPropertyValue(void *self, int prop, uint8 *variant)');
  const v = Buffer.alloc(24);
  const hr = fn(el, propId, v);
  if (hr !== 0) return null;
  return readVariant(v);
}

// ── ウィンドウタイトル・アプリ名（Win32 直接。UIA が失敗しても取れる系統）──
function windowInfoAt(x, y) {
  const info = { windowTitle: '', appName: '', pid: 0 };
  try {
    const hwnd = WindowFromPoint({ x, y });
    if (!hwnd) return info;
    const root = GetAncestor(hwnd, 2 /* GA_ROOT */) || hwnd;
    const tbuf = Buffer.alloc(512 * 2);
    if (GetWindowTextW(root, tbuf, 512) > 0) info.windowTitle = wideBufToString(tbuf);
    const pidOut = [0];
    GetWindowThreadProcessId(root, pidOut);
    info.pid = pidOut[0];
    if (info.pid) {
      const h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, info.pid);
      if (h) {
        const nbuf = Buffer.alloc(1024 * 2);
        const size = [1024];
        if (QueryFullProcessImageNameW(h, 0, nbuf, size)) {
          info.appName = path.win32.basename(wideBufToString(nbuf));
        }
        CloseHandle(h);
      }
    }
  } catch (_) { /* ウィンドウ情報の失敗は空のまま */ }
  return info;
}

// ── 1クリック分の解決 ────────────────────────────────────────
function resolveAt(x, y, button) {
  const t0 = Date.now();
  const rec = {
    ts: new Date().toISOString(),
    x, y, button,
    ok: false,             // UIA で要素を解決できたか
    name: '',              // 要素名（「保存」等）
    controlType: 0,
    controlTypeName: '',
    localizedType: '',
    className: '',
    frameworkId: '',
    rect: null,            // [left, top, width, height]
    windowTitle: '',
    appName: '',
    pid: 0,
    elapsedMs: 0,
    error: '',
  };
  Object.assign(rec, windowInfoAt(x, y));
  let el = null;
  try {
    el = elementFromPoint(x, y);
    rec.ok = true;
    const name = elementProp(el, PROP.Name);
    rec.name = typeof name === 'string' ? name : '';
    const ct = elementProp(el, PROP.ControlType);
    rec.controlType = typeof ct === 'number' ? ct : 0;
    rec.controlTypeName = CONTROL_TYPE_NAMES[rec.controlType] || String(rec.controlType || '');
    const lt = elementProp(el, PROP.LocalizedControlType);
    rec.localizedType = typeof lt === 'string' ? lt : '';
    const cn = elementProp(el, PROP.ClassName);
    rec.className = typeof cn === 'string' ? cn : '';
    const fw = elementProp(el, PROP.FrameworkId);
    rec.frameworkId = typeof fw === 'string' ? fw : '';
    const rc = elementProp(el, PROP.BoundingRectangle);
    if (Array.isArray(rc)) rec.rect = rc.map((n) => Math.round(n));
  } catch (e) {
    rec.error = String(e.message || e);
  } finally {
    if (el) comRelease(el);
  }
  rec.elapsedMs = Date.now() - t0;
  return rec;
}

// ── 集計（summarize.js と同じロジック）──────────────────────
function summarize(records) {
  const byApp = new Map();
  for (const r of records) {
    const key = (r.appName || '(不明)').toLowerCase();
    if (!byApp.has(key)) byApp.set(key, { app: r.appName || '(不明)', total: 0, resolved: 0, named: 0, ms: [] });
    const a = byApp.get(key);
    a.total += 1;
    if (r.ok) a.resolved += 1;
    if (r.ok && r.name && r.name.trim()) a.named += 1;
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
  const named = records.filter((r) => r.ok && r.name && r.name.trim()).length;
  return { total, named, namedRate: total ? Math.round((named / total) * 100) : 0, byApp: rows };
}
function printSummary(sum) {
  console.log('\n──── 集計（要素名の取得率） ────');
  console.log('全体: ' + sum.named + '/' + sum.total + ' = ' + sum.namedRate + '%');
  console.log('\napp                          | clicks | 名前あり | 取得率 | 解決時間(中央値)');
  console.log('---------------------------- | ------ | -------- | ------ | ----');
  for (const r of sum.byApp) {
    console.log(
      r.app.padEnd(28).slice(0, 28) + ' | ' +
      String(r.total).padStart(6) + ' | ' +
      String(r.named).padStart(8) + ' | ' +
      String(r.namedRate + '%').padStart(6) + ' | ' +
      r.medianMs + 'ms'
    );
  }
  console.log('');
}

// ── メイン ───────────────────────────────────────────────────
function main() {
  try {
    initUia();
  } catch (e) {
    console.error('UIA の初期化に失敗しました: ' + (e.message || e));
    console.error('→ 予備の measure.ps1（PowerShell 版）で計測してください（README 参照）。');
    process.exit(2);
  }

  if (SELFTEST) {
    // カーソル位置の要素を1回だけ解決して結果を表示（配線の動作確認）。
    const pt = {};
    if (!GetCursorPos(pt)) { console.error('GetCursorPos に失敗しました。'); process.exit(2); }
    const rec = resolveAt(pt.x, pt.y, 0);
    console.log(JSON.stringify(rec, null, 2));
    console.log(rec.ok
      ? '\nセルフテスト成功。`npm run measure` で計測を開始できます。'
      : '\n要素解決に失敗しました。上記 error を README の連絡方法で報告してください。');
    process.exit(rec.ok ? 0 : 2);
  }

  let uIOhook;
  try {
    ({ uIOhook } = require('uiohook-napi'));
  } catch (e) {
    console.error('uiohook-napi を読み込めません。`npm install` を実行してください。');
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const outFile = path.join(__dirname, 'results-' + stamp + '.jsonl');
  const summaryFile = path.join(__dirname, 'summary-' + stamp + '.json');
  const records = [];
  let busy = false;

  console.log('計測を開始しました。ふだんの操作どおり対象アプリをクリックしてください。');
  console.log('  記録先: ' + outFile);
  console.log('  終了: このコンソールで q + Enter（または Ctrl+C）');
  console.log('  ※ このコンソール自体はクリックしないでください（計測対象に混ざります）\n');

  uIOhook.on('mousedown', (e) => {
    if (e.button !== 1 && e.button !== 2) return; // 左/右クリックのみ
    if (busy) return; // 解決中の連打はスキップ（計測を単純に保つ）
    busy = true;
    // フックコールバックを速やかに返すため、解決はイベントループへ逃がす。
    setImmediate(() => {
      try {
        const rec = resolveAt(e.x, e.y, e.button);
        records.push(rec);
        fs.appendFileSync(outFile, JSON.stringify(rec) + '\n');
        const label = rec.name ? '「' + rec.name.slice(0, 30) + '」' : '(名前なし)';
        console.log(
          '[' + String(records.length).padStart(3) + '] ' +
          (rec.appName || '?') + ' | ' + (rec.controlTypeName || '?') + ' | ' + label +
          ' | ' + rec.elapsedMs + 'ms' + (rec.error ? ' | ERROR: ' + rec.error : '')
        );
      } catch (err) {
        console.error('記録に失敗しました: ' + (err.message || err));
      } finally {
        busy = false;
      }
    });
  });

  function finish() {
    try { uIOhook.stop(); } catch (_) { /* noop */ }
    if (records.length) {
      const sum = summarize(records);
      printSummary(sum);
      fs.writeFileSync(summaryFile, JSON.stringify(sum, null, 2));
      console.log('結果ファイル:');
      console.log('  ' + outFile);
      console.log('  ' + summaryFile);
      console.log('→ この2ファイルを開発セッションへ共有してください（README の注意も参照）。');
    } else {
      console.log('記録は0件でした。');
    }
    process.exit(0);
  }
  process.on('SIGINT', finish);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    if (String(d).trim().toLowerCase() === 'q') finish();
  });

  try {
    uIOhook.start();
  } catch (e) {
    console.error('グローバルマウスフックを開始できません: ' + (e.message || e));
    process.exit(2);
  }
}

main();
