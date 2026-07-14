# 3-R6 ガイドオーバーレイ（再生用ガジェット） — 確定仕様

2026-07-14 確定（モック承認済み）。ロードマップ 3-R6 の実装方針。
録画ガジェット（`gadget.html`・常時最前面・撮影に写らない小窓）の技術を
**そのまま「再生用」に転用**する。ブラウザ拡張型 SaaS には原理的に不可能な独自機能。

## 確定した決定事項（2026-07-14 ユーザー承認・既定案どおり）

1. **実行の挙動は R5 実行モードと完全に同一。** チェック同期（本体へ commit・Undo可）・
   スキップ（チェックなし）・実測時間（保存しない）・再開位置（未チェックの最初）は
   同じ実行エンジン（`openPlayer`）を共有する。小窓は「もう1つの見た目」。
2. **最後のステップを完了したら小窓を閉じ、本体ウィンドウを前面に出して
   R5 の完了サマリを表示**する。
3. **小窓は画面録画・スクリーンショットに写らない**（録画ガジェットと同じ
   `setContentProtection`。Linux は効かないことがある既知事項も同じ）。
4. **表示は通常⇔折りたたみ（1行バー）の2状態＋画像クリックで一時拡大。**
   透明度調整は初版ではやらない。
5. **キーボードは小窓にフォーカスがあるときのみ**（Space/Enter・←→・Esc）。
   グローバルショートカットは初版では実装しない（誤爆防止・業務アプリの入力を奪わない）。
6. **録画ガジェットと同時利用可。** 録画中に小窓を操作したクリックが録画に
   混入しないよう、録画側の自アプリ除外（`isOnOwnWindow`）に小窓も加える。

## 画面と導線（モックどおり）

- **ガイド小窓**: ダークガラスのカード（gadget.html と同様式）。ヘッダ（🧭 リスト名・
  ステップ n/N・✕）・進捗バー・拡大画像（クリックで一時拡大）・手順文・メモ・
  実測/標準・「← / ✓完了して次へ / →」・「▁ 折りたたみ」。カード全体をドラッグで移動。
- **折りたたみ**: 「n/N・文・✓・▔」の1行バー。ウィンドウ高さも縮める。
- **導線（Electron 版のみ表示）**: ①エディタのツールバー「🧭 小窓で実行」
  ②実行モード下部バー「🧭 小窓に切替」（進行状態を引き継ぐ。小窓の✕で全画面へ戻る）。
  ブラウザ単体・書き出しHTMLではボタンを出さない（`window.guideAPI` の有無で判定）。

## 実装方式

- **main.js**: `guideWin`（frameless・transparent・alwaysOnTop(screen-saver)・
  skipTaskbar・`setContentProtection`）。IPC:
  - `guide:open` / `guide:update`（本体→小窓へステップ描画データを中継）
  - `guide:close`（`focusMain` オプションで本体を前面へ）
  - `guide:action`（小窓→本体: complete / skip / prev）
  - `guide:resize`（折りたたみ/展開/一時拡大に合わせた小窓のサイズ変更）
  - ✕やOSで閉じられたら本体へ `guide:closed`（プレイヤーは全画面表示に復帰）
  - `isOnOwnWindow` に `guideWin` を追加（決定6）
- **preload.js**: `window.guideAPI`（本体用: open/update/close/onAction/onClosed、
  小窓用: onStep/sendAction/resize）。
- **guide.html**（新規）: 表示専用。実行状態は持たず、本体からのペイロードを描画して
  操作を送り返すだけ。実測時間はペイロードの秒を種に表示だけローカルで進める。
- **index.html**: `openPlayer` に小窓モードを追加。`guideStepPayload`（純関数・
  テスト対象）でペイロードを組み、画像は `resolveImageAsync` で dataURL に解決して送る。
  小窓モード中は全画面オーバーレイを隠し、キーボードも小窓側に譲る。
- **package.json**: `files` に `guide.html` を追加。

## ペイロード形式（本体→小窓）

```
{ title, sectionTitle, index, total, text, note, stdMin, seconds, image }
```

- `index` は 1 始まり。`stdMin` は分（0=未設定）。`seconds` はそのステップの実測累計秒。
- `image` は解決済み dataURL（無ければ null。純関数 `guideStepPayload` は null のまま返し、
  呼び出し側が非同期で埋める）。

## テスト

`test/guide.test.js` — `guideStepPayload` の単体テストと、`window.guideAPI` スタブを
使った小窓モードの DOM テスト（小窓モードでオーバーレイが隠れる／action で完了が
同期して update が飛ぶ／closed で全画面へ復帰／完走で focusMain 付き close＋サマリ）。
guide.html 自体（Electron 窓）は実機検証項目とする。
