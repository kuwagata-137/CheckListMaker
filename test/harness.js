'use strict';
// テストハーネス — index.html を jsdom で丸ごと起動し、テスト専用フック
// window.__test__ 経由で内部 API に触れるようにする。
// 方針は docs/spec-1-2-test-ci.md を参照。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 1x1 の圧縮済み JPEG / PNG dataURL（画像系テストの素材）
const PX_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const PX_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 条件が真になるまでポーリングする（固定 sleep によるフレーク防止）
async function waitFor(cond, { timeout = 5000, interval = 20, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`waitFor タイムアウト: ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// storage.js（メインプロセス側）を Electron 無しで初期化する。
// 一時フォルダを userData に見立て、IPC ハンドラを直接呼べる形で返す。
function createMainStorage() {
  const { initStorage } = require(path.join(ROOT, 'storage.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clm-test-'));
  const handlers = {};
  initStorage({ getPath: () => tmp }, { handle: (ch, fn) => { handlers[ch] = fn; } });
  return {
    dir: tmp,
    dataDir: path.join(tmp, 'data'),
    imageDir: path.join(tmp, 'data', 'images'),
    ipc: (ch, ...args) => handlers[ch](null, ...args),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

// index.html を起動する。
//   storage      … createMainStorage() の戻り値。渡すと Electron モード
//                  （window.storageAPI あり）として起動する。省略時はブラウザモード。
//   localStorage … 起動前に localStorage へ入れる { key: value }
// 戻り値の api() は window.__test__（起動完了後に埋まる）を待って返す。
function bootApp({ storage = null, localStorage = null, url = 'https://localhost/app/index.html', html = HTML } = {}) {
  const vc = new VirtualConsole();
  vc.on('error', () => {});
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    virtualConsole: vc,
    beforeParse(window) {
      window.__test__ = {};
      window.alert = () => {};
      window.confirm = () => true;
      if (!window.CSS) window.CSS = { escape: (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1') };
      if (localStorage) {
        for (const [k, v] of Object.entries(localStorage)) window.localStorage.setItem(k, v);
      }
      if (storage) {
        window.storageAPI = {
          available: true,
          load: () => storage.ipc('storage:load'),
          save: (json) => storage.ipc('storage:save', json),
          imageSave: (dataUrl) => storage.ipc('image:save', dataUrl),
          imageGet: (ref) => storage.ipc('image:get', ref),
          imageDelete: (ref) => storage.ipc('image:delete', ref),
        };
      }
    },
  });
  const win = dom.window;
  return {
    dom,
    window: win,
    document: win.document,
    // 起動（async boot）完了を待ってテスト用 API を返す
    api: () => waitFor(() => win.__test__ && win.__test__.store && win.__test__, { label: 'アプリ起動' }),
    close: () => win.close(),
  };
}

module.exports = { ROOT, PX_JPEG, PX_PNG, waitFor, createMainStorage, bootApp };
