# JSON のマージ取り込み — 仕様

作成日: 2026-07-27

## 背景

JSON 取り込みは `confirm()` の2択で、OK を押すと `store.replaceState(data)` を実行していた。
つまり **取り込む＝ユーザーの既存チェックリストが全部消える** しか選べなかった。

一方 HTML 取り込みは以前から「同一 `id` なら更新、無ければ追加」＝マージで、
既存データを壊さない。同じ「取り込み」なのに挙動が非対称で、危険なほうが JSON 側だった。

AI に手順書データを書かせる運用（`docs/spec-ai-usage-skill.md`）を始めると、
外から JSON を持ち込む機会が増える。全置換しか選べないままでは事故が起きる。

## 決定

### 1. マージを純関数として切り出す

`index.html` の model セクションに追加する。

```js
function mergeChecklistsInto(state, incoming) → { added, updated }
```

- `incoming.checklists` を先頭から見て、`state.checklists` に同一 `id` があれば**置換**、
  無ければ**末尾へ追加**する
- `settings` は**既存を保持**する（取り込み側のテーマ設定で上書きしない）
- `incoming` が null／`checklists` が配列でない／要素がオブジェクトでない場合は
  **黙って無視**する（例外にしない）
- 戻り値は件数。取り込み後のトースト表示に使う

**HTML 取り込みと同じ意味論**にすることを要件とする（テストで担保）。

### 2. 取り込み方をユーザーに選ばせる

`confirm()` をやめ、既存の `buildModal` / `closeModal` で3択のモーダルにする。

```
JSON を取り込む
読み込んだファイルにはチェックリストが N件 あります。取り込み方を選んでください。

[ 追加・更新する ]（primary＝既定）  [ すべて置き換える ]（danger）  [ キャンセル ]
```

- **追加・更新する** → `mergeChecklistsInto`。トースト「N件を追加、M件を更新しました。」
- **すべて置き換える** → 従来どおり `replaceState`。トースト「N件で置き換えました。」
- **キャンセル**／背景クリック → 何もしない

`askJsonImportMode(count)` は `'merge' | 'replace' | null` を返す Promise。
背景クリックとキャンセルボタンは `buildModal` 側が DOM を消すため、
`MutationObserver` でそれを検知して `null` に解決する（未解決の Promise を残さない）。

### 3. HTML 取り込み側は変更しない

もともとマージなので手を入れる必要がない。

## 変更範囲

`index.html` のみ。

- model セクション: `mergeChecklistsInto` を追加、`M` の export に追加
- `askJsonImportMode` を `buildModal` / `closeModal` の隣に追加
- ファイル取り込みハンドラの JSON 分岐を差し替え
- CSS: `.modal-actions.import-modes` / `.import-note` / `.btn.danger` を追加
- `window.__test__` に `mergeChecklistsInto`（`M` 経由）・`askJsonImportMode`・
  `parseChecklistFromHtml` を追加

メインプロセス側（`main.js` / `storage.js`）は無変更。

## 検証

`test/io.test.js` に追加した。

- 新しい `id` は追加され、既存は消えない
- 同一 `id` は置換され、件数は増えない／他は巻き添えにならない
- 追加と更新が混ざったときの件数
- `settings` が取り込み側で上書きされない
- 空・不正な入力（`null`、`{}`、`[null, 'x']`）で例外にならず既存も無傷
- **HTML 取り込みと同じ結果になる**
- ダイアログ: 3つのボタンがそれぞれ `'merge'` / `'replace'` / `null` を返す。
  背景クリックでも `null`。件数が文面に出る。既定が「追加・更新する」（primary）。

## 影響と移行

- 既存ユーザーへの破壊的変更は無い。「すべて置き換える」を選べば従来と同じ
- 既定が「追加・更新する」に変わるため、**バックアップ JSON を丸ごと戻したい**ときは
  「すべて置き換える」を明示的に選ぶ必要がある
