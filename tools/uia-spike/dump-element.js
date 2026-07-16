#!/usr/bin/env node
'use strict';
// =============================================================================
// 2-R2c ダンプツール — 「選択したフォルダ／項目名」を正しく読むための実機計測
//
// 目的: クリックのたびに UIA の ElementFromPoint で「最深の要素」を取り、そこから
//       ControlViewWalker で【親チェーン】を上へたどって各要素の
//       name / controlType / className / rect を記録する。これで
//         ・方式A: フォルダ表示名を持つ ListItem がどの階層に居るか（＝登り停止先）
//         ・方式B: アドレスバー（ブレッドクラム）をクリックしたときの要素構造
//         ・TreeWalker の vtable 呼び出しが実機で通るか（get_ControlViewWalker /
//           GetParentElement のインデックス確定）
//       を1回の計測で確定する。使い捨ての計測ツール（本番実装は別）。
//
// 使い方:
//   npm install
//   npm run selftest:dump   … カーソル位置の要素＋親チェーンを1回ダンプ（配線確認）
//   npm run dump            … 計測開始（クリックするたびに親チェーンを記録）
//   停止: コンソールで q + Enter（または Ctrl+C）
//
// 取ってほしい操作（詳細は README の「2-R2c ダンプ手順」参照）:
//   ① エクスプローラーを「詳細」表示にして、フォルダを1回クリック（＝方式A の材料）
//   ② 中／大アイコン表示でも同じフォルダを1回クリック
//   ③ 左のナビゲーションツリーのフォルダを1回クリック
//   ④ どこかのフォルダをダブルクリックして入ったあと、アドレスバーの
//      「現在フォルダ名」部分を1回クリック（＝方式B の材料）
//   → 生成された dump-*.jsonl を開発セッションへ共有。
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
const MAX_DEPTH = 14; // 親チェーンの最大段数（Window 到達か null で自然に止まる保険）

// ── Win32 プレーン API（measure.js と同じ配線）───────────────
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const ole32 = koffi.load('ole32.dll');
const oleaut32 = koffi.load('oleaut32.dll');

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

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

function wideBufToString(buf) {
  const s = buf.toString('utf16le');
  const nul = s.indexOf('\0');
  return nul >= 0 ? s.slice(0, nul) : s;
}

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

// ── COM vtable 呼び出しヘルパ（measure.js と同じ）───────────
const protoCache = new Map();
function comMethod(objPtr, index, signature) {
  let proto = protoCache.get(signature);
  if (!proto) {
    proto = koffi.proto(signature);
    protoCache.set(signature, proto);
  }
  const vtbl = koffi.decode(objPtr, 'void *');
  const fns = koffi.decode(vtbl, koffi.array('void *', index + 1));
  return koffi.decode(fns[index], proto);
}
function comRelease(objPtr) {
  try {
    comMethod(objPtr, 2, 'uint32 __stdcall IUnknown_Release(void *self)')(objPtr);
  } catch (_) { /* Release 失敗は無視 */ }
}

// ── VARIANT 読み取り（measure.js と同じ）─────────────────────
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
      const arr = Array.from(koffi.decode(out[0], koffi.array('double', 4)));
      SafeArrayUnaccessData(psa);
      return arr;
    }
    return null;
  } finally {
    VariantClear(buf);
  }
}

const PROP = {
  BoundingRectangle: 30001,
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

// ── UIA 初期化 ＋ ControlViewWalker 取得 ─────────────────────
let uia = null;
let controlWalker = null;

function initUia() {
  const hr = CoInitializeEx(null, 0); // MTA
  if (hr < 0) throw new Error('CoInitializeEx failed: 0x' + (hr >>> 0).toString(16));
  const out = [null];
  const hr2 = CoCreateInstance(CLSID_CUIAutomation, null, 0x1 /* INPROC_SERVER */, IID_IUIAutomation, out);
  if (hr2 !== 0 || !out[0]) throw new Error('CoCreateInstance(CUIAutomation) failed: 0x' + (hr2 >>> 0).toString(16));
  uia = out[0];
}

// IUIAutomation vtable 14: get_ControlViewWalker（実機確定対象）。
// 取れなければ親チェーンは空になるが、最深要素のダンプは続行する。
function initWalker() {
  try {
    const fn = comMethod(uia, 14,
      'long __stdcall UIA_get_ControlViewWalker(void *self, _Out_ void **walker)');
    const out = [null];
    const hr = fn(uia, out);
    if (hr === 0 && out[0]) { controlWalker = out[0]; return; }
    console.error('警告: get_ControlViewWalker が HRESULT 0x' + (hr >>> 0).toString(16) +
      ' を返しました（親チェーンは記録できません。vtable インデックス要確認）。');
  } catch (e) {
    console.error('警告: get_ControlViewWalker の呼び出しに失敗しました: ' + (e.message || e));
  }
}

// IUIAutomation vtable 7: ElementFromPoint。
function elementFromPoint(x, y) {
  const fn = comMethod(uia, 7,
    'long __stdcall UIA_ElementFromPoint(void *self, POINT pt, _Out_ void **el)');
  const out = [null];
  const hr = fn(uia, { x, y }, out);
  if (hr !== 0 || !out[0]) throw new Error('ElementFromPoint failed: 0x' + (hr >>> 0).toString(16));
  return out[0];
}

// IUIAutomationTreeWalker vtable 3: GetParentElement。null（ルート）は正常終了。
function parentElement(el) {
  if (!controlWalker) return null;
  const fn = comMethod(controlWalker, 3,
    'long __stdcall TW_GetParentElement(void *self, void *el, _Out_ void **parent)');
  const out = [null];
  const hr = fn(controlWalker, el, out);
  if (hr !== 0) return null;
  return out[0] || null;
}

// IUIAutomationElement vtable 10: GetCurrentPropertyValue。
function elementProp(el, propId) {
  const fn = comMethod(el, 10,
    'long __stdcall UIAEl_GetCurrentPropertyValue(void *self, int prop, uint8 *variant)');
  const v = Buffer.alloc(24);
  const hr = fn(el, propId, v);
  if (hr !== 0) return null;
  return readVariant(v);
}

function readElemInfo(el) {
  const info = { name: '', controlType: 0, controlTypeName: '', localizedType: '', className: '', frameworkId: '', rect: null };
  const name = elementProp(el, PROP.Name);
  info.name = typeof name === 'string' ? name : '';
  const ct = elementProp(el, PROP.ControlType);
  info.controlType = typeof ct === 'number' ? ct : 0;
  info.controlTypeName = CONTROL_TYPE_NAMES[info.controlType] || String(info.controlType || '');
  const lt = elementProp(el, PROP.LocalizedControlType);
  info.localizedType = typeof lt === 'string' ? lt : '';
  const cn = elementProp(el, PROP.ClassName);
  info.className = typeof cn === 'string' ? cn : '';
  const fw = elementProp(el, PROP.FrameworkId);
  info.frameworkId = typeof fw === 'string' ? fw : '';
  const rc = elementProp(el, PROP.BoundingRectangle);
  if (Array.isArray(rc)) info.rect = rc.map((n) => Math.round(n));
  return info;
}

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
  } catch (_) { /* 失敗は空のまま */ }
  return info;
}

// ── 1クリック分のダンプ（最深要素＋親チェーン）──────────────
function dumpAt(x, y, button, clicks) {
  const t0 = Date.now();
  const rec = {
    ts: new Date().toISOString(),
    x, y, button, clicks: clicks || 1,
    window: {},
    deepest: null,
    ancestors: [], // level 1 = 最深要素の親、2 = その親 … 上へ
    error: '',
  };
  Object.assign(rec.window, windowInfoAt(x, y));
  let deep = null;
  try {
    deep = elementFromPoint(x, y);
    rec.deepest = readElemInfo(deep);

    // 親チェーンを ControlView で上へたどる。cur は「今読んでいる要素」。
    // deep（最深要素）は最後に呼び出し側で release するので、ここでは release しない。
    let cur = deep;
    let ownCur = false; // cur を自分が所有していて release すべきか
    for (let i = 0; i < MAX_DEPTH; i++) {
      const parent = parentElement(cur);
      if (ownCur) comRelease(cur);
      if (!parent) { cur = null; break; }
      cur = parent;
      ownCur = true;
      const info = readElemInfo(cur);
      rec.ancestors.push({ level: i + 1, ...info });
      if (info.controlTypeName === 'Window') break; // トップに到達
    }
    if (ownCur && cur) comRelease(cur);
  } catch (e) {
    rec.error = String((e && e.message) || e);
  } finally {
    if (deep) comRelease(deep);
  }
  rec.elapsedMs = Date.now() - t0;
  return rec;
}

// ── 見やすいコンソール出力 ───────────────────────────────────
function fmtInfo(info) {
  const nm = info.name ? '「' + String(info.name).replace(/\s+/g, ' ').slice(0, 40) + '」' : '(名前なし)';
  const cn = info.className ? ' {' + info.className + '}' : '';
  return (info.controlTypeName || '?').padEnd(10) + ' ' + nm + cn;
}
function printDump(rec, index) {
  console.log('\n[' + index + '] ' + (rec.window.appName || '?') +
    ' | ' + (rec.window.windowTitle || '').slice(0, 40) +
    (rec.clicks >= 2 ? ' | ×' + rec.clicks : '') +
    ' | ' + rec.elapsedMs + 'ms');
  if (rec.error) console.log('    ERROR: ' + rec.error);
  if (rec.deepest) console.log('  最深: ' + fmtInfo(rec.deepest));
  for (const a of rec.ancestors) {
    console.log('    ↑' + String(a.level).padStart(2) + ' ' + fmtInfo(a));
  }
  if (rec.deepest && rec.ancestors.length === 0 && !rec.error) {
    console.log('    （親チェーンなし: ルート要素、または get_ControlViewWalker 未取得）');
  }
}

// ── メイン ───────────────────────────────────────────────────
function main() {
  try {
    initUia();
  } catch (e) {
    console.error('UIA の初期化に失敗しました: ' + (e.message || e));
    process.exit(2);
  }
  initWalker();

  if (SELFTEST) {
    const pt = {};
    if (!GetCursorPos(pt)) { console.error('GetCursorPos に失敗しました。'); process.exit(2); }
    const rec = dumpAt(pt.x, pt.y, 0, 1);
    printDump(rec, 0);
    console.log('\n' + JSON.stringify(rec, null, 2));
    const okWalker = !!controlWalker;
    console.log(okWalker
      ? '\nセルフテスト成功（親チェーン取得可）。`npm run dump` で計測を開始できます。'
      : '\n最深要素は取れましたが親チェーンが空です。get_ControlViewWalker の結果を報告してください。');
    process.exit(rec.deepest ? 0 : 2);
  }

  let uIOhook;
  try {
    ({ uIOhook } = require('uiohook-napi'));
  } catch (e) {
    console.error('uiohook-napi を読み込めません。`npm install` を実行してください。');
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const outFile = path.join(__dirname, 'dump-' + stamp + '.jsonl');
  const records = [];
  let busy = false;

  console.log('ダンプ計測を開始しました。README の「2-R2c ダンプ手順」の①〜④を1回ずつクリックしてください。');
  console.log('  記録先: ' + outFile);
  console.log('  終了: このコンソールで q + Enter（または Ctrl+C）');
  console.log('  ※ このコンソール自体はクリックしないでください\n');

  uIOhook.on('mousedown', (e) => {
    if (e.button !== 1 && e.button !== 2) return; // 左/右のみ
    if (busy) return;
    busy = true;
    setImmediate(() => {
      try {
        const rec = dumpAt(e.x, e.y, e.button, e.clicks);
        records.push(rec);
        fs.appendFileSync(outFile, JSON.stringify(rec) + '\n');
        printDump(rec, records.length);
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
      console.log('\n記録 ' + records.length + ' 件。結果ファイル:');
      console.log('  ' + outFile);
      console.log('→ このファイルを開発セッションへ共有してください（フォルダ名など固有名が');
      console.log('  含まれるため、共有前に中身を確認し、問題があれば伏せて構いません）。');
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
