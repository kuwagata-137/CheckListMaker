// storage.js — メインプロセス側のファイル保存基盤（ロードマップ 1-1）
// 役割:
//  - state 全体の読み書き: <userData>/data/checklists.json（アトミック書き込み＋.bak）
//  - 画像の個別ファイル保存: <userData>/data/images/<uuid>.jpg|png
//  - 起動時ロードでの孤児画像 GC（state から参照されないファイルの削除）
//
// 参照形式・ライフサイクル・IPC 仕様は docs/spec-file-storage-migration.md 参照。
// レンダラー側の対になる実装は index.html の FileAdapter / 画像参照レイヤ。
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const IMG_REF_PREFIX = 'img:';
// 画像ファイル名は UUID + 拡張子のみ許可（パストラバーサル防止）
const IMG_FILE_RE = /^[0-9a-fA-F-]{36}\.(jpg|png)$/;
// state JSON 文字列から画像参照を集める（GC 用）
const IMG_REF_SCAN_RE = /img:([0-9a-fA-F-]{36}\.(?:jpg|png))/g;

function initStorage(app, ipcMain) {
  const dataDir = () => path.join(app.getPath('userData'), 'data');
  const imagesDir = () => path.join(dataDir(), 'images');
  const stateFile = () => path.join(dataDir(), 'checklists.json');

  async function ensureDirs() {
    await fsp.mkdir(imagesDir(), { recursive: true });
  }

  // 参照文字列 'img:<uuid>.<ext>' → 検証済みファイル名（不正なら null）
  function refToFileName(ref) {
    if (typeof ref !== 'string' || !ref.startsWith(IMG_REF_PREFIX)) return null;
    const name = ref.slice(IMG_REF_PREFIX.length);
    return IMG_FILE_RE.test(name) ? name : null;
  }

  // ── state の読み込み（.bak フォールバック付き）─────────────
  async function readStateJson() {
    for (const file of [stateFile(), stateFile() + '.bak']) {
      try {
        const text = await fsp.readFile(file, 'utf8');
        JSON.parse(text); // 壊れた JSON なら例外 → 次の候補へ
        return text;
      } catch (_) {
        /* 無い/壊れている → 次へ */
      }
    }
    return null;
  }

  // ── 孤児画像の GC ───────────────────────────────────────────
  // 起動時ロードの成功時のみ実施。保存済み state から参照されない画像ファイルを
  // 削除する（Undo 履歴はセッション内のみなので、この時点の state が唯一の真実）。
  async function gcImages(stateJson) {
    try {
      const referenced = new Set();
      for (const m of stateJson.matchAll(IMG_REF_SCAN_RE)) referenced.add(m[1]);
      const files = await fsp.readdir(imagesDir());
      for (const f of files) {
        if (IMG_FILE_RE.test(f) && !referenced.has(f)) {
          await fsp.unlink(path.join(imagesDir(), f)).catch(() => {});
        }
      }
    } catch (err) {
      // GC 失敗は致命ではない（次回起動で再試行される）
      console.warn('画像GCに失敗しました:', err);
    }
  }

  // ── state の書き込み（アトミック＋直前世代の退避）────────────
  // tmp に書く → 現行を .bak へ rename → tmp を本番へ rename。
  // どこで落ちても「旧版か新版のどちらか」が必ず読める状態を保つ。
  let saveChain = Promise.resolve();
  async function writeState(json) {
    await ensureDirs();
    const file = stateFile();
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, json, 'utf8');
    try {
      await fsp.rename(file, file + '.bak');
    } catch (_) {
      /* 初回は本番ファイルが無い */
    }
    await fsp.rename(tmp, file);
  }

  // ── IPC ハンドラ ────────────────────────────────────────────
  ipcMain.handle('storage:load', async () => {
    try {
      await ensureDirs();
      const json = await readStateJson();
      if (json != null) await gcImages(json);
      return { ok: true, json };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('storage:save', (_e, json) => {
    if (typeof json !== 'string' || !json) {
      return { ok: false, error: '保存データが不正です。' };
    }
    // 書き込みは直列化する（rename の順序が交錯すると .bak が壊れるため）
    const task = saveChain.then(() => writeState(json));
    saveChain = task.catch(() => {});
    return task
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: String(err.message || err) }));
  });

  ipcMain.handle('image:save', async (_e, dataUrl) => {
    try {
      const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ''));
      if (!m) return { ok: false, error: '対応していない画像形式です。' };
      await ensureDirs();
      const ext = m[1] === 'png' ? 'png' : 'jpg';
      const name = crypto.randomUUID() + '.' + ext;
      await fsp.writeFile(path.join(imagesDir(), name), Buffer.from(m[2], 'base64'));
      return { ok: true, ref: IMG_REF_PREFIX + name };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('image:get', async (_e, ref) => {
    try {
      const name = refToFileName(ref);
      if (!name) return { ok: false, error: '画像参照が不正です。' };
      const buf = await fsp.readFile(path.join(imagesDir(), name));
      const mime = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('image:delete', async (_e, ref) => {
    try {
      const name = refToFileName(ref);
      if (!name) return { ok: false, error: '画像参照が不正です。' };
      await fsp.unlink(path.join(imagesDir(), name));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
}

module.exports = { initStorage };
