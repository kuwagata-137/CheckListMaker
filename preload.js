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
  // スクショ保存フォルダを OS のファイルマネージャで開く（プレビュークリック）。
  openShotsDir: () => ipcRenderer.invoke('rec:openDir'),
  // 録画状態の変化通知（true=録画中 / false=停止）。ボタン表示の同期に使う。
  onState: (cb) => {
    ipcRenderer.removeAllListeners('rec:state');
    ipcRenderer.on('rec:state', (_e, data) => cb(data));
  },

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

// HTML 保存（Electron 版のみ）。window.prompt() が Electron で使えないため、
// ファイル名の入力ごとネイティブ保存ダイアログに任せる。
contextBridge.exposeInMainWorld('fileAPI', {
  available: true,
  // payload = { title, html }。戻り値 = { saved } / { canceled } / { error }。
  saveHtml: (payload) => ipcRenderer.invoke('file:saveHtml', payload),
});

// PDF 保存（Electron 版のみ）。#print-root に印刷ビューを流し込んだ状態で呼ぶと、
// 現在のページを @media print の見た目で PDF 化して保存する。
contextBridge.exposeInMainWorld('printAPI', {
  available: true,
  // payload = { title }。戻り値 = { saved } / { canceled } / { error }。
  savePdf: (payload) => ipcRenderer.invoke('print:pdf', payload),
});
