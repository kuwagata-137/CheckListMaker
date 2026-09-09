---
name: checklist-maker
description: CheckListMaker（デスクトップアプリ）で開ける手順書・チェックリストのデータ（.checklist.json）を作成・編集するときに必ず使用するスキル。「手順書を作って」「作業マニュアルにして」「この作業をチェックリスト化して」「運用手順をまとめて」「CheckListMaker で読める形式にして」「Word/PDF で配れる手順書にして」などの依頼が来たら迷わずこのスキルを使うこと。フェーズ→手順への分解、JSON スキーマ（表紙・標準時間・リッチ本文・画像）、依存ゼロのバリデータ、ユーザーへの受け渡しと Word/Excel/PDF 出力までをカバーする。
---

# checklist-maker — CheckListMaker 用の手順書データを作る

CheckListMaker は、手順書・チェックリストを作って **Word / PDF / Excel** に出力できる
デスクトップアプリ（Electron）。操作しながらクリック連動でスクリーンショットを自動撮影する
「録画」機能を持つのが特徴。データは端末から出ない。

このスキルは、**別のプロジェクトで作業している AI が、その作業内容から
CheckListMaker で開ける手順書データを起こす**ためのもの。

---

## 最初に — できること／できないこと

| | |
|---|---|
| ✅ **できる** | CheckListMaker が読み込める **state JSON** を書く。既存 JSON に手順書を追記する |
| ❌ できない | アプリを起動する／コマンドで呼び出す |
| ❌ できない | `.docx` `.pdf` `.xlsx` を直接生成する（出力はアプリ内の保存ダイアログ経由） |
| ❌ できない | スクリーンショットを撮る（録画はユーザーが手元で実行する機能） |

**CheckListMaker は MCP サーバーではない。CLI もライブラリ API も無い。**
AI とアプリをつなぐ唯一の機械的インターフェースが `checklists` 配列を持つ JSON であり、
このスキルの実体は「その JSON を正しく書くこと」に尽きる。
この前提をユーザーに隠さずに伝えること。

---

## 手順

### 1. 素材を集めて、フェーズと手順に分解する

対象プロジェクトの README・`docs/`・CI 設定・`package.json` の scripts・
これまでの会話から、**実際に動く手順**を拾う。工程で切る（準備 / 実施 / 確認）。

素材に無い手順を想像で足さない。分からない項目（所要時間・担当者・文書番号・日付）は
空のままにして、あとでユーザーに聞く。

→ 書き方の詳細: **`references/authoring-guide.md`**

### 2. JSON を書く

`templates/minimal.checklist.json`（最小）か
`templates/procedure.checklist.json`（表紙・表つき）をコピーして書き換えるのが速い。

→ 全フィールド仕様: **`references/data-format.md`**

```jsonc
{
  "checklists": [{
    "id": "…",                 // ユニークな文字列
    "title": "…",
    "type": "template",        // 手順書は必ず template
    "coverPage": { … },        // 任意（正式文書なら付ける）
    "sections": [{             // ＝フェーズ
      "id": "…", "title": "① 準備：…",
      "items": [{              // ＝手順
        "id": "…",
        "text": "設定画面を開く",     // 1手順1動作・動詞で終える
        "done": false,
        "note": "補足・注意（プレーンテキスト）",
        "time": "5",                 // 標準時間（分）を文字列で
        "images": [],                // AI は必ず空にする
        "body": "<p>詳細。表も書ける</p>"   // 限定 HTML
      }]
    }]
  }],
  "settings": { "theme": "auto" }
}
```

### 3. 検証する

```bash
node <このスキル>/scripts/validate-checklist.mjs path/to/output.checklist.json
```

外部依存ゼロ（Node 標準のみ）なので、どのプロジェクトでもそのまま動く。
エラーが1件でもあれば終了コード 1。**エラーが消えるまで直してから渡すこと。**

### 4. 取り込み用 HTML も出す（既定の受け渡し形式）

```bash
node <このスキル>/scripts/json-to-html.mjs path/to/output.checklist.json
```

**JSON だけでなく、この HTML を主たる成果物として渡す。** 理由は取り込み時の安全性:

| 渡す形式 | 取り込みの挙動 |
|---|---|
| **HTML**（推奨） | **同一 `id` は更新、無ければ追加＝マージ。既存データは消えない** |
| JSON | 「追加・更新」か「すべて置き換える」をユーザーが選ぶ（選択を誤ると既存が消える） |

出力される HTML は、ブラウザで開けば手順書として読める静的ページでもある。
ただし**アプリの「自己完結HTML」ではないので編集はできない**（読むだけ）。
編集できる HTML が要るなら、取り込んだあとアプリの
「ファイルで出力 ▾」→「名前を付けて保存（HTML）」を使う。

### 5. ユーザーに渡し方を案内する

→ **`references/export-and-limits.md`** の手順をそのまま伝える。最低限これは必ず言う:

> - CheckListMaker のホーム画面「インポート」から、この **HTML** を選んでください。
>   同じ ID のチェックリストがあれば更新、無ければ追加されるので、**既存のデータは消えません**。
> - 画像は入れていません。上部バーの「キャプチャ撮影」で操作を撮って各手順に貼るか、
>   「画像インポート」でフォルダ内の画像をまとめて取り込むか、各手順の「🖼 画像」から貼れます。
> - 仕上げはエディタの「ファイルで出力 ▾」から
>   「Word (.docx)」「Excel (.xlsx)」「PDF」（デスクトップ版のみ）。

JSON を渡す場合は、取り込み時に **「追加・更新する」** を選ぶよう必ず添える
（「すべて置き換える」を選ぶと既存データが消える）。

---

## 必ず守る規則

1. **`type` は `"template"`。** `"todo"` にすると `note` / `time` / `body` / 表紙が
   Word・Excel のどの出力にも載らない。
2. **`id` は checklist / section / item を通してユニーク**にする。
3. **`images` は `[]`。** 手元に本物の画像が無いのに base64 をでっち上げない。
4. **`body` に使えるタグは20種の allowlist だけ** —
   `P BR STRONG B EM I U S STRIKE SPAN UL OL LI TABLE THEAD TBODY TR TH TD DIV`。
   `<img>` `<a>` `<h1>`〜`<h6>` `<script>` は削除される。
5. **`time` は半角数字の文字列**（`"5"`）。日付は ISO（`yyyy-mm-dd`）。
6. **値をでっち上げない。** 所要時間・文書番号・版数・日付・担当者が不明なら空にして質問する。
7. **渡す前に必ずバリデータを通す。**

---

## このスキルの中身

| パス | 内容 |
|---|---|
| `references/data-format.md` | JSON スキーマの全仕様（フィールド・型・制約・出典行） |
| `references/authoring-guide.md` | 手順書として良い中身の書き方（分解・文体・並び順・画像運用） |
| `references/export-and-limits.md` | 受け渡し手順、Word/Excel/PDF 出力、既知の制約 |
| `templates/minimal.checklist.json` | 1フェーズ・3手順・画像なしの最小例 |
| `templates/procedure.checklist.json` | 表紙＋3フェーズ＋表つき本文の実用例 |
| `scripts/validate-checklist.mjs` | 依存ゼロのバリデータ |
| `scripts/json-to-html.mjs` | 依存ゼロの取り込み用 HTML 生成 |

---

## 他のプロジェクトへの導入

このスキルは **CheckListMaker リポジトリのプラグイン**として配布している。

```shell
/plugin marketplace add kuwagata-137/CheckListMaker
/plugin install checklist-maker@checklistmaker
```

一度入れれば全プロジェクトで使える。更新はリポジトリへの push で伝播する。

`/plugin` が使えない Web／クラウドセッションでは、対象プロジェクトの
`.claude/settings.json` に次を書く:

```json
{
  "extraKnownMarketplaces": {
    "checklistmaker": { "source": { "source": "github", "repo": "kuwagata-137/CheckListMaker" } }
  },
  "enabledPlugins": { "checklist-maker@checklistmaker": true }
}
```

設定ファイルを書き換えてコミットするかどうかは**ユーザーに確認する**。
勝手に PR を立てたりマージしたりしない。

---

## 出典（アプリ本体のどこを見て書いたか）

CheckListMaker リポジトリの以下に対応する。仕様を疑ったらここを読むこと。

- データモデル: `index.html` の `createItem` / `createSection` / `createCoverPage` /
  `createChecklist`（1484〜1548行付近）
- 本文サニタイズの allowlist: `index.html` の `RB_ALLOWED_TAGS`
- JSON 取り込み（全置換）: `index.html` のファイル取り込みハンドラ
- 画像参照形式: `storage.js` の `IMG_REF_PREFIX` / `IMG_FILE_RE`
- Word 出力: `index.html` の `renderDocxView` ＋ `docx-postprocess.js`
- Excel 出力: `xlsx-export.js`、`docs/spec-3-A-xlsx-csv.md`
  （CSV は `buildCsvText` / `saveCsvViaElectron` が実装済みだが UI から呼ばれていない）
- 実物大の手順書データ: `docs/templates/exe作成手順.checklist.json`（1.5MB）
