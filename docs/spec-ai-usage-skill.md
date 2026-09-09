# AI 向け利用ガイド（checklist-maker スキル）— 設計と決定事項

作成日: 2026-07-27

他プロジェクトで作業している AI（Claude）に、CheckListMaker を「手順書を作る道具」として
使わせるための資料を用意した。その設計判断を残す。

---

## 背景と要求

> 他のプロジェクトの際にこのツールを使って手順書を作る、といった用途で使いたい。
> ほぼ MCP と考えてよい。

「MCP のように AI から呼べる道具として説明してほしい」という要求。

## 調査で分かった前提

- **CheckListMaker は MCP サーバーではない。CLI もライブラリ API も無い。**
  `main.js` は `process.argv` を一切参照せず、`mainWin.loadFile('index.html')` で
  ウィンドウを開くだけ。`.docx` / `.xlsx` / `.csv` / `.pdf` の書き出しは、すべて
  Electron メインプロセスのネイティブ保存ダイアログを経由する（`preload.js`）。
  → **AI がこのアプリをプロセスとして「呼ぶ」ことはできない。**
- 一方、**機械可読・機械書き込み可能なインターフェースは存在する**。それが state JSON。
  取り込み時のアプリ側の検証は `Array.isArray(data.checklists)` の1行だけ。
  実物大の例が `docs/templates/exe作成手順.checklist.json`（5フェーズ・18手順・1.5MB）。

## 決定事項

### 決定1: AI 向けインターフェースは state JSON ＋ 取り込み用 HTML

AI にとっての「ツールとしての CheckListMaker」は **「正しいデータを書けること」** と定義し、
そこを MCP のツールスキーマ相当の精度で書き切る。

出力は2形式:

- **state JSON**（`.checklist.json`）— 正本
- **取り込み用 HTML** — `<script type="application/json" id="clm-data">` にデータを埋め、
  加えて人が読める静的レンダリングを持つ HTML。`scripts/json-to-html.mjs` で生成する

**HTML を既定の受け渡し形式にする。** 理由は取り込みの安全性で、HTML 取り込みは
「同一 `id` なら更新、無ければ追加＝マージ」だから既存データを壊さない。
`parseChecklistFromHtml` は `DOMParser` で `id="clm-data"` を探すだけなので、
アプリ本体を埋め込んだ自己完結 HTML である必要がない——ここが実現可能性の鍵だった。

なお **アプリの「自己完結HTML（名前を付けて保存）」は AI には作れない**
（`index.html` 全体・約430KB の埋め込みが要る）。AI が出すのは閲覧専用の HTML までで、
編集できる HTML が欲しければ取り込んだあとアプリ側で保存し直す。

### 決定2: 配布形態は Claude プラグインにする

当初は `.claude/skills/` 直置きのスキルにしたが、それでは **CheckListMaker リポジトリで
作業しているときしか発動しない**。「他のプロジェクトで手順書を作る」という当初の目的を
満たすには配布の仕組みが要る。

検討した3案:

| 案 | 効く範囲 | 難点 |
|---|---|---|
| プロジェクトごとに `.claude/skills/` へコピー | コピー先だけ | 手作業。更新が伝播しない |
| `~/.claude/skills/` に置く | ローカル全プロジェクト | Web／リモート環境ではコンテナ再生成で消える |
| **プラグイン化** | 一度入れれば全プロジェクト | スキル名が名前空間付きになる |

**プラグイン化を採用**。更新が `git push` で伝播し、Web セッションでも
対象プロジェクトの `.claude/settings.json` に `extraKnownMarketplaces` ＋
`enabledPlugins` を書けば効く。

```
.claude-plugin/marketplace.json           マーケットプレイス（リポジトリ直下）
plugins/checklist-maker/
  .claude-plugin/plugin.json              プラグインのマニフェスト
  skills/checklist-maker/
    SKILL.md                          AI 向け入口（できること／できないこと・手順・厳守事項）
    references/data-format.md         JSON スキーマ全仕様
    references/authoring-guide.md     手順書としての中身の書き方
    references/export-and-limits.md   受け渡し・出力・既知の制約
    templates/minimal.checklist.json    最小例
    templates/procedure.checklist.json  表紙・表つきの実用例
    scripts/validate-checklist.mjs    依存ゼロのバリデータ
    scripts/json-to-html.mjs          依存ゼロの取り込み用 HTML 生成
```

`.claude/skills/checklist-maker/` は **残さず `git mv` で移動した**。
両方に置くと内容が二重管理になり、どちらが正か分からなくなるため
（公式ドキュメントもプラグイン移行時は `.claude/` 側を消すよう案内している）。
代償として、main にマージされるまでこのリポジトリ内では自動発動しない。
その間は `claude --plugin-dir ./plugins/checklist-maker` で読ませる。

このリポジトリ自身の `.claude/settings.json` は変更していない。github ソースの
マーケットプレイスは既定ブランチ（main）を見るため、マージ前に書くと
「プラグインが見つからない」状態になるから。

### 決定3: 同梱スクリプトは外部依存ゼロにする

導入先のプロジェクトで `npm install` できるとは限らない。バリデータ・HTML 生成とも
Node 標準モジュールだけで動くこと（`node:fs` / `node:path` のみ）を必須要件とする。

エラー（取り込めない）と警告（取り込めるが意図と違う可能性）を分け、
エラーがあれば終了コード 1 を返す。

### 決定4: 既存の 1.5MB テンプレートはスキルへコピーしない

`docs/templates/exe作成手順.checklist.json` は画像 base64 込みで 1.5MB あり、
AI が読むには重すぎる。**参照先として案内するだけ**にして、スキルには軽量な見本を2つ置く。

### 決定5: 画像は AI に作らせない

AI は画像を持たない。`"images": []` で出させ、画像はユーザーが録画機能または 🖼 から
入れる運用をドキュメントで案内する。「base64 をでっち上げない」を厳守事項に明記した。

### 決定6: `type` は `"template"` 固定を厳守事項にする

`"todo"` にすると `isTemplate` 判定により **`note` / `time` / `body` / 表紙が
Word・Excel のどの出力にも載らない**。手順書用途では致命的なので、
AI が踏みやすい地雷として SKILL.md の先頭付近に置いた。

### 決定7: JSON 取り込みにマージを追加する（アプリ本体を変更）

state JSON の取り込みは `confirm()` のあと `store.replaceState(data)` を行うため、
**ユーザーの既存データがすべて消える**しか選べなかった。外から JSON を持ち込む運用を
始める以上、これは危険なのでアプリ側を直す。

- `mergeChecklistsInto(state, incoming)` を追加し、取り込み時に
  「追加・更新する（既定）／すべて置き換える／キャンセル」の3択を出す
- 詳細な仕様と検証は **`docs/spec-json-merge-import.md`** に分離した

あわせて、AI の成果物は既定で HTML 経路（もともとマージ）を使うようにしたので、
危険な経路を通らずに済む二重の備えになっている。

## 作業中に見つかったこと（本スキルのスコープ外）

- **CSV 出力が UI から呼び出せない。** `index.html` に `saveCsvViaElectron` と
  `buildCsvText` があり、`preload.js` の `csvAPI` と `main.js` の `csv:save` ハンドラも
  揃っているが、**エディタのツールバーに CSV ボタンが無く `saveCsvViaElectron` の
  呼び出し元が存在しない**（実装済み・未接続）。
  ドキュメントでは「CSV は約束しない」と書き、ボタンを足すかどうかは別途判断とする。

## 追従メモ: v1.0.1 の UI 変更（2026-09-09）

本ブランチは PR #42 から分岐しており、その後 `main` に入った14コミット
（画像の一括インポート・画像編集強化・PDF の倍率／用紙指定、および PR #44 の機能修正6件）を
知らないまま書かれていた。とくに **PR #44 のメニューバー横一列化**で、スキルが AI に
「利用者へこう案内しろ」と指示している UI 名がほぼ全部変わっていたため、マージ前に追従させた。

| 旧表記 | 現行（v1.0.1〜） |
| --- | --- |
| 「📤 他ファイルで出力」タブ | 「ファイルで出力 ▾」ドロップダウン |
| 「💾 名前を付けて保存 (HTML)」 | ドロップダウン内「名前を付けて保存（HTML）」 |
| 「📄 Word (.docx)」「📊 Excel (.xlsx)」「📕 PDF」「🔗 共有リンク」 | 絵文字なしで同ドロップダウン内 |
| 「▶ 実行」 | 「作業を開始」（小窓が使える環境は「作業を開始 ▾」） |
| 「🖨 印刷」／「🪧 表紙」／「↺ 一括リセット」 | 「印刷」／「表紙を編集」／「作業をリセット」 |
| 録画ボタン（⏺） | 上部バー「キャプチャ撮影」（SVGアイコン＋文字ラベル） |

あわせて次も反映した。詳細は `docs/spec-editor-menubar.md` を参照。

- **印刷プレビューの用紙・向き・倍率（30〜200%）と改ページの目安線**を
  `export-and-limits.md` に追記。倍率は画像にも効く。
- **上部バー「画像インポート」でフォルダ内の画像を1枚＝1手順として取り込める**ことを
  `authoring-guide.md` の画像フローに追加。
- `data-format.md` が本体を**行番号で引用**していた2箇所は、改修のたびにずれるので
  **関数名だけの引用**に改めた（同梱スクリプトはもともとシンボル名で引用しており、
  `RB_ALLOWED_TAGS` / `COVER_PRESETS` ほか全シンボルの現存を確認済み・ロジックは無変更）。
- 決定7（JSON のマージ取り込み）を入れたことで成立しなくなっていた
  「取り込みは全置換なので」という記述を2箇所直した
  （`authoring-guide.md` §7 と `json-to-html.mjs` の冒頭コメント）。

## 変更範囲

- 新規: `.claude-plugin/marketplace.json`、`plugins/checklist-maker/**`、
  `docs/spec-json-merge-import.md`、`test/aiskill.test.js`
- 変更: `index.html`（マージ取り込み＝決定7）、`README.md`、`test/io.test.js`
- `main.js` などメインプロセス側は無変更

## 検証

- バリデータが実在の手順書データ `docs/templates/exe作成手順.checklist.json` を
  エラー・警告ゼロで通ること
- 新規テンプレート2つがエラー・警告ゼロで通ること
- 壊した JSON（id 重複・`type` 不正・`body` の禁止タグ・`checklists` 欠落）で
  エラーと終了コード 1 を返すこと
- `test/aiskill.test.js` — テンプレート2つを実際に `index.html` へ読み込ませ、
  編集画面が描画できることを jsdom ハーネスで確認する（回帰防止）
- `json-to-html.mjs` が出す HTML を `parseChecklistFromHtml` が読み戻せること
  （`id` / タイトル / 全手順 / メモ / 表紙が保たれる）。埋め込み JSON 中の
  `</script>` が退避され、途中で script が閉じないこと
- 生成 HTML の「見える部分」に手順名と表が描画され、スクリプトが混ざらないこと
- プラグインのマニフェスト整合（`plugin.json` の必須項目、`marketplace.json` の
  `source` が実在すること、version が両者で一致すること、
  `.claude/skills/` 側に複製が残っていないこと）
- マージ取り込みの検証は `docs/spec-json-merge-import.md` を参照
