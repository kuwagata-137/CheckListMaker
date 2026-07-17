// preload.js
// メインプロセスとレンダラー（index.html / gadget.html）の安全な橋渡し。
// contextIsolation:true / nodeIntegration:false の下で、限定した API だけを
// window.recorderAPI として公開する。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderAPI', {
  // この window が Electron 上で動いていることの目印（素のブラウザでは undefined）
  available: true,

  // ── メインアプリ（index.html）用 ──────────────────────────────
  // 録画ガジェットを開く（ready 状態。撮影はまだ始まらない）。
  // name は現在開いているチェックリスト名（ファイル名の接頭辞に使う）。
  startRecording: (name) => ipcRenderer.invoke('rec:start', name),
  // 録画停止（ready のときはガジェットを閉じるだけ）。
  stopRecording: () => ipcRenderer.invoke('rec:stop'),

  // ── ガジェット窓（gadget.html）用 ────────────────────────────
  // 「録画開始」ボタン。撮影を開始する。戻り値 { ok, startTime }。
  beginCapture: () => ipcRenderer.invoke('rec:begin'),
  // クリック位置の赤丸（〇マーカー）合成の ON/OFF。
  setMarker: (on) => ipcRenderer.invoke('rec:setMarker', !!on),
  // ドラッグ記録（始点終点2枚・2-R2b ④）の ON/OFF。既定 OFF。
  setDrag: (on) => ipcRenderer.invoke('rec:setDrag', !!on),
  // スクショ保存フォルダを OS のファイルマネージャで開く（プレビュークリック）。
  // dir（セッションフォルダ）を渡すとそのフォルダを開く（メイン側で検証される）。
  openShotsDir: (dir) => ipcRenderer.invoke('rec:openDir', dir),
  // 録画状態の変化通知（true=録画中 / false=停止）。ボタン表示の同期に使う。
  onState: (cb) => {
    ipcRenderer.removeAllListeners('rec:state');
    ipcRenderer.on('rec:state', (_e, data) => cb(data));
  },

  // ── 取り込みウィザード（index.html）用（2-R4）─────────────────
  // 録画停止でセッション確定後に届く通知 { dir, shots }（0枚は dir:null, shots:0）。
  onDone: (cb) => {
    ipcRenderer.removeAllListeners('rec:done');
    ipcRenderer.on('rec:done', (_e, data) => cb(data));
  },
  // ピクチャ配下のセッション一覧（新しい順）。
  listSessions: () => ipcRenderer.invoke('rec:sessions'),
  // セッション1件の読み込み { info, dir, steps } / 不正・失敗は null。
  loadSession: (dir) => ipcRenderer.invoke('rec:session', dir),
  // セッション内の画像1枚を dataURL で取得（失敗は null）。
  readImage: (dir, name) => ipcRenderer.invoke('rec:image', dir, name),
  // 取り込み完了を session.json に記録する。
  markImported: (dir) => ipcRenderer.invoke('rec:markImported', dir),

  // ── ガジェット窓（gadget.html）用 ────────────────────────────
  // 起動時の初期情報（開始時刻・録画名）。
  onGadgetInit: (cb) => {
    ipcRenderer.removeAllListeners('gadget:init');
    ipcRenderer.on('gadget:init', (_e, data) => cb(data));
  },
  // 撮影ごとの更新（枚数・最新プレビュー・ファイル名）。
  onGadgetUpdate: (cb) => {
    ipcRenderer.removeAllListeners('gadget:update');
    ipcRenderer.on('gadget:update', (_e, data) => cb(data));
  },
  // 失敗・権限拒否などの警告（ガジェットに赤字表示）。
  onGadgetWarn: (cb) => {
    ipcRenderer.removeAllListeners('gadget:warn');
    ipcRenderer.on('gadget:warn', (_e, data) => cb(data));
  },
});

// ガイド小窓（3-R6・仕様は docs/spec-3-R6-guide-overlay.md）。
// 実行モード（3-R5）を常時最前面の小窓で進めるための橋渡し。
// 実行状態は本体（index.html）側にあり、小窓（guide.html）は表示専用。
contextBridge.exposeInMainWorld('guideAPI', {
  available: true,
  // ── 本体（index.html）用 ──────────────────────────────────
  // 小窓を開く／表示中ステップを更新する。payload の形式は仕様書参照。
  open: (payload) => ipcRenderer.invoke('guide:open', payload),
  update: (payload) => ipcRenderer.invoke('guide:update', payload),
  // 小窓を閉じる。{ focusMain:true } で本体ウィンドウを前面に出す（完走時）。
  close: (opts) => ipcRenderer.invoke('guide:close', opts),
  // 小窓からの操作（'complete' | 'skip' | 'prev'）。
  onAction: (cb) => {
    ipcRenderer.removeAllListeners('guide:action');
    ipcRenderer.on('guide:action', (_e, action) => cb(action));
  },
  // 小窓が ✕ や OS 操作で閉じられた通知（プレイヤーは全画面表示に戻る）。
  onClosed: (cb) => {
    ipcRenderer.removeAllListeners('guide:closed');
    ipcRenderer.on('guide:closed', () => cb());
  },
  // ── 小窓（guide.html）用 ─────────────────────────────────
  onStep: (cb) => {
    ipcRenderer.removeAllListeners('guide:step');
    ipcRenderer.on('guide:step', (_e, data) => cb(data));
  },
  sendAction: (action) => ipcRenderer.send('guide:action', action),
  resize: (size) => ipcRenderer.send('guide:resize', size),
});

// ファイル保存基盤（Electron 版のみ・ロードマップ 1-1）。state 本体は
// <userData>/data/checklists.json、画像は images/ に1枚1ファイルで保存する。
// 素のブラウザでは window.storageAPI が undefined → 従来の localStorage 保存。
contextBridge.exposeInMainWorld('storageAPI', {
  available: true,
  // state 全体の読み込み。戻り値 { ok, json:string|null } / { ok:false, error }。
  load: () => ipcRenderer.invoke('storage:load'),
  // state 全体（JSON文字列）のアトミック書き込み。戻り値 { ok } / { ok:false, error }。
  save: (json) => ipcRenderer.invoke('storage:save', json),
  // 画像 dataURL を個別ファイルへ保存し参照 'img:<uuid>.<ext>' を返す。
  imageSave: (dataUrl) => ipcRenderer.invoke('image:save', dataUrl),
  // 参照から dataURL を復元する。戻り値 { ok, dataUrl } / { ok:false, error }。
  imageGet: (ref) => ipcRenderer.invoke('image:get', ref),
  // 参照先ファイルの削除（通常フローでは未使用。GC は起動時にメイン側で実施）。
  imageDelete: (ref) => ipcRenderer.invoke('image:delete', ref),
});

// エラーのローカルログ（Electron 版のみ・ロードマップ 1-3）。レンダラーで捕捉した
// エラーを <userData>/logs/error.log に JSONL で追記する。外部送信はしない。
contextBridge.exposeInMainWorld('appLogAPI', {
  // entry: { kind, message, stack?, extra? }。戻り値 { ok } / { ok:false, error }。
  error: (entry) => ipcRenderer.invoke('log:write', entry),
});

// .docx 出力（Electron 版のみ）。レンダラーから静的HTMLを受け取り、メインプロセスで
// .docx に変換・ネイティブ保存ダイアログで書き出す。素のブラウザでは window.docxAPI は undefined。
contextBridge.exposeInMainWorld('docxAPI', {
  available: true,
  // payload = { title, html, meta }。戻り値 = { saved:boolean, canceled?:boolean } / { error:string }。
  save: (payload) => ipcRenderer.invoke('docx:save', payload),
});

// Excel(.xlsx) / CSV 出力（Electron 版のみ・3-A）。レンダラーが組んだ出力仕様を
// メインプロセスに渡し、ワークブック構築（xlsx-export.js）とネイティブ保存
// ダイアログでの書き出しを行う。素のブラウザ・単体HTMLでは undefined のため
// ボタン自体が出ない（仕様: docs/spec-3-A-xlsx-csv.md）。
contextBridge.exposeInMainWorld('xlsxAPI', {
  available: true,
  // payload = { title, data }。戻り値 = { saved } / { canceled } / { error }。
  save: (payload) => ipcRenderer.invoke('xlsx:save', payload),
});
contextBridge.exposeInMainWorld('csvAPI', {
  available: true,
  // payload = { title, text（BOM込みCSV文字列） }。戻り値 = { saved } / { canceled } / { error }。
  save: (payload) => ipcRenderer.invoke('csv:save', payload),
});

// HTML 保存（Electron 版のみ）。window.prompt() が Electron で使えないため、
// ファイル名の入力ごとネイティブ保存ダイアログに任せる。
contextBridge.exposeInMainWorld('fileAPI', {
  available: true,
  // payload = { title, html }。戻り値 = { saved } / { canceled } / { error }。
  saveHtml: (payload) => ipcRenderer.invoke('file:saveHtml', payload),
  // 画像挿入ボタン用のネイティブ「開く」ダイアログ。既定フォルダは
  // ピクチャ\CheckListMaker（無ければ作成）。戻り値 = { dataUrl } / { canceled } / { error }。
  pickImage: () => ipcRenderer.invoke('image:pickFile'),
});

// PDF 保存（Electron 版のみ）。#print-root に印刷ビューを流し込んだ状態で呼ぶと、
// 現在のページを @media print の見た目で PDF 化して保存する。
contextBridge.exposeInMainWorld('printAPI', {
  available: true,
  // payload = { title }。戻り値 = { saved } / { canceled } / { error }。
  savePdf: (payload) => ipcRenderer.invoke('print:pdf', payload),
});
