// main.js — Electron メインプロセス
// 役割:
//  - メインウィンドウ（index.html）の生成
//  - 「録画」開始/停止の制御
//  - 録画中はグローバルなマウスクリックを監視し、左/右クリックの度に
//    「クリックしたモニタ」をキャプチャして、ユーザーの「ピクチャ」内の
//    「CheckListMaker」フォルダへ保存
//  - クリック位置に赤い中抜きリングのマーカーを合成
//  - スクリーンショットに写らないオーバーレイ「ガジェット」窓の表示
//  - 失敗（権限拒否・フック開始失敗・キャプチャ失敗）はガジェットへ警告通知
//  - 上記とレンダラー間の IPC 仲介
//
// 確定仕様の詳細は docs/録画機能-仕様.md「実装前に確定した詳細仕様」を参照。
'use strict';

const { app, BrowserWindow, ipcMain, screen, nativeImage, shell, dialog } = require('electron');
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
let sessionShots = 0; // この録画セッションでの撮影枚数（ガジェット表示用）
let recordName = ''; // ファイル名の接頭辞（チェックリスト名をサニタイズしたもの）
let startTime = 0; // 録画開始時刻(ms)

// マウス押下情報（ドラッグ判定用）と直近撮影（デバウンス用）。
let pendingDown = null; // { button, x, y }
// 「クリック反応の直前」を捉えるため、押下(mousedown)の瞬間に撮影を開始し、
// 離上(mouseup)で保存可否を確定する。pendingCapture はその撮影 Promise。
let pendingCapture = null; // Promise<{raw,disp,physX,physY}|null> | null
// 保存処理を直列化するためのチェーン（nextSequence 採番と書き込みの競合を防ぐ）。
let persistChain = Promise.resolve();
let lastShot = { x: 0, y: 0, t: 0 };

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
  pendingCapture = null;
  lastShot = { x: 0, y: 0, t: 0 };
  startTime = Date.now();
  recordName = sanitizeName(rawName);
  try {
    fs.mkdirSync(screenshotDir(), { recursive: true });
  } catch (err) {
    console.error('保存フォルダの作成に失敗しました:', err);
  }
  createGadget();
  // 録画中はアプリ本体を最小化して撮影対象から退ける。最小化中は
  // mainWin.isVisible()===false となり、isOnOwnWindow のメイン窓分岐が
  // 自然に無効化されるため、本体に重なる他アプリのクリックも撮影できる。
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.minimize(); } catch (_) { /* noop */ }
  }
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
  pendingCapture = null;
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
  // 録画開始時に最小化した本体を元に戻して前面へ。
  if (mainWin && !mainWin.isDestroyed()) {
    try {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    } catch (_) { /* noop */ }
  }
  notifyState();
  // 録画終了後は保存先フォルダをエクスプローラー（OS のファイルマネージャ）で開き、
  // 撮ったスクリーンショットをすぐ確認できるようにする。
  try {
    const dir = screenshotDir();
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  } catch (err) {
    console.error('保存フォルダを開けませんでした:', err);
  }
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
  // ガジェットは常に最前面（alwaysOnTop）なので、座標が重なれば必ず自アプリ扱い。
  if (inBounds(gadgetWin)) return true;
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

// 【保存】離上(mouseup)で保存確定と判定したら呼ぶ。撮影済みバッファにクリック位置の
// マーカーを合成してファイルへ書き出し、ガジェットを更新する。
async function persistShot(shot) {
  const { raw, disp, physX, physY } = shot;
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
}

// 撮影済み Promise を直列キューに積む。採番(nextSequence)と書き込みが重ならないよう
// persistChain で1件ずつ順に保存する（撮影自体は押下時に並行で走ってよい）。
function enqueuePersist(capPromise) {
  persistChain = persistChain
    .then(async () => {
      const shot = await capPromise;
      if (shot) await persistShot(shot);
    })
    .catch((err) => {
      console.error('スクリーンショットの保存に失敗しました:', err);
      warnGadget('スクリーンショットを保存できません。画面収録の許可や保存先を確認してください。');
    });
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
// 撮影は押下(mousedown)の瞬間に開始し、離上(mouseup)で保存可否を確定する。
function onMouseDown(e) {
  if (!recording) return;
  pendingDown = { button: e.button, x: e.x, y: e.y };
  pendingCapture = null; // 直前に未消費の撮影があれば破棄（連続 down 等）
  // 撮影対象になり得るクリックだけ、押下の瞬間に「寸前の画面」を撮っておく。
  if (!isShootableButton(e.button)) return; // 左/右以外は撮らない
  if (isOnOwnWindow(e.x, e.y)) { console.log('[rec] skip(down): own-window'); return; }
  if (shouldDebounce(e.x, e.y)) { console.log('[rec] skip(down): debounce'); return; }
  pendingCapture = captureShot(e.x, e.y).catch((err) => {
    console.error('スクリーンショットの撮影に失敗しました:', err);
    warnGadget('スクリーンショットを撮影できません。画面収録の許可や保存先を確認してください。');
    return null;
  });
}

function onMouseUp(e) {
  if (!recording) return;
  const down = pendingDown;
  const cap = pendingCapture;
  pendingDown = null;
  pendingCapture = null;
  if (!cap) return; // 押下時に撮影対象外だった（＝撮っていない）ので何もしない
  // 撮影済みバッファを保存するか、破棄するかを判定する。破棄時は cap を捨てるだけ。
  if (!down || down.button !== e.button) { console.log('[rec] skip(up): button-mismatch'); return; }
  if (!isShootableButton(e.button)) { console.log('[rec] skip(up): not-shootable'); return; }
  // 押下→離上が大きく動いた＝ドラッグは撮らない。
  if (Math.hypot(e.x - down.x, e.y - down.y) > DRAG_THRESHOLD) { console.log('[rec] skip(up): drag'); return; }
  if (isOnOwnWindow(e.x, e.y)) { console.log('[rec] skip(up): own-window'); return; }
  if (shouldDebounce(e.x, e.y)) { console.log('[rec] skip(up): debounce'); return; }

  lastShot = { x: e.x, y: e.y, t: Date.now() };
  enqueuePersist(cap);
}

// ── .docx 出力 ──────────────────────────────────────────────
// レンダラー(index.html)から受け取った静的HTMLを .docx に変換し、
// ネイティブ保存ダイアログで書き出す。html-to-docx はネイティブ依存なしの純JS。
async function saveDocx(event, payload) {
  const { title, html } = payload || {};
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
    const buffer = await HTMLtoDOCX(html, null, {
      table: { row: { cantSplit: true } },
    });
    fs.writeFileSync(filePath, buffer);
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

  ipcMain.handle('rec:start', (_e, name) => startRecording(name));
  ipcMain.handle('rec:stop', () => stopRecording());
  ipcMain.handle('docx:save', (e, payload) => saveDocx(e, payload));

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
