# 1-3 エラーの可視化 — 確定仕様

ロードマップ 1-3 の実装にあたっての決定事項。2026-07-13 確定。

## 目的

実行時エラーと保存失敗が console 止まりで誰にも見えない状態を解消する。
**外部送信は一切しない**（ログはローカルファイルのみ）。

## 1. エラーログ（Electron のみ）

- メインプロセスに `errorlog.js` を追加。`log:write` IPC でレンダラーからの
  エラー記録を受け、`<userData>/logs/error.log` に **JSONL** で追記する。
  1行 = `{ ts, source, kind, message, stack?, extra? }`。
- **ローテーション**: 書き込み前にサイズが 512KB を超えていたら
  `error.log.1` へ rename（1世代のみ保持）。
- メインプロセス自身の `uncaughtException` / `unhandledRejection` も同じログに
  記録する（source: 'main'）。記録後も既定の動作は変えない。
- preload は `window.appLogAPI = { error(entry) }` だけを公開する（読み出しAPIは
  作らない。ログはユーザーがファイルを直接開く想定。場所はメニュー等での案内は将来課題）。

## 2. レンダラーのグローバル捕捉

- `window.addEventListener('error' / 'unhandledrejection')` で捕捉し、
  console.error に加えて `appLogAPI.error` があればファイルへ記録する。
- **暴走対策**: ファイルへの記録は1セッション最大 50 件で打ち切る
  （エラーループでログとIPCを埋め尽くさない）。
- ブラウザ単体・単体HTMLモードは console のみ（ファイルログなし）。挙動は無改修。

## 3. 保存失敗のトースト昇格

- 画面右下に**トースト通知**を追加（純CSS＋DOM、依存なし。エラー用は約10秒表示・
  クリックで閉じる。最大3件スタック）。
- 通知経路は `notifySaveError(message, {force})` に一本化:
  - 表示は **30秒に1回まで**のスロットル（毎コミット失敗の連打防止）。
    `force: true` はスロットルを無視して必ず表示する。
  - 呼ばれるたびエラーログには記録する（表示スロットルとは独立）。
- 呼び出し箇所:
  - `Store.persist()` — `adapter.save()` が false（localStorage 上限など）
  - `FileAdapter` の非同期保存失敗 — 従来の「1回だけ alert」を置き換え
  - `commitImage()` — 画像追加の undo を伴う失敗。操作の直接失敗なので
    `force: true`＋具体的なメッセージ（従来の alert を置き換え）
- MemoryAdapter（単体HTML）は常に成功のため対象外。

## 4. テスト

- `test/errorlog.test.js` — JSONL 追記・不正入力の拒否・ローテーション
- `test/errors.test.js` — レンダラー統合: グローバルエラーがログAPIへ届く／
  保存失敗でトーストが出る／スロットルが効く

## 対象外（今回はやらない）

- gadget.html（録画ガジェット）へのトースト導入
- ログビューア UI・ログ場所を開くメニュー
- 外部送信・クラッシュレポート
