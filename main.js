// main.js — Electron メインプロセス
// 役割:
//  - メインウィンドウ（index.html）の生成
//  - 「録画」開始/停止の制御
//  - 録画中はグローバルなマウスクリックを監視し、左/右クリックの度に
//    「クリックしたモニタ」をキャプチャして、ユーザーの「ピクチャ」内の
//    「CheckListMaker」配下のセッションフォルダへ、クリック情報の JSON と
//    併記で保存（形式は session.js / docs/spec-2-R1-session-format.md）
//  - クリック箇所のハイライト合成（UIA 要素枠。取れなければ赤い中抜きリング）と
//    拡大画像（NNNz.png）の自動生成（zoomcrop.js / 2-R3）
//  - スクリーンショットに写らないオーバーレイ「ガジェット」窓の表示
//  - 失敗（権限拒否・フック開始失敗・キャプチャ失敗）はガジェットへ警告通知
//  - 上記とレンダラー間の IPC 仲介
//
// 確定仕様の詳細は docs/録画機能-仕様.md「実装前に確定した詳細仕様」を参照。
'use strict';

const { app, BrowserWindow, Menu, ipcMain, screen, nativeImage, shell, dialog } = require('electron');
const path = require('path');

// アプリケーション名（メニュー/Dock/通知などに表示される）。
// package.json の productName と一致させ、「CheckListMaker」一本に統一する。
app.setName('CheckListMaker');
const fs = require('fs');
const screenshot = require('screenshot-desktop');
const { uIOhook } = require('uiohook-napi');
const { initStorage } = require('./storage');
const { initErrorLog } = require('./errorlog');
const session = require('./session');
const uia = require('./uia');
const { normalizeUia, stepText, dblClickText, inputText, keyStepText, dragText } = require('./steptext');
const { classifyKeydown } = require('./keys');
const { planShot } = require('./zoomcrop');

let mainWin = null;
let gadgetWin = null;
let guideWin = null; // ガイド小窓（3-R6）

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
const DRAG_MIN_DIST = 24; // ドラッグ記録ON時、これ以上動いたらドラッグとして記録（2-R2b ④）
const DEBOUNCE_MS = 300; // 直近撮影からこの時間内＋近接なら1枚に集約
const DEBOUNCE_DIST = 24; // デバウンス対象とみなす物理pxの近接距離
const MARKER_RADIUS = 20; // 中抜きリング半径(px, scaleFactor 比例前)
const MARKER_LINE_WIDTH = 4; // リングの線幅(px, 同上)
const MARKER_COLOR = '#ef4444';

// ── 録画状態 ────────────────────────────────────────────────
let recording = false;
let sessionShots = 0; // この録画セッションでの撮影枚数（ガジェット表示用）
let recordName = ''; // ファイル名の接頭辞（チェックリスト名をサニタイズしたもの）
let startTime = 0; // 録画開始時刻(ms)
let clickMarkerOn = true; // クリック位置の赤丸を合成するか（ガジェットのトグル。セッション単位）
let dragRecordOn = false; // ドラッグを記録するか（ガジェットのトグル。既定OFF・セッション単位。2-R2b ④）

// ── 事前キャプチャ（クリック「直前」のフレームバッファ） ─────────
// mousedown を合図に撮影を始めても、ディスプレイ列挙＋撮影プロセス起動のぶん
// 実際のピクセル取得は遅れ、「クリックで消えるウインドウ」が写らないことがある。
// そこで録画中はカーソルのあるディスプレイをバックグラウンドで定期撮影して
// 最新フレームを保持し、mousedown 時は「その直前のフレーム」を保存する。
// ★ PRECAPTURE_INTERVAL_MS = 0 にするとポーリングは完全に無効化され、
//   従来どおり mousedown 時のオンデマンド撮影のみになる（CPU負荷が過大な
//   環境での退避先。挙動はこの定数1つで切り替わる）。
const PRECAPTURE_INTERVAL_MS = 500;
const PRECAPTURE_MAX_AGE_MS = 1500; // これより古いバッファは使わない
const DISPLAY_LIST_TTL_MS = 10000; // screenshot.listDisplays() キャッシュの寿命

let lastCursor = { x: 0, y: 0 }; // uiohook mousemove の物理px座標
let preFrame = null; // { raw, disp, ts } 最新の事前キャプチャ1枚
let preTimer = null;
let captureBusy = false; // ポーリングとクリック撮影の多重実行を抑止
let displayListCache = null; // { list, ts }

// マウス押下情報（ドラッグ判定用）と直近撮影（デバウンス用）。
let pendingDown = null; // { button, x, y }
// 「クリック反応の直前」を捉えるため、押下(mousedown)の瞬間に撮影を開始し、
// 離上(mouseup)で保存可否を確定する。pendingCapture はその撮影 Promise。
let pendingCapture = null; // Promise<{raw,disp,physX,physY}|null> | null
// 保存処理を直列化するためのチェーン（nextSequence 採番と書き込みの競合を防ぐ）。
let persistChain = Promise.resolve();
let lastShot = { x: 0, y: 0, t: 0 };

// ── キーボード監視の状態（2-R2b ②③）─────────────────────────
// 入力内容（押された文字）は一切保持・記録しない。押下中キー集合はリピート抑止用。
const pressedKeys = new Set(); // 押下中のキーコード（keydown/keyup で増減）
let typing = null; // タイピングバースト { uiaPromise } | null（入力中の対象要素の解決）
let lastKeyStep = { combo: '', t: 0 }; // 同一ショートカット連打の集約用
let lastAppName = null; // 直近保存ステップのアプリ名（アプリ切替検出 2-R2b ⑤）

// ── パス・名前ユーティリティ ─────────────────────────────────
// フォールバック用のベースディレクトリ = 「アプリのあるディレクトリ」。
//  - 配布(パッケージ)時: 実行ファイルのあるフォルダ
//  - 開発時: このプロジェクトのフォルダ
function baseDir() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
}
// 保存先はユーザーの「ピクチャ」直下の「CheckListMaker」フォルダ。
// （Windows なら %USERPROFILE%\Pictures\CheckListMaker）
function screenshotDir() {
  try {
    return path.join(app.getPath('pictures'), 'CheckListMaker');
  } catch (_) {
    // ピクチャを取得できない環境では、アプリのあるディレクトリ直下へフォールバック。
    return path.join(baseDir(), 'CheckListMaker');
  }
}
// レンダラーから受け取るセッションフォルダ引数の検証（2-R4）。
// 「ピクチャ配下 CheckListMaker」の直下に解決されるパスだけを許可する
// （レンダラー侵害時に任意のフォルダ・ファイルへ触らせないため）。不正は null。
function resolveSessionDirArg(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const resolved = path.resolve(dir);
  return path.dirname(resolved) === path.resolve(screenshotDir()) ? resolved : null;
}
// セッション内の画像ファイル名（001.png / 001z.png / 001e.png 形式）だけを許可する。
// z = 拡大（2-R3）・e = ドラッグ終点（2-R2b）。
const SESSION_IMAGE_RE = /^\d{3,}[ze]?\.png$/;

// Windows/macOS/Linux で使えないファイル名文字を除去する。
function sanitizeName(s) {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>| -]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return cleaned || '記録';
}
// ── アプリケーションメニュー（左上のメニューバー。すべて日本語）─────────
// Electron 既定メニューは英語（File/Edit/View…）のため、標準ロールに日本語ラベルを
// 当てたメニューを組んで差し替える。ロールがネイティブの挙動（コピー/貼り付け/拡大…）を担う。
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    // macOS はアプリ名メニュー（一番左）を先頭に置くのが慣習。
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about', label: `${app.name} について` },
            { type: 'separator' },
            { role: 'hide', label: `${app.name} を隠す` },
            { role: 'hideOthers', label: 'ほかを隠す' },
            { role: 'unhide', label: 'すべて表示' },
            { type: 'separator' },
            { role: 'quit', label: `${app.name} を終了` },
          ],
        }]
      : []),
    {
      label: 'ファイル',
      submenu: [isMac ? { role: 'close', label: 'ウィンドウを閉じる' } : { role: 'quit', label: '終了' }],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'delete', label: '削除' },
        { role: 'selectAll', label: 'すべて選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { role: 'forceReload', label: '強制的に再読み込み' },
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全画面表示' },
      ],
    },
    {
      label: 'ウィンドウ',
      submenu: [
        { role: 'minimize', label: '最小化' },
        ...(isMac
          ? [{ role: 'zoom', label: 'ズーム' }, { type: 'separator' }, { role: 'front', label: 'すべてを手前に移動' }]
          : [{ role: 'close', label: '閉じる' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
      // 録画中はメイン窓を最小化する（撮影対象から退ける）。最小化＝非表示中でも
      // マーカー合成用の executeJavaScript が滞らないよう、レンダラーの
      // バックグラウンドスロットリングを止めておく。
      backgroundThrottling: false,
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
    width: 320,
    height: 336, // ドラッグ記録トグルの1行ぶん拡張（2-R2b）
    x: width - 340,
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
      gadgetWin.webContents.send('gadget:init', {
        mode: recording ? 'recording' : 'ready',
        startTime,
        name: recordName,
        markerOn: clickMarkerOn,
        dragOn: dragRecordOn,
      });
    }
  });
  gadgetWin.on('closed', () => {
    gadgetWin = null;
    // 録画中に閉じられたら停止（保存フォルダも開く）。ready で閉じられたら
    // 何も撮っていないので、最小化した本体を戻すだけ。
    if (recording) { stopRecording(); return; }
    restoreMainWindow();
    notifyState();
  });
}

// ── 録画制御 ────────────────────────────────────────────────
// 状態遷移: idle → openGadget（ready: ガジェット表示・フック停止・タイマー停止）
//          → startCapture（recording: フック開始・撮影有効）
//          → stopRecording（idle へ。録画していた場合のみ保存フォルダを開く）
// ready = ガジェットが開いているが recording === false。

// 【ready】ガジェットを開くだけ。撮影は「録画開始」ボタン（rec:begin）まで始めない。
function openGadget(rawName) {
  if (recording) return { ok: true };
  if (gadgetWin && !gadgetWin.isDestroyed()) {
    gadgetWin.focus(); // ready で既に開いていれば前面へ出すだけ
    return { ok: true };
  }
  sessionShots = 0;
  clickMarkerOn = true; // セッションごとに既定の ON へ戻す
  dragRecordOn = false; // ドラッグ記録はセッションごとに既定の OFF へ戻す（2-R2b）
  recordName = sanitizeName(rawName);
  try {
    fs.mkdirSync(screenshotDir(), { recursive: true });
  } catch (err) {
    console.error('保存フォルダの作成に失敗しました:', err);
  }
  createGadget();
  // 準備段階からアプリ本体を最小化して撮影対象から退ける。最小化中は
  // mainWin.isVisible()===false となり、isOnOwnWindow のメイン窓分岐が
  // 自然に無効化されるため、本体に重なる他アプリのクリックも撮影できる。
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.minimize(); } catch (_) { /* noop */ }
  }
  return { ok: true };
}

// 【recording】ガジェットの「録画開始」で呼ばれる。ここで初めてフックを起こす。
function startCapture() {
  if (recording) return { ok: true, startTime };
  if (!gadgetWin || gadgetWin.isDestroyed()) return { ok: false };
  recording = true;
  pendingDown = null;
  pendingCapture = null;
  lastShot = { x: 0, y: 0, t: 0 };
  pressedKeys.clear();
  typing = null;
  lastKeyStep = { combo: '', t: 0 };
  lastAppName = null;
  startTime = Date.now();
  // 録画1回 = 1セッションフォルダ（2-R1）。作成に失敗しても録画自体は始め、
  // 各撮影の保存失敗として既存の警告経路（enqueuePersist の catch）に乗せる。
  try {
    session.startSession(recordName, screenshotDir(), { now: startTime });
  } catch (err) {
    console.error('録画セッションフォルダの作成に失敗しました:', err);
    warnGadget('保存フォルダを作成できません。保存先を確認してください。');
  }
  // UIA 要素解決の子プロセスを起動（Windows のみ・失敗してもフォールバック文で録画継続）。
  uia.start();
  try {
    uIOhook.start();
  } catch (err) {
    console.error('グローバルマウスフックの開始に失敗しました:', err);
    // macOS の「アクセシビリティ」未許可などで失敗し得る。ユーザーに気づかせる。
    warnGadget('入力監視を開始できません。OSの許可（アクセシビリティ）を確認してください。');
  }
  startPrecapture(); // クリック「直前」フレームの定期取得を開始
  notifyState();
  return { ok: true, startTime };
}

function stopRecording() {
  const wasRecording = recording;
  recording = false;
  // 入力中のタイピングバーストがあれば確定する（2-R2b ②。事前キャプチャが
  // 生きているうちに保存キューへ積む。persistChain の完了待ちが後で回収する）。
  if (wasRecording) finalizeTyping({});
  stopPrecapture();
  pendingDown = null;
  pendingCapture = null;
  pressedKeys.clear();
  if (wasRecording) {
    try {
      uIOhook.stop();
    } catch (err) {
      console.error('グローバルマウスフックの停止に失敗しました:', err);
    }
  }
  if (gadgetWin && !gadgetWin.isDestroyed()) {
    const w = gadgetWin;
    gadgetWin = null; // closed ハンドラから再帰停止しないよう先に外す
    w.close();
  }
  // 開始時に最小化した本体を元に戻して前面へ。
  restoreMainWindow();
  notifyState();
  // 録画していた場合のみ、セッションを確定してレンダラーへ rec:done を通知し、
  // 取り込みウィザードを開かせる（2-R4。エクスプローラーは自動では開かない——
  // フォルダはウィザード内の導線から開ける）。0枚のセッションはフォルダごと
  // 削除されるため shots:0 で通知し、レンダラーはトースト表示のみ行う。
  // ready のまま閉じたときは何も撮っていないので通知しない。
  // ※ 停止直前のクリックがまだ保存キュー（persistChain）に残っていることがある
  //   （マーカー合成は最大4秒）。確定と UIA 子プロセスの終了はキューの完了を待つ。
  //   recording=false 以降は新規の enqueue が無いため、この時点のチェーンが最終形。
  if (wasRecording) {
    persistChain.then(() => {
      uia.stop();
      const ended = session.endSession();
      const payload = ended && !ended.removed
        ? { dir: ended.dir, shots: ended.shots }
        : { dir: null, shots: 0 };
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('rec:done', payload);
      } else if (payload.dir) {
        // 本体が閉じられている等でウィザードを出せないときは、素材が行方不明に
        // ならないよう従来どおりフォルダを開いておく。
        try {
          shell.openPath(payload.dir);
        } catch (err) {
          console.error('保存フォルダを開けませんでした:', err);
        }
      }
    });
  }
  return { ok: true };
}

function restoreMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    try {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    } catch (_) { /* noop */ }
  }
}

// ── ガイド小窓（3-R6・仕様は docs/spec-3-R6-guide-overlay.md）────────
// 実行モード（3-R5）の再生用オーバーレイ。録画ガジェットと同じ
// 「常時最前面・撮影に写らない」小窓で、表示専用（実行状態は本体レンダラー側）。
function createGuideWindow(payload) {
  if (guideWin && !guideWin.isDestroyed()) {
    guideWin.show();
    sendGuideStep(payload);
    return;
  }
  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;
  guideWin = new BrowserWindow({
    width: 320,
    height: 430,
    x: width - 344,
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
  // 画面キャプチャから除外（決定3）。Linux/X11 で効かない既知事項は
  // 録画ガジェットと同じ（再生用は撮影と無関係のため隠す代替はしない）。
  if (!IS_LINUX) guideWin.setContentProtection(true);
  guideWin.setAlwaysOnTop(true, 'screen-saver');
  guideWin.loadFile('guide.html');
  guideWin.webContents.on('did-finish-load', () => sendGuideStep(payload));
  guideWin.on('closed', () => {
    guideWin = null;
    // ✕・OS 操作で閉じられたら本体へ通知（プレイヤーは全画面表示へ戻る）
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('guide:closed');
  });
}
function sendGuideStep(payload) {
  if (guideWin && !guideWin.isDestroyed() && payload) {
    guideWin.webContents.send('guide:step', payload);
  }
}
ipcMain.handle('guide:open', (_e, payload) => {
  createGuideWindow(payload);
  return { ok: true };
});
ipcMain.handle('guide:update', (_e, payload) => {
  sendGuideStep(payload);
  return { ok: true };
});
ipcMain.handle('guide:close', (_e, opts) => {
  if (guideWin && !guideWin.isDestroyed()) {
    const w = guideWin;
    guideWin = null; // 意図した終了では closed ハンドラの guide:closed を送らない
    w.removeAllListeners('closed');
    w.close();
  }
  if (opts && opts.focusMain) restoreMainWindow(); // 完走時は本体を前面に（決定2）
  return { ok: true };
});
// 小窓 → 本体: 操作（complete / skip / prev）を中継する
ipcMain.on('guide:action', (_e, action) => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('guide:action', action);
});
// 折りたたみ／展開／画像の一時拡大に合わせた小窓のサイズ変更
ipcMain.on('guide:resize', (_e, size) => {
  if (!guideWin || guideWin.isDestroyed() || !size) return;
  const w = Math.max(220, Math.min(560, Math.round(size.width) || 320));
  const h = Math.max(48, Math.min(720, Math.round(size.height) || 430));
  try { guideWin.setSize(w, h); } catch (_) { /* noop */ }
});

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
  // ガジェットは常に最前面（alwaysOnTop）なので、座標が重なれば必ず自アプリ扱い。
  if (inBounds(gadgetWin)) return true;
  // ガイド小窓（3-R6）も同様に常に最前面。録画と同時利用したとき、小窓の
  // 「完了して次へ」等のクリックが録画に混入しないよう除外する（仕様の決定6）。
  if (inBounds(guideWin)) return true;
  // メイン窓は「実際に前面（フォーカス）にあるとき」だけ除外する。
  // Electron の isVisible() は他アプリの背後に隠れていても true を返すため、
  // 座標だけで判定すると、Excel 等を最大化して録画したときにメイン窓と座標が
  // 重なるクリックが誤って除外され「他アプリのクリックが撮れない」原因になる。
  // フォーカス条件を加えることで、背後に隠れているメイン窓は除外しない。
  if (mainWin && !mainWin.isDestroyed() && mainWin.isFocused() && inBounds(mainWin)) return true;
  return false;
}

// クリックした物理座標から、撮影対象のディスプレイ情報を求める。
// 返り値: { disp(Electron Display), shotId(screenshot-desktop の screen 指定/該当なしは null) }
// screenshot.listDisplays() は毎回プロセス起動を伴い遅いので TTL キャッシュする。
// ディスプレイ構成変更イベントで無効化（whenReady で配線）。
async function getShotDisplayList() {
  if (displayListCache && Date.now() - displayListCache.ts < DISPLAY_LIST_TTL_MS) {
    return displayListCache.list;
  }
  const list = await screenshot.listDisplays();
  displayListCache = { list, ts: Date.now() };
  return list;
}

async function resolveTargetDisplay(physX, physY) {
  const dip = toDip(physX, physY);
  const disp = screen.getDisplayNearestPoint(dip);
  let shotId = null;
  try {
    // ※ screenshot-desktop の列挙順/ID と Electron display.id は一致保証がない。
    //   ここでは getAllDisplays の並び順 index で対応付ける。実機で要検証（docs 参照）。
    const list = await getShotDisplayList();
    const all = screen.getAllDisplays();
    const idx = all.findIndex((d) => d.id === disp.id);
    if (idx >= 0 && list[idx]) shotId = list[idx].id;
  } catch (_) {
    /* 列挙失敗時はフル/プライマリ撮影へフォールバック */
  }
  return { disp, shotId };
}

// ── 事前キャプチャの制御 ─────────────────────────────────────
function startPrecapture() {
  if (PRECAPTURE_INTERVAL_MS <= 0) return; // 無効化スイッチ（従来方式のみ）
  stopPrecapture();
  preTimer = setInterval(pollPreFrame, PRECAPTURE_INTERVAL_MS);
}
function stopPrecapture() {
  if (preTimer) { clearInterval(preTimer); preTimer = null; }
  preFrame = null; // バッファ解放
}
async function pollPreFrame() {
  if (!recording || captureBusy) return; // クリック撮影中はスキップ（直列化）
  captureBusy = true;
  try {
    const shot = await captureShot(lastCursor.x, lastCursor.y);
    preFrame = { raw: shot.raw, disp: shot.disp, ts: Date.now() };
  } catch (_) {
    /* 失敗は無視。クリック時のオンデマンド撮影へ自然フォールバック */
  } finally {
    captureBusy = false;
  }
}
// 使える事前キャプチャがあれば参照する（消費しない）。古い・別ディスプレイの
// フレームは null。キーボード系ステップ（2-R2b）は消費せずこのフレームを共有する
//（直後の mousedown が同じフレームをクリック撮影に使えるように）。
function peekFreshPreFrame(physX, physY) {
  if (!preFrame) return null;
  if (Date.now() - preFrame.ts > PRECAPTURE_MAX_AGE_MS) return null;
  const disp = screen.getDisplayNearestPoint(toDip(physX, physY));
  if (disp.id !== preFrame.disp.id) return null;
  return preFrame;
}
// mousedown 時に使える事前キャプチャがあれば取り出す（消費したら破棄）。
function takeFreshPreFrame(physX, physY) {
  const f = peekFreshPreFrame(physX, physY);
  if (f) preFrame = null; // 同じフレームを連続クリックで使い回さない
  return f;
}

// 撮影画像（物理px）にハイライトを合成する（2-R3）。
//   marker.shape === 'rect'  : 要素を囲む角丸の枠（rect = [x,y,w,h] 画像座標・PAD込み）
//   marker.shape === 'circle': 従来どおりクリック位置の赤い中抜きリング
// 新規依存を避け、メイン窓 renderer の canvas を executeJavaScript 経由で利用。
// 失敗時は素の画像（pngBuffer）をそのまま返す。
async function drawMarker(pngBuffer, marker, scaleFactor) {
  if (!mainWin || mainWin.isDestroyed()) return pngBuffer;
  const lineWidth = marker.lineWidth;
  let shape;
  if (marker.shape === 'rect') {
    const [rx, ry, rw, rh] = marker.rect;
    const corner = 6 * scaleFactor; // 枠の角丸半径
    shape = `ctx.roundRect(${rx}, ${ry}, ${rw}, ${rh}, ${corner});`;
  } else {
    shape = `ctx.arc(${marker.x}, ${marker.y}, ${marker.radius}, 0, Math.PI * 2);`;
  }
  const b64 = pngBuffer.toString('base64');
  // 録画中はメイン窓が最小化（document が hidden）されている。hidden 状態では
  // img.decode() の Promise が解決されず executeJavaScript がハングし、保存・枚数
  // カウント・プレビュー更新が全て止まる（＝直列キューごと詰まる）。そのため
  // 可視状態に依存しない onload 待ち＋同期 drawImage で合成する。
  const script = `(async () => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image load failed'));
      img.src = 'data:image/png;base64,${b64}';
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.beginPath();
    ${shape}
    ctx.lineWidth = ${lineWidth};
    ctx.strokeStyle = ${JSON.stringify(MARKER_COLOR)};
    ctx.stroke();
    return c.toDataURL('image/png');
  })()`;
  try {
    // 万一レンダラーが応答しなくても保存処理（枚数カウント・プレビュー更新）を
    // 止めないよう、合成にはタイムアウトを設ける。時間切れ時は素の画像で続行する。
    const exec = mainWin.webContents.executeJavaScript(script, true);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('drawMarker timeout')), 4000)
    );
    const dataUrl = await Promise.race([exec, timeout]);
    const base64 = String(dataUrl).split(',')[1];
    if (base64) return Buffer.from(base64, 'base64');
  } catch (err) {
    console.error('マーカー合成に失敗しました（素の画像を保存します）:', err);
  }
  return pngBuffer;
}

// 【撮影】押下(mousedown)の瞬間に呼ぶ。クリック反応が起きる直前の画面を撮り、
// 生バッファ・対象ディスプレイ・押下座標を返す（保存はまだしない）。
// これにより「クリックすると消えるメニュー等」も消える前に写る。
async function captureShot(physX, physY) {
  const { disp, shotId } = await resolveTargetDisplay(physX, physY);

  // Linux で setContentProtection が効かない前提のため、撮影中はガジェットを隠す。
  const hideForShot = IS_LINUX && gadgetWin && !gadgetWin.isDestroyed() && gadgetWin.isVisible();
  try {
    if (hideForShot) gadgetWin.hide();
    const opts = { format: 'png' };
    if (shotId != null) opts.screen = shotId;
    const raw = await screenshot(opts);
    return { raw, disp, physX, physY };
  } finally {
    if (hideForShot && gadgetWin && !gadgetWin.isDestroyed()) gadgetWin.show();
  }
}

// uiohook のボタン番号 → サイドカー用の名前（想定外の番号はそのまま数値で記録）。
function buttonName(button) {
  if (button === BTN_LEFT) return 'left';
  if (button === BTN_RIGHT) return 'right';
  return button;
}

// 【保存】離上(mouseup)で保存確定と判定したら呼ぶ。撮影済みバッファにクリック位置の
// マーカーを合成し、セッションフォルダへ画像＋メタデータ JSON を併記で書き出して
// （session.js / 2-R1）、ガジェットを更新する。
async function persistShot(shot) {
  const { raw, disp, physX, physY, button, clicks, source, uiaPromise } = shot;
  // クリックの物理相対座標（撮影したモニタの左上原点）。
  const relX = physX - disp.bounds.x * disp.scaleFactor;
  const relY = physY - disp.bounds.y * disp.scaleFactor;

  // mousedown で並行キックした UIA 解決と合流し、手順文を生成する（2-R2）。
  // uia.resolve はタイムアウト込みで必ず解決するため、ここで詰まることはない。
  const uiaInfo = normalizeUia(uiaPromise ? await uiaPromise : null);
  const text = stepText(uiaInfo, { button: buttonName(button) });

  // ハイライト（要素枠 or 赤丸）と拡大画像の切り出し範囲を決める（2-R3）。
  let imageSize = null;
  try {
    const s = nativeImage.createFromBuffer(raw).getSize();
    if (s.width > 0 && s.height > 0) imageSize = { w: s.width, h: s.height };
  } catch (_) {
    /* サイズ不明なら拡大なし・赤丸フォールバックで続行 */
  }
  const plan = planShot({
    uia: uiaInfo,
    click: { x: relX, y: relY },
    imageSize,
    displayOrigin: { x: disp.bounds.x * disp.scaleFactor, y: disp.bounds.y * disp.scaleFactor },
    scale: disp.scaleFactor,
  });

  // 全景にハイライトを合成（トグル OFF なら素のまま）。
  let marker = { drawn: false };
  if (clickMarkerOn) {
    marker = plan.frame
      ? {
          drawn: true,
          shape: 'rect',
          rect: plan.frame,
          lineWidth: MARKER_LINE_WIDTH * disp.scaleFactor,
          color: MARKER_COLOR,
        }
      : {
          drawn: true,
          shape: 'circle',
          x: relX,
          y: relY,
          radius: MARKER_RADIUS * disp.scaleFactor,
          lineWidth: MARKER_LINE_WIDTH * disp.scaleFactor,
          color: MARKER_COLOR,
        };
  }
  const buf = marker.drawn ? await drawMarker(raw, marker, disp.scaleFactor) : raw;

  // 拡大画像 = ハイライト合成後の全景から切り出し（全景と見た目が必ず一致する）。
  // 生成失敗は撮影を止めない（サイドカーの zoom が null になるだけ）。
  let zoom = null;
  if (plan.zoom) {
    try {
      const [zx, zy, zw, zh] = plan.zoom.rect;
      const png = nativeImage
        .createFromBuffer(buf)
        .crop({ x: zx, y: zy, width: zw, height: zh })
        .toPNG();
      if (png && png.length > 0) zoom = { png, rect: plan.zoom.rect, source: plan.zoom.source };
    } catch (err) {
      console.error('拡大画像の生成に失敗しました（全景のみ保存します）:', err);
    }
  }

  const { fileName } = session.recordShot(buf, {
    button: buttonName(button),
    clicks,
    text,
    uia: uiaInfo,
    x: physX,
    y: physY,
    imagePoint: { x: relX, y: relY },
    display: { id: disp.id, boundsDip: disp.bounds, scaleFactor: disp.scaleFactor },
    marker,
    zoom,
    capture: { source },
    appChange: takeAppChange(uiaInfo),
  });
  notifyShotSaved(buf, fileName);
}

// 撮影枚数のカウントアップとガジェットのプレビュー更新（保存系の共通後処理）。
function notifyShotSaved(buf, fileName) {
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
}

// 直前保存ステップからの前面アプリ切り替えを検出する（2-R2b ⑤）。
// UIA が解決できたステップだけを比較対象にする（null は据え置き）。
// persistChain 内（直列）でのみ呼ぶこと。
function takeAppChange(uiaInfo) {
  const app = uiaInfo && uiaInfo.appName;
  if (!app) return null;
  const prev = lastAppName;
  lastAppName = app;
  return prev && prev !== app ? { from: prev, to: app } : null;
}

// 撮影済み Promise を直列キューに積む。セッション内の採番と書き込みが重ならないよう
// persistChain で1件ずつ順に保存する（撮影自体は押下時に並行で走ってよい）。
// extra には mouseup 時点でしか分からない情報（連続クリック数）を渡す。
function enqueuePersist(capPromise, extra) {
  persistChain = persistChain
    .then(async () => {
      const shot = await capPromise;
      if (shot) await persistShot({ ...shot, ...extra });
    })
    .catch((err) => {
      console.error('スクリーンショットの保存に失敗しました:', err);
      warnGadget('スクリーンショットを保存できません。画面収録の許可や保存先を確認してください。');
    });
}

// ── キーボード系ステップの保存（2-R2b ②③）──────────────────
// 撮影: 事前キャプチャ（peek・消費しない）優先、無ければその場で撮影。
// 失敗はステップごと諦める（録画は続行。console.error のみ）。
async function obtainKeyFrame(physX, physY) {
  const pre = peekFreshPreFrame(physX, physY);
  if (pre) return { raw: pre.raw, disp: pre.disp, source: 'precapture' };
  captureBusy = true;
  try {
    const shot = await captureShot(physX, physY);
    return { raw: shot.raw, disp: shot.disp, source: 'ondemand' };
  } catch (err) {
    console.error('キーボード操作の撮影に失敗しました:', err);
    return null;
  } finally {
    captureBusy = false;
  }
}

// 【保存】タイピングバーストの確定（②）。フォーカス要素の解決と合流し、確定時点の
// 画面を保存する。要素矩形が採用できればクリックと同じ枠ハイライト＋拡大を付ける。
async function persistInput(uiaPromise, enter) {
  const uiaInfo = normalizeUia(uiaPromise ? await uiaPromise : null);
  const text = inputText(uiaInfo, { enter });

  // 撮影対象: フォーカス要素矩形の中心（無ければカーソル位置のディスプレイ）。
  let px = lastCursor.x;
  let py = lastCursor.y;
  const hasRect = Array.isArray(uiaInfo.rect) && uiaInfo.rect.length === 4;
  if (hasRect) {
    px = Math.round(uiaInfo.rect[0] + uiaInfo.rect[2] / 2);
    py = Math.round(uiaInfo.rect[1] + uiaInfo.rect[3] / 2);
  }
  const frame = await obtainKeyFrame(px, py);
  if (!frame) return;
  const { raw, disp } = frame;
  const relX = px - disp.bounds.x * disp.scaleFactor;
  const relY = py - disp.bounds.y * disp.scaleFactor;

  let imageSize = null;
  try {
    const s = nativeImage.createFromBuffer(raw).getSize();
    if (s.width > 0 && s.height > 0) imageSize = { w: s.width, h: s.height };
  } catch (_) { /* サイズ不明なら枠・拡大なしで続行 */ }
  // 要素矩形が採用できたときだけ枠＋拡大を付ける。クリック中心フォールバックは
  // 使わない（キーボード操作に「クリック点」は無く、矩形中心の赤丸は誤解を招くため）。
  const plan = hasRect && imageSize
    ? planShot({
        uia: uiaInfo,
        click: { x: relX, y: relY },
        imageSize,
        displayOrigin: { x: disp.bounds.x * disp.scaleFactor, y: disp.bounds.y * disp.scaleFactor },
        scale: disp.scaleFactor,
      })
    : { frame: null, zoom: null };
  let marker = { drawn: false };
  let buf = raw;
  if (clickMarkerOn && plan.frame) {
    marker = {
      drawn: true,
      shape: 'rect',
      rect: plan.frame,
      lineWidth: MARKER_LINE_WIDTH * disp.scaleFactor,
      color: MARKER_COLOR,
    };
    buf = await drawMarker(raw, marker, disp.scaleFactor);
  }
  let zoom = null;
  if (plan.zoom && plan.zoom.source === 'element') {
    try {
      const [zx, zy, zw, zh] = plan.zoom.rect;
      const png = nativeImage.createFromBuffer(buf).crop({ x: zx, y: zy, width: zw, height: zh }).toPNG();
      if (png && png.length > 0) zoom = { png, rect: plan.zoom.rect, source: plan.zoom.source };
    } catch (err) {
      console.error('拡大画像の生成に失敗しました（全景のみ保存します）:', err);
    }
  }

  const { fileName } = session.recordShot(buf, {
    kind: 'input',
    keys: { type: 'input', enter: !!enter },
    text,
    uia: uiaInfo,
    imagePoint: plan.frame ? { x: relX, y: relY } : null,
    display: { id: disp.id, boundsDip: disp.bounds, scaleFactor: disp.scaleFactor },
    marker,
    zoom,
    capture: { source: frame.source },
    appChange: takeAppChange(uiaInfo),
  });
  notifyShotSaved(buf, fileName);
}

// 【保存】キー操作ステップ（③: Enter 単独・ショートカット）。押下時点の画面
//（＝効果が出る前）を保存する。マーカー・拡大なし。uia はアプリ切替検出と
// デバッグ用にフォーカス要素を記録するだけで、文はコンボから決まる。
async function persistKeyStep(combo, uiaPromise) {
  const uiaInfo = normalizeUia(uiaPromise ? await uiaPromise : null);
  const frame = await obtainKeyFrame(lastCursor.x, lastCursor.y);
  if (!frame) return;
  const { raw, disp } = frame;
  const { fileName } = session.recordShot(raw, {
    kind: 'key',
    keys: { type: 'shortcut', combo },
    text: keyStepText(combo),
    uia: uiaInfo,
    display: { id: disp.id, boundsDip: disp.bounds, scaleFactor: disp.scaleFactor },
    capture: { source: frame.source },
    appChange: takeAppChange(uiaInfo),
  });
  notifyShotSaved(raw, fileName);
}

// 【保存】ドラッグステップ（④）。始点画像は mousedown 時の撮影（クリックと同じ経路）、
// 終点画像は mouseup 時の撮影。両端に赤丸を焼き込み、文は両端の要素名から生成する。
async function persistDrag(shot, end) {
  const { raw, disp, physX, physY, source, uiaPromise } = shot;
  const startUia = normalizeUia(uiaPromise ? await uiaPromise : null);
  const endUia = normalizeUia(end.uiaPromise ? await end.uiaPromise : null);
  const endShot = await end.capPromise; // { raw, disp } | null（撮影失敗）
  const text = dragText(startUia, endUia);

  const circleMarker = (d, relX, relY) => ({
    drawn: true,
    shape: 'circle',
    x: relX,
    y: relY,
    radius: MARKER_RADIUS * d.scaleFactor,
    lineWidth: MARKER_LINE_WIDTH * d.scaleFactor,
    color: MARKER_COLOR,
  });

  // 始点（主画像）
  const sRelX = physX - disp.bounds.x * disp.scaleFactor;
  const sRelY = physY - disp.bounds.y * disp.scaleFactor;
  let marker = { drawn: false };
  let buf = raw;
  if (clickMarkerOn) {
    marker = circleMarker(disp, sRelX, sRelY);
    buf = await drawMarker(raw, marker, disp.scaleFactor);
  }

  // 終点（NNNe.png）。撮影失敗時は終点なし（始点と文だけでも保存する）。
  let endPng = null;
  let endMarker = { drawn: false };
  let endImagePoint = null;
  if (endShot) {
    const d2 = endShot.disp;
    const eRelX = end.x - d2.bounds.x * d2.scaleFactor;
    const eRelY = end.y - d2.bounds.y * d2.scaleFactor;
    endImagePoint = { x: eRelX, y: eRelY };
    endPng = endShot.raw;
    if (clickMarkerOn) {
      endMarker = circleMarker(d2, eRelX, eRelY);
      endPng = await drawMarker(endShot.raw, endMarker, d2.scaleFactor);
    }
  }

  const { fileName } = session.recordShot(buf, {
    kind: 'drag',
    button: 'left',
    text,
    uia: startUia,
    x: physX,
    y: physY,
    imagePoint: { x: sRelX, y: sRelY },
    display: { id: disp.id, boundsDip: disp.bounds, scaleFactor: disp.scaleFactor },
    marker,
    capture: { source },
    drag: {
      from: { x: physX, y: physY },
      to: { x: end.x, y: end.y },
      endPng,
      endImagePoint,
      endMarker,
      endUia: endUia,
    },
    appChange: takeAppChange(startUia),
  });
  notifyShotSaved(buf, fileName);
}

// タイピングバーストを確定し、入力ステップとして保存キューへ積む（②）。
// バーストが無ければ何もしない。enter = Enter キーでの確定か。
function finalizeTyping({ enter = false } = {}) {
  if (!typing) return;
  const t = typing;
  typing = null;
  persistChain = persistChain
    .then(() => persistInput(t.uiaPromise, enter))
    .catch((err) => {
      console.error('入力ステップの保存に失敗しました:', err);
    });
}

// キー操作ステップを保存キューへ積む（③）。同一コンボの連打は集約する。
function recordKeyStep(combo) {
  const now = Date.now();
  if (combo === lastKeyStep.combo && now - lastKeyStep.t <= DEBOUNCE_MS) return;
  lastKeyStep = { combo, t: now };
  const uiaPromise = uia.resolveFocused();
  persistChain = persistChain
    .then(() => persistKeyStep(combo, uiaPromise))
    .catch((err) => {
      console.error('キー操作ステップの保存に失敗しました:', err);
    });
}

// ── キーボード監視ハンドラ（2-R2b ②③）──────────────────────
function onKeyDown(e) {
  if (!recording) return;
  if (pressedKeys.has(e.keycode)) return; // キーリピート（押しっぱなし）は無視
  pressedKeys.add(e.keycode);
  const c = classifyKeydown(e);
  if (c.type === 'modifier' || c.type === 'other') return;
  // 自アプリ（ガジェット・本体）へのキー入力は記録しない（クリックの
  // isOnOwnWindow と同じ趣旨。フォーカスが自アプリにあるかで判定する）。
  if (BrowserWindow.getFocusedWindow()) return;
  if (c.type === 'typing') {
    // バースト開始時に一度だけフォーカス要素（＝入力先）を解決する。
    if (!typing) typing = { uiaPromise: uia.resolveFocused() };
    return;
  }
  if (c.type === 'edit') return; // バースト中の編集はそのまま継続（開始はしない）
  if (c.type === 'tab') { finalizeTyping({}); return; } // フォーカス移動＝入力の区切り
  if (c.type === 'enter') {
    if (typing) { finalizeTyping({ enter: true }); return; }
    recordKeyStep('Enter');
    return;
  }
  if (c.type === 'shortcut') {
    finalizeTyping({}); // 入力中なら先に入力ステップを確定（順序: 入力 → キー操作）
    recordKeyStep(c.combo);
  }
}

function onKeyUp(e) {
  pressedKeys.delete(e.keycode);
}

// 直近撮影からの時間＋近接でデバウンス（ダブルクリック/連打を1枚に集約）。
function shouldDebounce(physX, physY) {
  const dt = Date.now() - lastShot.t;
  if (dt > DEBOUNCE_MS) return false;
  const dist = Math.hypot(physX - lastShot.x, physY - lastShot.y);
  return dist <= DEBOUNCE_DIST;
}

// デバウンスで集約されたダブルクリック（e.clicks >= 2）なら、直前に保存した
// クリックステップを「ダブルクリック」へ昇格する（2-R2b ①）。昇格したら true。
// 保存キューに積むことで、直前ステップの書き込み完了後に修正されることを保証する。
function maybeAmendDblClick(e) {
  if (e.button !== BTN_LEFT || !(e.clicks >= 2)) return false;
  if (!shouldDebounce(e.x, e.y)) return false; // 直前の撮影と別操作なら触らない
  const clicks = e.clicks;
  persistChain = persistChain.then(() => {
    session.amendLastShot((sc) => {
      if (sc.kind !== 'click' || sc.click.button !== 'left') return sc; // 対象外は触らない
      sc.click.clicks = clicks;
      sc.text = dblClickText(sc.uia);
      return sc;
    });
  });
  return true;
}

// ── マウス監視ハンドラ ──────────────────────────────────────
// 押下位置を覚えておき、離した位置との移動量でドラッグ/クリックを判別する。
// 撮影は押下(mousedown)の瞬間に開始し、離上(mouseup)で保存可否を確定する。
function onMouseDown(e) {
  if (!recording) return;
  // 入力中のタイピングバーストはクリックで区切る（2-R2b ②。事前キャプチャは
  // peek（非消費）のため、この後のクリック撮影と同じフレームを共有できる）。
  finalizeTyping({});
  pendingDown = { button: e.button, x: e.x, y: e.y };
  pendingCapture = null; // 直前に未消費の撮影があれば破棄（連続 down 等）
  // 撮影対象になり得るクリックだけ、押下の瞬間に「寸前の画面」を確保する。
  if (!isShootableButton(e.button)) return; // 左/右以外は撮らない
  if (isOnOwnWindow(e.x, e.y)) { console.log('[rec] skip(down): own-window'); return; }
  if (shouldDebounce(e.x, e.y)) { console.log('[rec] skip(down): debounce'); return; }
  // 事前キャプチャがあればそれを使う（＝クリックより前の画面。クリックで
  // 消えるウインドウも写っている）。無ければ従来どおりこの場で撮影開始。
  // UIA 要素解決を撮影と並行して非同期キックする（2-R2）。クリックで消える
  // メニュー等も、押下の瞬間に依頼することで消える前に解決できる。
  // 決して reject せず、失敗・タイムアウト・非対応環境は null（フォールバック文）。
  const uiaPromise = uia.resolve(e.x, e.y);
  const pre = takeFreshPreFrame(e.x, e.y);
  if (pre) {
    pendingCapture = Promise.resolve({
      raw: pre.raw, disp: pre.disp, physX: e.x, physY: e.y,
      button: e.button, source: 'precapture', uiaPromise,
    });
    return;
  }
  captureBusy = true; // ポーリングと衝突させない
  pendingCapture = captureShot(e.x, e.y)
    .then((shot) => ({ ...shot, button: e.button, source: 'ondemand', uiaPromise }))
    .catch((err) => {
      console.error('スクリーンショットの撮影に失敗しました:', err);
      warnGadget('スクリーンショットを撮影できません。画面収録の許可や保存先を確認してください。');
      return null;
    })
    .finally(() => { captureBusy = false; });
}

function onMouseUp(e) {
  if (!recording) return;
  const down = pendingDown;
  const cap = pendingCapture;
  pendingDown = null;
  pendingCapture = null;
  if (!cap) {
    // 押下時に撮影対象外だった（＝撮っていない）。デバウンスで集約された
    // ダブルクリック（押下時点で skip 済み）はここに来るため、昇格だけ行う。
    maybeAmendDblClick(e);
    return;
  }
  // 撮影済みバッファを保存するか、破棄するかを判定する。破棄時は cap を捨てるだけ。
  if (!down || down.button !== e.button) { console.log('[rec] skip(up): button-mismatch'); return; }
  if (!isShootableButton(e.button)) { console.log('[rec] skip(up): not-shootable'); return; }
  // 押下→離上が動いた＝ドラッグ。記録トグル ON（2-R2b ④）かつ十分な移動量の
  // 左ボタンなら1ステップとして記録し、それ以外は従来どおり撮らない。
  const moved = Math.hypot(e.x - down.x, e.y - down.y);
  if (moved > DRAG_THRESHOLD) {
    if (dragRecordOn && e.button === BTN_LEFT && moved >= DRAG_MIN_DIST && !isOnOwnWindow(e.x, e.y)) {
      // 終点の要素解決と撮影は mouseup のこの瞬間に開始する（保存キューで合流）。
      const end = {
        x: e.x,
        y: e.y,
        uiaPromise: uia.resolve(e.x, e.y),
        capPromise: (async () => {
          captureBusy = true;
          try {
            return await captureShot(e.x, e.y);
          } catch (err) {
            console.error('ドラッグ終点の撮影に失敗しました:', err);
            return null;
          } finally {
            captureBusy = false;
          }
        })(),
      };
      persistChain = persistChain
        .then(async () => {
          const shot = await cap;
          if (shot) await persistDrag(shot, end);
        })
        .catch((err) => {
          console.error('ドラッグの保存に失敗しました:', err);
          warnGadget('スクリーンショットを保存できません。画面収録の許可や保存先を確認してください。');
        });
      return;
    }
    console.log('[rec] skip(up): drag');
    return;
  }
  if (isOnOwnWindow(e.x, e.y)) { console.log('[rec] skip(up): own-window'); return; }
  if (shouldDebounce(e.x, e.y)) {
    if (!maybeAmendDblClick(e)) console.log('[rec] skip(up): debounce');
    return;
  }

  lastShot = { x: e.x, y: e.y, t: Date.now() };
  // clicks（連続クリック数）は mouseup 時点の値。デバウンスにより2回目の撮影は
  // 集約され、ダブルクリックは上の昇格（amendLastShot）で認識する（2-R2b ①）。
  enqueuePersist(cap, { clicks: e.clicks });
}

// ── .docx 出力 ──────────────────────────────────────────────
// レンダラー(index.html)から受け取った静的HTMLを .docx に変換し、
// ネイティブ保存ダイアログで書き出す。html-to-docx はネイティブ依存なしの純JS。
async function saveDocx(event, payload) {
  const { title, html, meta } = payload || {};
  if (!html) return { error: 'HTML が空です。' };
  let HTMLtoDOCX;
  try {
    HTMLtoDOCX = require('html-to-docx');
  } catch (e) {
    return { error: 'html-to-docx が見つかりません。プロジェクトで npm install を実行してください。' };
  }
  const win = BrowserWindow.fromWebContents(event.sender) || mainWin;
  const safe =
    String(title || 'checklist')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 120) || 'checklist';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Word (.docx) として保存',
    defaultPath: safe + '.docx',
    filters: [{ name: 'Word 文書', extensions: ['docx'] }],
  });
  if (canceled || !filePath) return { saved: false, canceled: true };
  try {
    // ページ設定は Word の手順書テンプレートに合わせて明示する
    // （html-to-docx の既定は US レター・余白 上下1440/左右1800 twip）。
    // 単位は TWIP（1mm ≈ 56.69twip）: A4 = 210×297mm、余白は4方向とも 25mm。
    const MM = 56.6929; // twip / mm
    const buffer = await HTMLtoDOCX(html, null, {
      orientation: 'portrait',
      pageSize: { width: Math.round(210 * MM), height: Math.round(297 * MM) },
      margins: {
        top: Math.round(25 * MM),
        right: Math.round(25 * MM),
        bottom: Math.round(25 * MM),
        left: Math.round(25 * MM),
        header: 720,
        footer: 720,
        gutter: 0,
      },
      table: { row: { cantSplit: true } },
      // フッター（中身は後処理で「PAGE / NUMPAGES」に差し替え）と
      // 既定フォント（和文=游明朝・10.5pt・日本語）。docDefaults の eastAsia も後処理で游明朝に固定する。
      footer: true,
      pageNumber: true,
      font: '游明朝',
      fontSize: 21,
      complexScriptFontSize: 21,
      lang: 'ja-JP',
    });
    // 様式デザインへの後処理（見出しスタイル差し替え・表題/目次の注入・フッター等）。
    // 失敗したらファイルを書かずにエラーを返す（壊れた docx を残さない）。
    const { postProcessDocx } = require('./docx-postprocess');
    const processed = await postProcessDocx(buffer, meta || {});
    fs.writeFileSync(filePath, processed);
    return { saved: true, filePath };
  } catch (e) {
    return { error: e.message };
  }
}

// ── HTML 保存 ───────────────────────────────────────────────
// レンダラーから受け取った単体HTML文書をネイティブ保存ダイアログで書き出す。
// （レンダラーの window.prompt() は Electron 非サポートのため、ファイル名の
//   入力はネイティブダイアログに任せる。）
async function saveHtmlFile(event, payload) {
  const { title, html } = payload || {};
  if (!html) return { error: 'HTML が空です。' };
  const win = BrowserWindow.fromWebContents(event.sender) || mainWin;
  const safe =
    String(title || 'checklist')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 120) || 'checklist';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'HTML として保存',
    defaultPath: safe + '.html',
    filters: [{ name: 'HTML 文書', extensions: ['html'] }],
  });
  if (canceled || !filePath) return { saved: false, canceled: true };
  try {
    fs.writeFileSync(filePath, html, 'utf8');
    return { saved: true, filePath };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Excel(.xlsx) / CSV 保存（3-A） ─────────────────────────────
// レンダラー(index.html)が組んだ宣言的な出力仕様（行の配列＋画像）から
// xlsx-export.js がワークブックを構築する。CSV はレンダラーが完成文字列
//（BOM 込み）まで作るため、ここではダイアログ＋書き込みだけ行う。
// 仕様は docs/spec-3-A-xlsx-csv.md 参照。
async function saveXlsx(event, payload) {
  const { title, data } = payload || {};
  if (!data || !Array.isArray(data.rows)) return { error: '出力データが空です。' };
  let ExcelJS;
  try {
    ExcelJS = require('exceljs');
  } catch (e) {
    return { error: 'exceljs が見つかりません。プロジェクトで npm install を実行してください。' };
  }
  const win = BrowserWindow.fromWebContents(event.sender) || mainWin;
  const safe =
    String(title || 'checklist')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 120) || 'checklist';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Excel (.xlsx) として保存',
    defaultPath: safe + '.xlsx',
    filters: [{ name: 'Excel ブック', extensions: ['xlsx'] }],
  });
  if (canceled || !filePath) return { saved: false, canceled: true };
  try {
    const { buildXlsxWorkbook } = require('./xlsx-export');
    const wb = buildXlsxWorkbook(ExcelJS, data);
    const buf = await wb.xlsx.writeBuffer();
    // 失敗したらファイルを書かない（壊れた xlsx を残さない）
    fs.writeFileSync(filePath, Buffer.from(buf));
    return { saved: true, filePath };
  } catch (e) {
    return { error: e.message };
  }
}

async function saveCsv(event, payload) {
  const { title, text } = payload || {};
  if (!text) return { error: 'CSV が空です。' };
  const win = BrowserWindow.fromWebContents(event.sender) || mainWin;
  const safe =
    String(title || 'checklist')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 120) || 'checklist';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'CSV として保存',
    defaultPath: safe + '.csv',
    filters: [{ name: 'CSV ファイル', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { saved: false, canceled: true };
  try {
    fs.writeFileSync(filePath, text, 'utf8');
    return { saved: true, filePath };
  } catch (e) {
    return { error: e.message };
  }
}

// ── PDF 保存（印刷プレビューの「PDFに保存」） ─────────────────
// レンダラー側で #print-root に印刷ビューを流し込んだ状態で呼ばれる。
// printToPDF は @media print の CSS で描画されるため、画面と同じ見た目で
// 印刷ビューだけが出力される。
async function savePdfFile(event, payload) {
  const { title } = payload || {};
  const win = BrowserWindow.fromWebContents(event.sender) || mainWin;
  const safe =
    String(title || 'checklist')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 120) || 'checklist';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'PDF として保存',
    defaultPath: safe + '.pdf',
    filters: [{ name: 'PDF 文書', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { saved: false, canceled: true };
  try {
    // preferCSSPageSize で CSS の @page（本文=A4/余白16mm、表紙=A4/余白0）を尊重する。
    // これを付けないと printToPDF は既定余白を全ページに強制し、@page coverpage の
    // 余白0が効かず、A4 と等寸(794x1123px)の表紙が余白分だけはみ出してしまう。
    const buf = await event.sender.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
    fs.writeFileSync(filePath, buf);
    // 出力結果をすぐ確認できるよう、既定のPDFビューアで開く。
    shell.openPath(filePath);
    return { saved: true, filePath };
  } catch (e) {
    return { error: e.message };
  }
}

// ── アプリ起動 ──────────────────────────────────────────────
app.whenReady().then(() => {
  // ハンドラは一度だけ登録し、内部の recording フラグで制御する。
  uIOhook.on('mousedown', onMouseDown);
  uIOhook.on('mouseup', onMouseUp);
  // キーボード監視（2-R2b ②③）。フック自体は録画中しか動かない（uIOhook.start/stop）。
  uIOhook.on('keydown', onKeyDown);
  uIOhook.on('keyup', onKeyUp);
  // 事前キャプチャが「カーソルのあるディスプレイ」を撮れるよう追跡する
  //（フック自体は録画中しか動かないので待機中のコストは無い）。
  uIOhook.on('mousemove', (e) => { lastCursor.x = e.x; lastCursor.y = e.y; });
  // ディスプレイ構成が変わったら列挙キャッシュを捨てる。
  ['display-added', 'display-removed', 'display-metrics-changed'].forEach((ev) => {
    screen.on(ev, () => { displayListCache = null; });
  });

  ipcMain.handle('rec:start', (_e, name) => openGadget(name));
  ipcMain.handle('rec:begin', () => startCapture());
  ipcMain.handle('rec:stop', () => stopRecording());
  ipcMain.handle('rec:setMarker', (_e, on) => { clickMarkerOn = !!on; return { ok: true }; });
  ipcMain.handle('rec:setDrag', (_e, on) => { dragRecordOn = !!on; return { ok: true }; });
  ipcMain.handle('rec:openDir', (_e, dirArg) => {
    // ガジェットのプレビュークリックから、スクショ保存フォルダを OS の
    // ファイルマネージャ（エクスプローラー）で開く。録画中は今撮っている
    // セッションのフォルダを開く。取り込みウィザードからはセッションフォルダを
    // 引数で指定できる（検証を通ったものだけ）。
    try {
      const dir = resolveSessionDirArg(dirArg) || session.sessionDir() || screenshotDir();
      fs.mkdirSync(dir, { recursive: true });
      shell.openPath(dir);
      return { ok: true };
    } catch (err) {
      console.error('保存フォルダを開けませんでした:', err);
      return { ok: false };
    }
  });
  // ── 取り込みウィザード用（2-R4）。dir は必ず resolveSessionDirArg の検証を通す ──
  ipcMain.handle('rec:sessions', () => session.listSessions(screenshotDir()));
  ipcMain.handle('rec:session', (_e, dir) => {
    const d = resolveSessionDirArg(dir);
    return d ? session.readSession(d) : null;
  });
  ipcMain.handle('rec:image', (_e, dir, name) => {
    const d = resolveSessionDirArg(dir);
    if (!d || typeof name !== 'string' || !SESSION_IMAGE_RE.test(name)) return null;
    try {
      const buf = fs.readFileSync(path.join(d, name));
      return 'data:image/png;base64,' + buf.toString('base64');
    } catch (err) {
      console.error('セッション画像を読み込めませんでした:', err);
      return null;
    }
  });
  ipcMain.handle('rec:markImported', (_e, dir) => {
    const d = resolveSessionDirArg(dir);
    const ok = d ? session.markImported(d) : false;
    if (!ok) console.error('取り込み済みマーク(importedAt)を記録できませんでした:', String(dir));
    return { ok };
  });
  ipcMain.handle('docx:save', (e, payload) => saveDocx(e, payload));
  ipcMain.handle('file:saveHtml', (e, payload) => saveHtmlFile(e, payload));
  ipcMain.handle('xlsx:save', (e, payload) => saveXlsx(e, payload));
  ipcMain.handle('csv:save', (e, payload) => saveCsv(e, payload));
  ipcMain.handle('print:pdf', (e, payload) => savePdfFile(e, payload));
  // ファイル保存基盤（storage:* / image:*）。実装は storage.js（1-1）。
  initStorage(app, ipcMain);
  // エラーのローカルログ（log:write）。実装は errorlog.js（1-3）。
  initErrorLog(app, ipcMain);

  buildAppMenu();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 終了時はフックを確実に止め、録画中ならセッションを確定する
// （通常は stopRecording 経由で確定済み。ここは二重呼び出しでも無害）。
app.on('before-quit', () => {
  try {
    uIOhook.stop();
  } catch (_) {
    /* noop */
  }
  uia.stop();
  try {
    session.endSession();
  } catch (_) {
    /* noop */
  }
});
