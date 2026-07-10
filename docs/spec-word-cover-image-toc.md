# Word出力の表紙をアプリ表紙の画像埋め込みにする＋表紙機能に「目次を含める」を追加

## Context

PR #24（Word出力の様式化）マージ後のユーザーフィードバックによる修正。現状の実装は
(1) Word出力の表紙が「アプリ表紙のデータだけ使い様式の表題スタイルで組み直した簡易表紙」で、アプリの表紙作成機能のデザイン（10プリセット・アクセント色・ロゴ）が反映されない、
(2) 当初方針「表紙作成機能に目次を追加」が未実装（Word出力に常時TOCフィールドを挿入するだけで、表紙機能側にオプションが無く印刷/PDFにも目次が出ない）。

**ユーザー確定仕様（AskUserQuestionで確認済み）**:
1. Word出力の表紙 = **アプリの表紙作成機能で作った表紙を画像として1ページ目に埋め込む**（デザイン忠実再現。Word上で表紙の文字編集は不可＝直すときはアプリで修正→再出力）
2. 目次 = **表紙作成機能に「目次を含める」オプションを追加**（当初方針）。ONのとき: 印刷/PDFに目次ページ（セクション・手順の一覧、ページ番号なし）、WordにTOCフィールド（ページ番号付き）。OFFのとき: どちらにも出さない
   - 目次オプションは表紙機能に属するため、**表紙が無効なら目次もどこにも出ない**（Word出力の常時TOC挿入は廃止）

## 前提知識（調査済みの事実）

### 表紙機能（index.html）
- `renderCoverHtml(cover, fallbackTitle)`（**2519-2553行**）: `<div class="cover cover--${preset}" style="--cover-accent:${accent}">…</div>` を返す。escapeHtml済み・preset/accentは検証済み
- 表紙CSS（**812-857行**）: `.cover` は **A4縦・96dpi換算の固定 794×1123px**。`color-mix()` 使用あり（Chromium前提）。縮小表示は `scaleCoverStages`（2555-2564行）が `transform: scale(w/794)` で行う（画像化の倍率計算の参考）
- データモデル `createCoverPage()`（**1048-1062行**）: enabled/preset/accent/title/subtitle/author/date/version/docNumber/logo/revisions。マイグレーション無しで読み出し側が防御（`c.xxx || ''`）する流儀
- 表紙エディタ `openCoverDialog(checklistId)`（**3104行〜**）: 有効トグルは `.ce-enable` 内 `<span class="ce-switch" data-ce="toggle">`（3124-3128行）、`refresh()` で `tg.classList.toggle('on', !!draft.enabled)`（3211-3213行）、クリックで `draft.enabled = !draft.enabled; persist(); refresh();`（3231行）。**新トグルはこのパターンを踏襲**
- 印刷ビュー `renderPrintView`（**2568-2636行**）: 表紙は `coverHtml` として先頭（2619-2624行）。印刷CSS（**985-990行**）: `@page coverpage { margin: 0 }` ＋ `.print-cover { page: coverpage; break-after: page; }`
- docx側の現行フロー（PR #24 実装）: `renderDocxView`（1490行付近〜）が `{html, meta}` を返し、マーカー段落を `docx-postprocess.js` の `postProcessDocx(buffer, meta)` が表題/TOCのOOXMLに置換。マーカー未検出時はトークン除去のフェイルソフト（表題マーカー無し運用が可能）

### 検証環境
- scratchpad `/tmp/claude-0/-home-user-CheckListMaker/*/scratchpad/docx-verify/` に html-to-docx+jszip+xmlbuilder2+playwright-core 導入済み、verify.js（docx検査33項目）と ui-test.js（Playwright実UIテスト）あり。Chromium: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
- プロジェクトの node_modules は `npm install --ignore-scripts` で作る（electronのバイナリDLがプロキシ403のため）。**package-lock.json はコミットしない方針（生成されたら削除）**

## 実装内容

### 1. データモデル＋表紙エディタ（index.html）
- `createCoverPage()` に `includeToc: true` を追加。読み出しは `cover.includeToc !== false`（既存データ＝フィールド無しはON扱い。方針が目次追加なのでONが自然な既定）
- `openCoverDialog` の `.ce-enable` ブロックに「目次を含める」トグルを追加: `data-ce="toc-toggle"` → `draft.includeToc = !(draft.includeToc !== false)` 形式でトグル → `persist(); refresh();`。`refresh()` に ON表示反映を追加。説明文は「印刷/PDFに目次ページ、Word出力に目次（Wordで開いてフィールド更新）を入れます」程度

### 2. 表紙の画像化ユーティリティ（index.html、レンダラー内・新関数）
`rasterizeCoverToPng(cover, fallbackTitle)` → Promise<dataURL> を新設:
- SVG `foreignObject` 方式（依存追加なし・IPC不要）:
  1. `renderCoverHtml()` のHTMLと、アプリの `<style>` 全文（`document.querySelector('style').textContent`。自己クローン機能で実績のある取得方法）を `<svg width="794" height="1123"><foreignObject…><div xmlns="http://www.w3.org/1999/xhtml"><style>…</style>${coverHtml}</div></foreignObject></svg>` に包む
  2. `new Image()` に `data:image/svg+xml;charset=utf-8,` + encodeURIComponent で読み込み → canvas（**2倍の1588×2246px**、A4本文幅160mmで約250dpi相当）に白背景→drawImage → `toDataURL('image/png')`
  3. ロゴ（data URL）は foreignObject 内 `<img>` として同梱されるので追加処理不要。失敗時（onerror）は reject し、呼び出し側でエラー表示
- 注意: foreignObject 内で `color-mix()`/CSS変数は Chromium なら効くが、**実装後に必ず全10プリセット＋ロゴ入りで画素検証**（下記検証参照）。万一 foreignObject で描画が崩れるプリセットがあれば、代替案＝メインプロセスに隠し BrowserWindow（794×1123, show:false）→ `loadURL(dataURL)` → `capturePage()` のIPC（`cover:rasterize`）へ切替（プランB）

### 3. Word出力の組み替え（index.html renderDocxView / saveDocxViaElectron）
- `saveDocxViaElectron`: 表紙有効時は先に `await rasterizeCoverToPng(...)` し、`renderDocxView(checklist, { coverImage })` に渡す（renderDocxView は同期のまま）
- `renderDocxView` テンプレート型の構成変更:
  - **表紙有効**: `<p><img src="${coverImage}" width="605" height="856" /></p>`（605×856px ≒ 本文幅160mm・A4比率）→ 改ページ → `includeToc !== false` なら TOCマーカー段落＋改ページ → 本文。**様式風の簡易表紙（表題マーカー・メタ表・改訂履歴表）は廃止**。表題段落も出さない（表紙画像に表題が入っているため）
  - **表紙無効**: 表題マーカー段落（様式装飾は従来どおり後処理）→ 本文。**TOCは出さない**（目次は表紙機能のオプションのため）
  - ToDo型は従来どおり
- `meta` は従来形（`{isTemplate, markerTitle, markerToc}`）のまま。表紙有効時は markerTitle を空にし、includeToc OFF時は markerToc を空にする（postProcessDocx は空マーカーをスキップする実装済み → **docx-postprocess.js は変更不要**）

### 4. 印刷/PDFの目次ページ（index.html renderPrintView + CSS）
- `renderPrintView` 2623行付近、`${coverHtml}` の直後に目次を挿入: 表紙有効かつ `includeToc !== false` のとき `<div class="print-toc"><h2>目次</h2><ol>…</ol></div>`
  - 一覧の中身: セクション名（テンプレート型は ⏱分付き、renderPrintView 2576-2618行の既存列挙ロジックと同じ書式）と、その配下の手順名（連番 N. 付き、インデント）。ページ番号は出さない（HTML印刷の制約、ユーザー了承済み）
- 印刷CSS（985-990行付近）に `.print-toc { break-after: page; }` と一覧の体裁（見出し・インデント・行間）を追加。`@page coverpage` は使わず通常余白ページ

### 5. ブランチ・コミット
- 指定ブランチ `claude/word-export-image-editing-rastl3` は PR #24 でマージ済み → **最新 origin/main から同名で作り直す**（`git fetch origin main && git checkout -B claude/word-export-image-editing-rastl3 origin/main`）
- コミット分割目安: ①表紙画像化＋Word組み替え ②目次オプション（データモデル・エディタUI・印刷ビュー） 。push まで（PR作成はユーザー指示待ち＝運用ルール領域3）

## 検証（次セッションで実施）

1. **表紙画像化のPlaywright検証**（scratchpad/docx-verify に新スクリプト）: アプリを file:// で開き、テンプレート型作成→表紙エディタで各プリセットを選択→ページ内で `.cover-stage .cover` のouterHTMLとstyle全文を取得し、実装と同じ foreignObject→canvas 手順を page.evaluate で実行 → (a) 10プリセット全てで canvas が非空白（白一色でない）、(b) アクセント色のピクセルが存在、(c) ロゴ(data URL PNG)入りでも描画されること
2. **UIテスト**（ui-test.js 拡張）: 表紙エディタに「目次を含める」トグルが表示されON/OFFが persist されること。印刷プレビューで ON時に `.print-toc`（セクション名・手順名を含む）が表紙の直後に出ること、OFF時・表紙無効時に出ないこと
3. **docx検証**（verify.js 改修）: renderDocxView 相当HTMLを新構成で再現し、(a) 表紙有効: document.xml に画像（w:drawing）が先頭にあり、表題マーカー段落・簡易表紙の表が無いこと、改ページ→TOCフィールド→改ページの順、(b) includeToc OFF: TOCフィールドが無いこと、(c) 表紙無効: 様式表題段落あり・TOCなし、(d) ToDo型従来どおり、(e) 既存の様式チェック（Heading2/4・フッター・余白・フォント）全維持
4. 最終見た目（Word実機・印刷プレビュー）はサンプル docx をユーザーへ送付して確認依頼

## リスク・留意

- foreignObject 描画は同期完了しない場合がある（フォント読み込み等）→ img.onload 後に decode() を待ってから drawImage。色ズレ・崩れがあればプランB（BrowserWindow capturePage）へ
- 表紙画像埋め込みにより docx のファイルサイズが増える（PNG 1588×2246、フラット色主体なので数百KB見込み）
- Word上で表紙のテキスト編集ができなくなる点はユーザー了承済み
- 表紙無効時のWord出力からTOCが消えるのは仕様変更（目次は表紙機能のオプションに帰属、ユーザー選択済み）
