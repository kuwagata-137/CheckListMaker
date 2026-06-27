// preload.js
// メインプロセスとレンダラー（index.html / gadget.html）の安全な橋渡し。
// contextIsolation:true / nodeIntegration:false の下で、限定した API だけを
// window.recorderAPI として公開する。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderAPI', {
  // この window が Electron 上で動いていることの目印（素のブラウザでは undefined）
  available: true,

  // ── メインアプリ（index.html）用 ──────────────────────────────
  // 録画開始。name は現在開いているチェックリスト名（ファイル名の接頭辞に使う）。
  startRecording: (name) => ipcRenderer.invoke('rec:start', name),
  // 録画停止。
  stopRecording: () => ipcRenderer.invoke('rec:stop'),
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
});
