// uia-host.js — UIA 要素解決の子プロセス（ロードマップ 2-R2）
// Electron の utilityProcess として録画中だけ起動される（親側は uia.js）。
// 親から {id, x, y} を受け取り、Windows UI Automation の ElementFromPoint で
// クリック座標の UI 要素（名前・種類・矩形・ウィンドウタイトル・アプリ名）を
// 解決して {id, ok, ...} を返信する。
//
// FFI/COM のクラッシュをアプリ本体から隔離するための分離であり、このプロセスが
// 死んでも録画は継続する（手順文がフォールバックになるだけ）。
// 実装は 2-R0 計測ツール（tools/uia-spike/measure.js）で実機検証済みの経路の本番化。
// スキーマは docs/spec-2-R2-uia-steptext.md 参照。
'use strict';

const path = require('path');

// utilityProcess では process.parentPort で親と通信する。
const port = process.parentPort;
if (!port) {
  console.error('uia-host: utilityProcess として起動されていません。');
  process.exit(2);
}
if (process.platform !== 'win32') {
  // 親側（uia.js）が Windows 以外では起動しない。二重の保険。
  console.error('uia-host: Windows 専用です。');
  process.exit(2);
}

let koffi;
try {
  koffi = require('koffi');
} catch (err) {
  console.error('uia-host: koffi を読み込めません:', err);
  process.exit(2);
}

// ── Win32 プレーン API ───────────────────────────────────────
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const ole32 = koffi.load('ole32.dll');
const oleaut32 = koffi.load('oleaut32.dll');

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

// uiohook（親側）は物理ピクセル座標を送ってくる。プロセスが DPI 非対応のままだと
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

const WindowFromPoint = user32.func('void * __stdcall WindowFromPoint(POINT pt)');
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
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
// 注: 関数ポインタの復元は koffi.decode(ptr, proto)。koffi.pointer(proto) で
//     包むとポインタ値(BigInt)が返り "fn is not a function" になる（2-R0 で実測）。
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
  } catch (_) { /* Release 失敗は無視（解決の継続を優先） */ }
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
      const arr = Array.from(koffi.decode(out[0], koffi.array('double', 4)));
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

// IUIAutomation vtable: 0-2 IUnknown, ..., 5 GetRootElement, 6 ElementFromHandle,
// 7 ElementFromPoint, 8 GetFocusedElement, ...
function elementFromPoint(x, y) {
  const fn = comMethod(uia, 7,
    'long __stdcall UIA_ElementFromPoint(void *self, POINT pt, _Out_ void **el)');
  const out = [null];
  const hr = fn(uia, { x, y }, out);
  if (hr !== 0 || !out[0]) throw new Error('ElementFromPoint failed: 0x' + (hr >>> 0).toString(16));
  return out[0];
}
// フォーカス中の要素（文字入力の対象。2-R2b）。
function focusedElement() {
  const fn = comMethod(uia, 8,
    'long __stdcall UIA_GetFocusedElement(void *self, _Out_ void **el)');
  const out = [null];
  const hr = fn(uia, out);
  if (hr !== 0 || !out[0]) throw new Error('GetFocusedElement failed: 0x' + (hr >>> 0).toString(16));
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
function windowInfoFor(hwnd) {
  const info = { windowTitle: '', appName: '', pid: 0 };
  try {
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
function windowInfoAt(x, y) {
  try {
    return windowInfoFor(WindowFromPoint({ x, y }));
  } catch (_) {
    return { windowTitle: '', appName: '', pid: 0 };
  }
}

// ── 1操作分の解決（uia.js への返信ペイロード）────────────────
// getElement で要素を取り、windowInfo（Win32 系統）と合成する共通処理。
function resolveWith(getElement, windowInfo) {
  const t0 = Date.now();
  const rec = {
    ok: false,
    name: '',
    controlType: 0,
    controlTypeName: '',
    localizedType: '',
    className: '',
    frameworkId: '',
    rect: null, // [left, top, width, height] 物理px・スクリーン座標
    windowTitle: '',
    appName: '',
    elapsedMs: 0,
    error: '',
  };
  Object.assign(rec, windowInfo);
  delete rec.pid;
  let el = null;
  try {
    el = getElement();
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
    rec.error = String((e && e.message) || e);
  } finally {
    if (el) comRelease(el);
  }
  rec.elapsedMs = Date.now() - t0;
  return rec;
}

function resolveAt(x, y) {
  return resolveWith(() => elementFromPoint(x, y), windowInfoAt(x, y));
}

// フォーカス要素の解決（2-R2b: 文字入力の対象）。ウィンドウ情報は前面ウィンドウから。
function resolveFocused() {
  let winInfo = { windowTitle: '', appName: '', pid: 0 };
  try {
    winInfo = windowInfoFor(GetForegroundWindow());
  } catch (_) { /* 空のまま */ }
  return resolveWith(() => focusedElement(), winInfo);
}

// ── メイン: 親からの要求に応答 ───────────────────────────────
try {
  initUia();
} catch (err) {
  // 初期化に失敗したら応答不能なので終了する（親側は exit を検知して以降
  // フォールバックに倒す）。
  console.error('uia-host: UIA の初期化に失敗しました:', err);
  process.exit(2);
}

port.on('message', (e) => {
  const msg = e && e.data;
  if (!msg || typeof msg.id !== 'number') return;
  let reply;
  try {
    // focus:true はフォーカス要素の解決（2-R2b）、それ以外は座標の解決（2-R2）。
    reply = { id: msg.id, ...(msg.focus ? resolveFocused() : resolveAt(msg.x, msg.y)) };
  } catch (err) {
    reply = { id: msg.id, ok: false, error: String((err && err.message) || err) };
  }
  try {
    port.postMessage(reply);
  } catch (_) { /* 親が先に終了した場合など。無視 */ }
});
