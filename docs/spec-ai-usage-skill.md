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

### 決定1: AI 向けインターフェースは state JSON に一本化する

AI にとっての「ツールとしての CheckListMaker」は **「正しい `.checklist.json` を書けること」**
と定義する。そこを MCP のツールスキーマ相当の精度で書き切る。

自己完結 HTML の生成も理屈の上では可能だが、`index.html` 全体（388KB）を埋め込む必要が
あるため AI が一から作るのは非現実的。**既存の書き出し HTML を編集する用途**にとどめ、
ドキュメント上は「マージ取り込みができる形式」として紹介するだけにする。

### 決定2: 配布形態は Claude スキルにする

単独の Markdown 1枚だと、別プロジェクトの AI が自動で見つけられない。
本リポジトリは既に `dev-policy` スキルで「方針を他リポジトリへ運ぶ」パターンを持っており、
「他のプロジェクトで使う」という要求にそのまま合致する。同じ形に揃える。

```
.claude/skills/checklist-maker/
  SKILL.md                          AI 向け入口（できること／できないこと・手順・厳守事項）
  references/data-format.md         JSON スキーマ全仕様
  references/authoring-guide.md     手順書としての中身の書き方
  references/export-and-limits.md   受け渡し・出力・既知の制約
  templates/minimal.checklist.json    最小例
  templates/procedure.checklist.json  表紙・表つきの実用例
  scripts/validate-checklist.mjs    依存ゼロのバリデータ
```

### 決定3: バリデータは外部依存ゼロにする

導入先のプロジェクトで `npm install` できるとは限らない。Node 標準モジュールだけで
動くこと（`node:fs` / `node:path` のみ）を必須要件とする。

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

### 決定7: JSON 取り込みの「全置換」は今回ドキュメントで警告するに留める

state JSON の取り込みは `confirm()` のあと `store.replaceState(data)` を行うため、
**ユーザーの既存データがすべて消える**。「1件だけ追加する取り込み」はアプリ側に無い。

今回はアプリ本体に手を入れず、次の2点をドキュメントで担保する:

- ユーザーへの案内文にバックアップの警告を必ず入れる
- 既存データがある場合は「現在の JSON を書き出してもらい、`checklists` 配列に追記して返す」
  運用を推奨する

アプリ側に「1件マージ取り込み」を足すかどうかは**別タスク**とし、本スキルのスコープ外とする。

## 作業中に見つかったこと（本スキルのスコープ外）

- **CSV 出力が UI から呼び出せない。** `index.html` に `saveCsvViaElectron` と
  `buildCsvText` があり、`preload.js` の `csvAPI` と `main.js` の `csv:save` ハンドラも
  揃っているが、**エディタのツールバーに CSV ボタンが無く `saveCsvViaElectron` の
  呼び出し元が存在しない**（実装済み・未接続）。
  ドキュメントでは「CSV は約束しない」と書き、ボタンを足すかどうかは別途判断とする。

## 変更範囲

`index.html` / `main.js` などアプリ本体には手を入れていない（ドキュメントと新規スキルのみ）。

## 検証

- バリデータが実在の手順書データ `docs/templates/exe作成手順.checklist.json` を
  エラー・警告ゼロで通ること
- 新規テンプレート2つがエラー・警告ゼロで通ること
- 壊した JSON（id 重複・`type` 不正・`body` の禁止タグ・`checklists` 欠落）で
  エラーと終了コード 1 を返すこと
- `test/aiskill.test.js` — テンプレート2つを実際に `index.html` へ読み込ませ、
  編集画面が描画できることを jsdom ハーネスで確認する（回帰防止）
