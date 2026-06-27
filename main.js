// main.js — Electron メインプロセス
// 役割:
//  - メインウィンドウ（index.html）の生成
//  - 「録画」開始/停止の制御
//  - 録画中はグローバルなマウスクリックを監視し、左/右クリックの度に
//    「クリックしたモニタ」をキャプチャして「00_スクリーンショット」へ保存
//  - クリック位置に赤い中抜きリングのマーカーを合成
//  - スクリーンショットに写らないオーバーレイ「ガジェット」窓の表示
//  - 失敗（権限拒否・フック開始失敗・キャプチャ失敗）はガジェットへ警告通知
//  - 上記とレンダラー間の IPC 仲介
//
// 確定仕様の詳細は docs/録画機能-仕様.md「実装前に確定した詳細仕様」を参照。
'use strict';

const { app, BrowserWindow, ipcMain, screen, nativeImage } = require('electron');
const path = require('path');

// アプリケーション名（メニュー/Dock/通知などに表示される）。
// package.json の productName と一致させ、「CheckListMaker」一本に統一する。
app.setName('CheckListMaker');
const fs = require('fs');
const screenshot = require('screenshot-desktop');
const { uIOhook } = require('uiohook-napi');

let mainWin = null;
let gadgetWin = null;

// ── プラットフォーム ─────────────────────────────────────────
// Linux/X11 では setContentProtection が効かないことがあるため、
// 撮影直前にガジェットを隠す方式へ倒す（docs の決定事項参照）。
const IS_LINUX = process.platform === 'linux';

// ── マウスボタン定数（libuiohook 準拠）──────────────────────
// MOUSE_BUTTON1=左, 2=右, 3=中, 4/5=サイド。撮影は左/右のみ。
// ※ 実機でボタン番号が想定どおりか要確認（docs の検証手順）。
const BTN_LEFT = 1;
const BTN_RIGHT = 2;
function isShootableButton(button) {
  return button === BTN_LEFT || button === BTN_RIGHT;
}

// ── 撮影パラメータ（初期値・実機で微調整可）──────────────────
const DRAG_THRESHOLD = 5; // down→up がこの物理px超で動いたらドラッグ＝撮影しない
const DEBOUNCE_MS = 300; // 直近撮影からこの時間内＋近接なら1枚に集約
const DEBOUNCE_DIST = 24; // デバウンス対象とみなす物理pxの近接距離
const MARKER_RADIUS = 20; // 中抜きリング半径(px, scaleFactor 比例前)
const MARKER_LINE_WIDTH = 4; // リングの線幅(px, 同上)
const MARKER_COLOR = '#ef4444';

// ── 録画状態 ────────────────────────────────────────────────
let recording = false;
let capturing = false; // キャプチャ多重実行の防止
let sessionShots = 0; // この録画セッションでの撮影枚数（ガジェット表示用）
let recordName = ''; // ファイル名の接頭辞（チェックリスト名をサニタイズしたもの）
let startTime = 0; // 録画開始時刻(ms)

// マウス押下情報（ドラッグ判定用）と直近撮影（デバウンス用）。
let pendingDown = null; // { button, x, y }
let lastShot = { x: 0, y: 0, t: 0 };

// ── パス・名前ユーティリティ ─────────────────────────────────
// 保存ベースディレクトリ = 「アプリのあるディレクトリ」。
//  - 配布(パッケージ)時: 実行ファイルのあるフォルダ
//  - 開発時: このプロジェクトのフォルダ
function baseDir() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
}
function screenshotDir() {
  return path.join(baseDir(), '00_スクリーンショット');
}
// Windows/macOS/Linux で使えないファイル名文字を除去する。
function sanitizeName(s) {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>| -]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return cleaned || '記録';
}
function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
// 正規表現で使う特殊文字をエスケープ（サニタイズ後の名前にも念のため適用）。
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 同名・同日ファイルの「次の番号」を返す。
// `<名前>_<日付>_<番号>.png` の既存最大番号+1。日付が変われば自然に 1 から。
// （ファイル名に日付を含むため、日をまたいでも上書きは起きない。）
function nextSequence(name, stamp) {
  const dir = screenshotDir();
  const re = new RegExp(`^${escapeRegExp(name)}_${stamp}_(\\d+)\\.png$`);
  let max = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = re.exec(f);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
  } catch (_) {
    /* ディレクトリが無い等は max=0 のまま（=1 から開始） */
  }
  return max + 1;
}

// ── ウィンドウ生成 ──────────────────────────────────────────
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'CheckListMaker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadFile('index.html');
  mainWin.on('closed', () => {
    mainWin = null;
  });
}

// スクリーンショットに写らない録画ガジェット窓。
function createGadget() {
  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;
  gadgetWin = new BrowserWindow({
    width: 300,
    height: 188,
    x: width - 320,
    y: 24,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Windows10(2004+)/macOS では画面キャプチャから除外できる。
  // Linux/X11 では効かないことがあるため、その場合は撮影直前に隠す方式
  // （captureAndSave 内）で確実に除外する。
  if (!IS_LINUX) gadgetWin.setContentProtection(true);
  gadgetWin.setAlwaysOnTop(true, 'screen-saver');
  gadgetWin.loadFile('gadget.html');
  gadgetWin.webContents.on('did-finish-load', () => {
    if (gadgetWin && !gadgetWin.isDestroyed()) {
      gadgetWin.webContents.send('gadget:init', { startTime, name: recordName });
    }
  });
  gadgetWin.on('closed', () => {
    // ガジェットを直接閉じられたら録画も止める。
    gadgetWin = null;
    if (recording) stopRecording();
  });
}

// ── 録画制御 ────────────────────────────────────────────────
function startRecording(rawName) {
  if (recording) return { ok: true };
  recording = true;
  sessionShots = 0;
  pendingDown = null;
  lastShot = { x: 0, y: 0, t: 0 };
  startTime = Date.now();
  recordName = sanitizeName(rawName);
  try {
    fs.mkdirSync(screenshotDir(), { recursive: true });
  } catch (err) {
    console.error('保存フォルダの作成に失敗しました:', err);
  }
  createGadget();
  try {
    uIOhook.start();
  } catch (err) {
    console.error('グローバルマウスフックの開始に失敗しました:', err);
    // macOS の「アクセシビリティ」未許可などで失敗し得る。ユーザーに気づかせる。
    warnGadget('入力監視を開始できません。OSの許可（アクセシビリティ）を確認してください。');
  }
  notifyState();
  return { ok: true };
}

function stopRecording() {
  if (!recording) return { ok: true };
  recording = false;
  pendingDown = null;
  try {
    uIOhook.stop();
  } catch (err) {
    console.error('グローバルマウスフックの停止に失敗しました:', err);
  }
  if (gadgetWin && !gadgetWin.isDestroyed()) {
    const w = gadgetWin;
    gadgetWin = null; // closed ハンドラから再帰停止しないよう先に外す
    w.close();
  }
  notifyState();
  return { ok: true };
}

function notifyState() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('rec:state', { recording, count: sessionShots });
  }
}

// ガジェットへ警告（赤字表示）を送る。撮影したのに0枚、を防ぐための導線。
function warnGadget(message) {
  if (gadgetWin && !gadgetWin.isDestroyed()) {
    gadgetWin.webContents.send('gadget:warn', { message });
  }
}

// ── 座標・ディスプレイ ──────────────────────────────────────
// uiohook は物理ピクセル座標。getBounds/各 display.bounds は DIP。HiDPI のため変換する。
function toDip(physX, physY) {
  try {
    return screen.screenToDipPoint({ x: physX, y: physY });
  } catch (_) {
    return { x: physX, y: physY }; // 変換非対応プラットフォームは物理のまま
  }
}

// クリック座標（物理px）が自アプリ窓（メイン窓・ガジェット窓）の上かどうか。
// 自アプリの操作（録画ボタン・停止ボタン含む）は撮影対象から外す。
function isOnOwnWindow(physX, physY) {
  const pt = toDip(physX, physY);
  const inBounds = (win) => {
    if (!win || win.isDestroyed() || !win.isVisible()) return false;
    const b = win.getBounds();
    return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
  };
  return inBounds(gadgetWin) || inBounds(mainWin);
}

// クリックした物理座標から、撮影対象のディスプレイ情報を求める。
// 返り値: { disp(Electron Display), shotId(screenshot-desktop の screen 指定/該当なしは null) }
async function resolveTargetDisplay(physX, physY) {
  const dip = toDip(physX, physY);
  const disp = screen.getDisplayNearestPoint(dip);
  let shotId = null;
  try {
    // ※ screenshot-desktop の列挙順/ID と Electron display.id は一致保証がない。
    //   ここでは getAllDisplays の並び順 index で対応付ける。実機で要検証（docs 参照）。
    const list = await screenshot.listDisplays();
    const all = screen.getAllDisplays();
    const idx = all.findIndex((d) => d.id === disp.id);
    if (idx >= 0 && list[idx]) shotId = list[idx].id;
  } catch (_) {
    /* 列挙失敗時はフル/プライマリ撮影へフォールバック */
  }
  return { disp, shotId };
}

// 撮影画像（物理px）にクリック位置の赤い中抜きリングを合成する。
// 新規依存を避け、メイン窓 renderer の canvas を executeJavaScript 経由で利用。
// 失敗時は素の画像（pngBuffer）をそのまま返す。
async function drawMarker(pngBuffer, relX, relY, scaleFactor) {
  if (!mainWin || mainWin.isDestroyed()) return pngBuffer;
  const radius = MARKER_RADIUS * scaleFactor;
  const lineWidth = MARKER_LINE_WIDTH * scaleFactor;
  const b64 = pngBuffer.toString('base64');
  const script = `(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${b64}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.beginPath();
    ctx.arc(${relX}, ${relY}, ${radius}, 0, Math.PI * 2);
    ctx.lineWidth = ${lineWidth};
    ctx.strokeStyle = ${JSON.stringify(MARKER_COLOR)};
    ctx.stroke();
    return c.toDataURL('image/png');
  })()`;
  try {
    const dataUrl = await mainWin.webContents.executeJavaScript(script, true);
    const base64 = String(dataUrl).split(',')[1];
    if (base64) return Buffer.from(base64, 'base64');
  } catch (err) {
    console.error('マーカー合成に失敗しました（素の画像を保存します）:', err);
  }
  return pngBuffer;
}

// 1クリック=1枚を撮影して保存する。physX/physY はクリックの物理座標。
async function captureAndSave(physX, physY) {
  const { disp, shotId } = await resolveTargetDisplay(physX, physY);

  // Linux で setContentProtection が効かない前提のため、撮影中はガジェットを隠す。
  const hideForShot = IS_LINUX && gadgetWin && !gadgetWin.isDestroyed() && gadgetWin.isVisible();
  try {
    if (hideForShot) gadgetWin.hide();

    const opts = { format: 'png' };
    if (shotId != null) opts.screen = shotId;
    const raw = await screenshot(opts);

    // クリックの物理相対座標（撮影したモニタの左上原点）。
    const relX = physX - disp.bounds.x * disp.scaleFactor;
    const relY = physY - disp.bounds.y * disp.scaleFactor;
    const buf = await drawMarker(raw, relX, relY, disp.scaleFactor);

    const stamp = dateStamp();
    const seq = nextSequence(recordName, stamp);
    const fileName = `${recordName}_${stamp}_${seq}.png`;
    const filePath = path.join(screenshotDir(), fileName);
    fs.writeFileSync(filePath, buf);
    sessionShots += 1;

    let preview = '';
    try {
      preview = nativeImage.createFromBuffer(buf).resize({ width: 220 }).toDataURL();
    } catch (_) {
      /* サムネイル生成失敗は無視 */
    }
    if (gadgetWin && !gadgetWin.isDestroyed()) {
      gadgetWin.webContents.send('gadget:update', {
        count: sessionShots,
        preview,
        file: fileName,
      });
    }
  } catch (err) {
    console.error('スクリーンショットの保存に失敗しました:', err);
    warnGadget('スクリーンショットを保存できません。画面収録の許可や保存先を確認してください。');
  } finally {
    if (hideForShot && gadgetWin && !gadgetWin.isDestroyed()) gadgetWin.show();
  }
}

// 直近撮影からの時間＋近接でデバウンス（ダブルクリック/連打を1枚に集約）。
function shouldDebounce(physX, physY) {
  const dt = Date.now() - lastShot.t;
  if (dt > DEBOUNCE_MS) return false;
  const dist = Math.hypot(physX - lastShot.x, physY - lastShot.y);
  return dist <= DEBOUNCE_DIST;
}

// ── マウス監視ハンドラ ──────────────────────────────────────
// 押下位置を覚えておき、離した位置との移動量でドラッグ/クリックを判別する。
function onMouseDown(e) {
  if (!recording) return;
  pendingDown = { button: e.button, x: e.x, y: e.y };
}

function onMouseUp(e) {
  if (!recording || capturing) return;
  const down = pendingDown;
  pendingDown = null;
  if (!down || down.button !== e.button) return; // 押下情報と不整合
  if (!isShootableButton(e.button)) return; // 左/右以外（中・サイド）は撮らない
  // 押下→離上が大きく動いた＝ドラッグは撮らない。
  if (Math.hypot(e.x - down.x, e.y - down.y) > DRAG_THRESHOLD) return;
  if (isOnOwnWindow(e.x, e.y)) return; // 自アプリ（メイン窓・ガジェット）は撮らない
  if (shouldDebounce(e.x, e.y)) return; // ダブルクリック/連打の2枚目以降は撮らない

  lastShot = { x: e.x, y: e.y, t: Date.now() };
  capturing = true;
  captureAndSave(e.x, e.y).finally(() => {
    capturing = false;
  });
}

// ── アプリ起動 ──────────────────────────────────────────────
app.whenReady().then(() => {
  // ハンドラは一度だけ登録し、内部の recording フラグで制御する。
  uIOhook.on('mousedown', onMouseDown);
  uIOhook.on('mouseup', onMouseUp);

  ipcMain.handle('rec:start', (_e, name) => startRecording(name));
  ipcMain.handle('rec:stop', () => stopRecording());

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 終了時はフックを確実に止める。
app.on('before-quit', () => {
  try {
    uIOhook.stop();
  } catch (_) {
    /* noop */
  }
});
