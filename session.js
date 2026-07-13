// session.js — 録画セッション形式（ロードマップ 2-R1）
// 役割:
//  - 録画1回 = 1セッションフォルダ（<親>/<リスト名>_<yyyymmdd>_<hhmmss>/）の作成
//  - 撮影画像の連番保存（001.png〜）と1クリック分のメタデータ併記（001.json）
//  - セッション全体のメタデータ（session.json）の管理と終了処理
//
// フォルダ構成・サイドカーのスキーマは docs/spec-2-R1-session-format.md（v1）、
// docs/spec-2-R2-uia-steptext.md（v2: uia の実データ＋生成文 text を追加）、
// docs/spec-2-R3-zoom-highlight.md（v3: 拡大画像 zoom＋marker.shape を追加）参照。
'use strict';

const path = require('path');
const fs = require('fs');

const SESSION_VERSION = 1;
const SIDECAR_VERSION = 3;

// UIA 解決なし（非 Windows・タイムアウト・失敗）のときのサイドカー uia 欄。
const UIA_EMPTY = Object.freeze({
  resolved: false, name: null, controlType: null, rect: null, windowTitle: null, appName: null,
});

let current = null; // { dir, name, startedAt(Date), seq } — 録画は同時に1つ

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}
// フォルダ名用の日時スタンプ（ローカル時刻）: yyyymmdd_hhmmss
function stampFor(d) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function infoPath(dir) {
  return path.join(dir, 'session.json');
}

// session.json を書く。撮影のたびに shots を更新し、停止時に endedAt を確定する。
// endedAt が null のまま残っていれば異常終了の痕跡（R4 が未完了セッションを検出できる）。
function writeInfo(s, endedAt = null) {
  const info = {
    version: SESSION_VERSION,
    type: 'checklistmaker-recording',
    name: s.name,
    startedAt: s.startedAt.toISOString(),
    endedAt: endedAt ? endedAt.toISOString() : null,
    shots: s.seq,
  };
  fs.writeFileSync(infoPath(s.dir), JSON.stringify(info, null, 2));
}

// セッションを開始し、フォルダと session.json を作る。失敗は throw（呼び出し元が警告）。
// 同名フォルダが既にあれば _2, _3… を付けて衝突を回避する。
function startSession(name, parentDir, opts = {}) {
  const now = opts.now != null ? new Date(opts.now) : new Date();
  const stamp = stampFor(now);
  let dir = path.join(parentDir, `${name}_${stamp}`);
  for (let n = 2; fs.existsSync(dir); n++) {
    dir = path.join(parentDir, `${name}_${stamp}_${n}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  current = { dir, name, startedAt: now, seq: 0 };
  try {
    writeInfo(current);
  } catch (err) {
    console.error('session.json の書き込みに失敗しました:', err);
  }
  return { dir };
}

function isActive() {
  return current !== null;
}

// 録画中のセッションフォルダ（未開始なら null）。「フォルダを開く」導線用。
function sessionDir() {
  return current ? current.dir : null;
}

// 撮影1枚を保存する。PNG の書き込み失敗は throw（従来の保存失敗警告の経路に乗せる）。
// サイドカーと session.json の失敗は撮影を止めない（画像が主成果物のため）。
function recordShot(pngBuffer, meta = {}) {
  if (!current) throw new Error('録画セッションが開始されていません');
  current.seq += 1;
  const base = pad(current.seq, 3);
  const fileName = `${base}.png`;
  fs.writeFileSync(path.join(current.dir, fileName), pngBuffer);

  // 拡大画像（2-R3）。書き込み失敗は撮影を止めない（全景 PNG が主成果物）。
  let zoom = null;
  if (meta.zoom && meta.zoom.png) {
    const zoomName = `${base}z.png`;
    try {
      fs.writeFileSync(path.join(current.dir, zoomName), meta.zoom.png);
      zoom = {
        image: zoomName,
        rect: meta.zoom.rect != null ? meta.zoom.rect : null,
        source: meta.zoom.source != null ? meta.zoom.source : null,
      };
    } catch (err) {
      console.error('拡大画像の書き込みに失敗しました:', err);
    }
  }

  const now = meta.now != null ? new Date(meta.now) : new Date();
  const sidecar = {
    version: SIDECAR_VERSION,
    seq: current.seq,
    image: fileName,
    time: now.toISOString(),
    elapsedMs: Math.max(0, now.getTime() - current.startedAt.getTime()),
    // テンプレート文法で生成した手順文（steptext.js / 2-R2）。R4 が項目文の初期値に使う。
    text: meta.text != null ? meta.text : null,
    click: {
      button: meta.button != null ? meta.button : null,
      clicks: meta.clicks != null ? meta.clicks : null,
      x: meta.x != null ? meta.x : null,
      y: meta.y != null ? meta.y : null,
    },
    imagePoint: meta.imagePoint || null,
    display: meta.display || null,
    marker: meta.marker || { drawn: false },
    // 拡大画像の記録（zoomcrop.js / 2-R3）。生成なし・書き込み失敗は null。
    zoom,
    capture: meta.capture || null,
    // UIA 要素解決の結果（steptext.normalizeUia 済み / 2-R2）。解決なしは雛形。
    uia: meta.uia || UIA_EMPTY,
  };
  try {
    fs.writeFileSync(path.join(current.dir, `${base}.json`), JSON.stringify(sidecar, null, 2));
  } catch (err) {
    console.error('撮影メタデータ(JSON)の書き込みに失敗しました:', err);
  }
  try {
    writeInfo(current);
  } catch (err) {
    console.error('session.json の更新に失敗しました:', err);
  }
  return { fileName, seq: current.seq };
}

// セッションを終了する。1枚も撮っていなければ空フォルダごと削除する（ゴミを残さない）。
// 返り値: { dir, shots, removed } ／ セッション未開始なら null。
function endSession(opts = {}) {
  if (!current) return null;
  const s = current;
  current = null;
  if (s.seq === 0) {
    try {
      fs.rmSync(infoPath(s.dir), { force: true });
      fs.rmdirSync(s.dir); // 空でなければ throw → 下の catch で残す
      return { dir: s.dir, shots: 0, removed: true };
    } catch (err) {
      console.error('空のセッションフォルダを削除できませんでした:', err);
    }
  }
  const now = opts.now != null ? new Date(opts.now) : new Date();
  try {
    writeInfo(s, now);
  } catch (err) {
    console.error('session.json の確定に失敗しました:', err);
  }
  return { dir: s.dir, shots: s.seq, removed: false };
}

module.exports = { startSession, recordShot, endSession, isActive, sessionDir };
