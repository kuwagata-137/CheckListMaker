# 確定仕様: 1-1 保存基盤の移行（localStorage → JSON＋画像個別ファイル）

ロードマップ「1-1. 保存基盤の移行」の実装にあたり確定した詳細仕様。
方針（保存先・アトミック書き込み・互換維持・マイグレーション）はロードマップ本文の
とおり。ここではロードマップに書かれていない実装レベルの決定事項を記録する。

## 保存先とファイル構成（Electron のみ）

```
<userData>/data/
  checklists.json        … state 全体（画像は参照化済み）
  checklists.json.bak    … 直前世代（書き込みのたびに退避）
  images/<uuid>.jpg|png  … 画像1枚1ファイル
```

- 書き込み手順: `checklists.json.tmp` に書く → 既存の `checklists.json` を `.bak` へ
  rename → `.tmp` を `checklists.json` へ rename。途中でクラッシュしても
  「旧版（.bak）か新版のどちらか」が必ず残る。
- 読み込みは `checklists.json` → 壊れていれば `.bak` の順で試す。

## 画像の参照形式

- 参照文字列は **`img:<uuid>.<ext>`**（例: `img:2f9c….jpg`）。拡張子を含めるのは
  読み出し時に MIME をファイル名だけで決めるため。ファイル名は
  `^[0-9a-fA-F-]{36}\.(jpg|png)$` で厳格に検証する（パストラバーサル防止）。
- 参照化する対象は **`item.images[]`** と **`item.imageEdits[].base` / `.strokes`**。
  - `coverPage.logo` は対象外（400px に圧縮済みで小さく、表紙プレビュー・
    印刷・rasterize で同期参照されるため dataURL 直持ちのまま）。
  - リッチ本文（`item.body`）は sanitizer が `<img>` を許可していないため画像を含まない。
- ブラウザ単体・書き出した単体 HTML は従来どおり dataURL 直持ち（無改修で互換維持）。

## IPC チャンネル（`window.storageAPI`）

| チャンネル | 内容 |
| --- | --- |
| `storage:load` | `{ ok, json:string\|null }`。JSON 文字列を返す（初回は null）。読み込み成功時に孤児画像の GC を実施 |
| `storage:save` | 引数 JSON 文字列。アトミック書き込み。直列化して実行 |
| `image:save` | 引数 dataURL → `{ ok, ref }`。images/ に書いて参照を返す |
| `image:get` | 引数 ref → `{ ok, dataUrl }` |
| `image:delete` | 引数 ref。現状は GC が主で通常フローでは未使用 |

## 画像ファイルのライフサイクル（GC）

- 状態から画像参照が消えても**ファイルは即座に消さない**（Undo で参照が復活し得るため）。
- **起動時の `storage:load` で GC** する: JSON 文字列中の `img:` 参照を正規表現で集め、
  `images/` にあって参照されていないファイルを削除する。Undo 履歴はセッション内
  メモリのみなので、起動時点では保存済み state が唯一の真実で安全。
- 複製リストは同じ参照を共有してよい（GC は全 JSON を見るので、最後の参照が
  消えるまでファイルは残る）。

## アダプタと保存の非同期化

- `FileAdapter` を追加。`load()` は起動時に await 済みの初期 state を返す
  （既存 Store の同期インターフェースを変えない）。
- `save()` は JSON を直列キューで `storage:save` に流し、**楽観的に true を返す**。
  失敗は console ＋ 1回だけの alert で通知（本格的な可視化は 1-3 で実装）。
  localStorage の容量チェック（`commitImage` の undo 巻き戻し）は
  LocalStorageAdapter 専用の挙動としてそのまま残す。
- アダプタ選択（起動時に自動判定）:
  Electron → FileAdapter ／ ブラウザ単体 → LocalStorageAdapter ／
  単体HTML → MemoryAdapter（従来どおり）。

## 表示と入出力の変換ポイント

- **表示（サムネイル）**: 同期 render のため、キャッシュ済みなら dataURL、未取得なら
  プレースホルダ SVG を出しつつ非同期取得 → 取得後は再描画せず
  `img[data-img-ref]` の src を直接差し替える（全再描画するとフォーカスが壊れるため）。
  取得済み dataURL はセッション中 Map にキャッシュ（従来は全画像が常時 state に
  居たので、メモリ使用は従来以下）。
- **参照 → dataURL（materialize）**: JSON エクスポート / 単体HTML書き出し /
  印刷・PDF プレビュー / Word 出力 / 画像エディタ起動時。deep clone に対して行う。
- **dataURL → 参照（absorb）**: JSON インポート / HTML 取り込み /
  初回マイグレーション / 画像追加・画像エディタ保存時。
- 共有リンクは従来どおり画像を除外するため変換不要。

## マイグレーション（Electron 初回起動）

1. `storage:load` が null（ファイル未作成）で、localStorage に `checklistmaker.v1` が
   あり、完了マーカー `checklistmaker.v1.migratedToFile` が無ければ実行。
2. dataURL を画像ファイルへ展開して参照化 → `storage:save` → 成功したら
   マーカー（ISO 日時）を localStorage に書く。**元データは消さない**（切り戻し用）。
3. 保存に失敗したら LocalStorageAdapter で従来どおり継続（次回起動時に再試行）。
   途中まで書いた画像ファイルは次回の起動時 GC が回収する。

## 変更ファイル

- `storage.js`（新規・メインプロセス）: 上記 IPC の実装。前提2（メインプロセスの
  ファイル分割許容）に基づく分割第1号。
- `main.js`: storage.js の登録のみ。
- `preload.js`: `window.storageAPI` の公開。
- `index.html`: FileAdapter / 画像参照レイヤ / materialize・absorb / 起動処理の
  非同期化（IIFE を async 化）/ 各入出力点の変換。
- `package.json`: build.files に storage.js を追加。
