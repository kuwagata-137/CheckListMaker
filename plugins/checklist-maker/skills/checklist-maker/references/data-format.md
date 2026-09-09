# CheckListMaker データ形式リファレンス

CheckListMaker が読み書きする **state JSON** の全仕様。AI が手順書を作るときは、
このスキーマどおりの JSON を1ファイル書けばよい。

一次情報はアプリ本体 `index.html` のファクトリ関数（`createItem` / `createSection` /
`createCoverPage` / `createChecklist`）。本書はそれを写したもの。
（行番号は改修のたびにずれるので書かない。関数名で検索すること。）

---

## 1. 全体構造

```jsonc
{
  "checklists": [ /* チェックリスト（＝1冊の手順書）の配列 */ ],
  "settings": { "theme": "auto" }
}
```

取り込み時のアプリ側の検証は**この1点だけ**:

```js
if (!data || !Array.isArray(data.checklists)) {
  throw new Error('JSON に checklists 配列が見つかりません');
}
```

つまり `checklists` さえ配列なら取り込みは通る。**通ることと正しく表示されることは別**なので、
以降のフィールド仕様に従い、`scripts/validate-checklist.mjs` で検証すること。

### 階層

```
state
└ checklists[]        … 1件＝1冊の手順書
  └ sections[]        … 章。type="template" では UI 上「フェーズ」と呼ばれる
    └ items[]         … 1件＝1手順
```

---

## 2. checklist

| フィールド | 型 | 要否 | 内容 |
|---|---|---|---|
| `id` | string | **必須** | 全体でユニーク。任意の文字列（アプリは `crypto.randomUUID()` を使う） |
| `title` | string | **必須** | 手順書のタイトル。ファイル名や Excel のシート名にも使われる |
| `type` | string | **必須** | `"template"` または `"todo"`。**手順書は必ず `"template"`** |
| `sections` | array | **必須** | 1件以上。空配列だとアプリが空セクションを1つ補う |
| `createdAt` / `updatedAt` | number | 任意 | epoch ミリ秒 |
| `coverPage` | object | 任意 | 表紙。`type: "template"` のときだけ描画される |

### `type` の違いは見た目だけではない

`"todo"` にすると、**`time`（標準時間）・`note`（メモ）・`body`（詳細）が
Word / Excel のどの出力にも載らない**（`index.html` の `renderDocxView` /
`buildXlsxSheetData` にある `isTemplate` 判定）。表紙も出ない。
手順書を作る目的なら `"template"` 以外にしてはいけない。

| | `template` | `todo` |
|---|---|---|
| 表紙・目次 | 出る | 出ない |
| `note` / `time` / `body` の出力 | 出る | **出ない** |
| チェック記号 ☐/☑ の Word 出力 | 出さない | 出す |
| 作業をリセット（全チェックを外す） | できる | — |

---

## 3. section

| フィールド | 型 | 要否 | 内容 |
|---|---|---|---|
| `id` | string | **必須** | ユニーク |
| `title` | string | 推奨 | 章／フェーズ名。空文字も可 |
| `items` | array | **必須** | 手順の配列 |

セクションの `title` は Word では見出し2、Excel では区切り行になる。
配下の手順の `time` 合計が自動で見出し行末に「⏱N分」として出る。

---

## 4. item（1手順）

`createItem()` の既定値は
`{ id, text, done: false, note: '', time: '', images: [], body: '' }`。
**7つとも書いておくのが安全**（欠けていても多くは動くが、既定値を明示したほうが事故がない）。

| フィールド | 型 | 要否 | 内容 |
|---|---|---|---|
| `id` | string | **必須** | ユニーク |
| `text` | string | **必須** | 手順の見出し1行。プレーンテキスト（HTML 不可・エスケープされる） |
| `done` | boolean | 推奨 | チェック状態。新規作成なら `false` |
| `note` | string | 任意 | 補足メモ。**プレーンテキスト**。Word では「（メモ）〜」の段落になる |
| `time` | string | 任意 | 標準時間（分）を**文字列**で。例 `"5"`。`parseInt` で合計される |
| `images` | array | 任意 | 画像。後述 |
| `body` | string | 任意 | 詳細本文。**サニタイズ済み HTML**。表や箇条書きが書ける |
| `imageEdits` | array | 非推奨 | `images` と同じ長さの並行配列（注釈編集の元データ） |
| `imagesFull` | array | 非推奨 | `images` と同じ長さの並行配列（原寸画像） |

### `body` に書ける HTML

サニタイズの allowlist（`index.html` の `RB_ALLOWED_TAGS`）は次の20タグ**だけ**。

```
P BR STRONG B EM I U S STRIKE SPAN UL OL LI TABLE THEAD TBODY TR TH TD DIV
```

- **`<img>` / `<a>` / `<h1>`〜`<h6>` / `<script>` / `<code>` / `<pre>` は使えない**（削除される）
- 画像は `body` ではなく `images[]` に入れる
- 表は `<table><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr></tbody></table>`
- `<span style="...">` の色・文字サイズは通る（色は `#RRGGBB` / `rgb()` / 色名）

`body` は Excel では `htmlToPlainText()` でプレーンテキスト化されて「詳細」列に入る
（表のセル間はタブ、ブロック要素は改行になる）。Word には HTML のまま渡り、表は罫線付きで出る。

### `text` と `note` と `body` の使い分け

| | 用途 | 書式 |
|---|---|---|
| `text` | 「何をするか」1動作を1行で | プレーンテキスト |
| `note` | 短い補足・注意・用語説明 | プレーンテキスト |
| `body` | 手順の詳細、設定値の表、選択肢の一覧 | 限定 HTML |

### `images[]`

各要素は文字列で、次のどちらか。

1. **dataURL** — `data:image/png;base64,...` / `data:image/jpeg;base64,...`
   （Excel 出力が拾うのは `png` / `jpe?g` / `gif` のみ。**webp は無視される**）
2. **ファイル参照** — `img:<uuid>.jpg` または `img:<uuid>.png`
   （デスクトップ版が `<userData>/data/images/` に実体を持つときの形式。
   uuid 部は `[0-9a-fA-F-]{36}`。`storage.js` の `IMG_REF_PREFIX` / `IMG_FILE_RE`）

**AI が JSON を書くときは `"images": []` にする。** 画像を持っていないのに base64 を
でっち上げてはいけない。画像はユーザーが CheckListMaker 側で貼る（`authoring-guide.md` 参照）。

---

## 5. coverPage（表紙）

`type: "template"` かつ `coverPage.enabled === true` のときだけ描画される
（`index.html` の `isTemplate && checklist.coverPage && checklist.coverPage.enabled`）。

> フィールド名は **`coverPage`**。`cover` ではない（`cover` は本体コード内のローカル変数名）。

| フィールド | 型 | 内容 |
|---|---|---|
| `enabled` | boolean | `true` で表紙を出す |
| `includeToc` | boolean | 目次を出す。`false` を明示しない限り出る |
| `preset` | string | レイアウト。下記10種のいずれか。未知の値は `centered` に落ちる |
| `accent` | string | 差し色。`^#[0-9a-fA-F]{3,8}$` に一致しないと既定 `#3b6ea5` |
| `title` | string | 表紙タイトル。空なら `checklist.title` が使われる |
| `subtitle` | string | サブタイトル |
| `author` | string | 作成者 |
| `date` | string | **ISO `yyyy-mm-dd`**。表示は「yyyy年m月d日」に整形される |
| `version` | string | 版数 |
| `docNumber` | string | 文書番号 |
| `logo` | string | ロゴ画像の dataURL。空文字なら出ない |
| `revisions` | array | 改訂履歴 `[{ id, version, date, author, note }]`。`date` も ISO |

`preset` の有効値:

```
centered | left-top | top-band | side-band | framed | hero | logo-top | split | minimal | doc-header
```

用途の目安 — 社内の正式な手順書なら `doc-header`（文書番号・版数・作成者を枠で出す）か
`left-top`。表題を大きく見せたいだけなら `centered`。

> `title` / `subtitle` / `author` / `version` / `docNumber` は表紙側でも
> **`body` と同じサニタイズを通る**（リッチ編集対応のため）。プレーンテキストで書けば安全。
> `date` だけは HTML ではなく素テキストとして整形される。

---

## 6. state JSON 以外の入出力形式

参考までに。AI が書くのは基本 **1. の state JSON** だけでよい。

| 形式 | 取り込みの挙動 | 備考 |
|---|---|---|
| **state JSON** | 取り込み時に **「追加・更新する」／「すべて置き換える」** を選ばせる | AI が書くのはこれ |
| **`clm-data` を持つ HTML** | **同一 `id` なら更新、無ければ追加**（マージ・確認なし） | **AI はこれも出せる**。`scripts/json-to-html.mjs` |
| 共有 URL | `#share=<base64>` を開くと取り込む | **画像は落ちる** |
| 録画セッションフォルダ | 取り込みウィザードから | `<Pictures>/CheckListMaker/…` 配下のみ |

HTML 取り込みは `parseChecklistFromHtml` が `DOMParser` で
`id="clm-data"` の `<script type="application/json">` を1つ探すだけなので、
**アプリを丸ごと埋め込んだ自己完結 HTML である必要はない**。
そのため AI でも生成でき、しかもマージなので既存データを壊さない。
**受け渡しの既定はこの HTML にする**（詳細は `export-and-limits.md`）。

---

## 7. 最小の有効例

```json
{
  "checklists": [
    {
      "id": "clm-0001",
      "title": "サンプル手順書",
      "type": "template",
      "sections": [
        {
          "id": "clm-0001-s1",
          "title": "① 準備",
          "items": [
            {
              "id": "clm-0001-i1",
              "text": "電源を入れる",
              "done": false,
              "note": "",
              "time": "1",
              "images": [],
              "body": ""
            }
          ]
        }
      ]
    }
  ],
  "settings": { "theme": "auto" }
}
```

動く見本は同梱の `templates/minimal.checklist.json` と
`templates/procedure.checklist.json`。表紙・表つきの実物大の例は、CheckListMaker
リポジトリの `docs/templates/exe作成手順.checklist.json`（1.5MB・画像込みなので
必要なときだけ開くこと）。
