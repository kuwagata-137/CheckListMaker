# 1-2 自動テストと CI — 確定仕様

ロードマップ 1-2 の実装にあたっての決定事項。2026-07-13 確定。

## 方針（ロードマップからの確定分）

- テストランナーは **Node 標準の `node:test`**。追加依存は **jsdom のみ**（devDependencies）。
- 単一 HTML は維持する。アプリ側への変更は**テスト専用フック1箇所のみ**:
  IIFE 末尾で `window.__test__` が定義済みのときだけ内部 API を書き込む。
  本番・ブラウザでは `__test__` が未定義のため一切動作しない。
- CI は GitHub Actions（`.github/workflows/test.yml`）。push / PR で実行。

## 実装上の決定事項

1. **ハーネスは jsdom に index.html を直接パースさせる**（`runScripts: 'dangerously'`）。
   ロードマップ原案の「`<script>` 抽出して評価」は、実 DOM（`#app` 等）が無いと
   起動できないため不採用。HTML ごと読ませる方が本物の起動経路をそのまま通る
   （1-1 の検証作業で実証済みの方式）。
2. **待機は固定 sleep でなく条件ポーリング**（`waitFor`）。起動が async
   （`await createAppStore()`）のため、`__test__.store` が現れるまで待つ。
   CI の速度差によるフレークを避ける。
3. **storage.js（メインプロセス側）は jsdom 不要の単体テスト**とする。
   `app` / `ipcMain` をスタブして IPC ハンドラを直接呼ぶ（Electron 起動不要）。
4. **テストの対象範囲**（ロードマップの優先順位に対応）:
   - `test/storage.test.js` … 保存基盤（アトミック書き込み・.bak 復旧・画像 GC・
     参照検証・並行保存の直列化）
   - `test/migration.test.js` … 1-1 マイグレーション（最重要）: 初回移行・参照化・
     マーカー・再移行しないこと・2回目起動の復元とサムネイル解決・
     ブラウザモードの素通し互換
   - `test/model.test.js` … model 純関数（進捗計算・項目/セクションの追加移動削除・
     画像並行配列の正規化・一括リセット 等）
   - `test/io.test.js` … 共有リンクの encode/decode 往復・画像除外・壊れた payload、
     単体 HTML 書き出しの自己完結性
5. **CI は `npm install` を使う**（`npm ci` ではない）。lockfile は環境差分を生む
   native 依存（uiohook-napi 等）があるため当面コミットしない。
   Electron バイナリは `ELECTRON_SKIP_BINARY_DOWNLOAD=1` でダウンロードを省略する
   （テストは Electron 本体を使わないため）。
6. Node は **20 系**（Actions の LTS）で実行。`npm test` = `node --test test/`。

## 使い方

```bat
npm install
npm test
```

個別実行: `node --test test/model.test.js`
