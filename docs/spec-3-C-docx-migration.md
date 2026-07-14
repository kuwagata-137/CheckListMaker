# 3-C. Word 出力の依存リスク調査（html-to-docx → docx 移行の得失）

ロードマップ `docs/品質向上ロードマップ.md`（3-C, L431-439）の**調査タスク**の成果物。
`html-to-docx` から `docx` パッケージへの移行の得失を1枚にまとめる。
**移行を実装するかはユーザーが本調査を見て判断する**（ロードマップ方針。本工程では実装しない）。

- 確定スコープ（2026-07-14・視覚モックで確認）: **調査のみ**。回帰基準は **OOXML 検査の自動テスト化**
  （`test/docx.test.js`）で先に用意済み。重視観点は **見た目の完全再現 / 保守性・負債解消 /
  リスク・互換性**。

## 現状の構成（3段）

`renderDocxView()`（`index.html`）が **HTML＋meta** を生成 → `main.js saveDocx()` が
`html-to-docx ^1.8.0` で docx 化 → `docx-postprocess.js`（242行）が生成後の OOXML を**文字列置換**で
書き換える。**最終的な見た目のほぼ全ては ③ の後処理ハックが作っている**のが要点。

- `html-to-docx` を直接 import するのは `main.js` の1経路のみ（`saveDocx` L1127/1147）。
- しかし後処理は「html-to-docx がこう出力する」前提に密結合：
  - `footer1.xml` の変則名前空間 → 丸ごと差し替え（`FOOTER_XML`）
  - 見出し pPr への直付け `<w:spacing w:lineRule="auto"/>` → 正規表現で除去
  - `settings.xml` の特定文字列 `<w:zoom w:percent="100"/>` の存在に依存して `updateFields` を挿入
  - font が ascii/hAnsi 中心 → `eastAsia`（游明朝）を後付け
  - pPr 子要素を**スキーマ順で手書き**（順序が崩れると Word が「修復」を要求）
- 現状、docx 出力の**自動テストもゴールデンも無かった** → 本工程で `test/docx.test.js` を新設し、
  後処理が担保する OOXML 骨格を回帰基準として固定した。

## 観点1: 見た目の完全再現 — 後処理ハック → `docx` API 対応表

`docx`（dolanmiu/docx）は宣言的 API で OOXML を組む。現状ハックはほぼ 1対1 で置き換え可能。

| 現状（後処理ハック） | `docx` パッケージでの表現 | 再現性 |
|---|---|---|
| Heading2/4 スタイル差し替え（アクセント色・下罫線・右タブ・eastAsia） | `Document.styles.paragraphStyles`（`run:{color,bold,size,font:{eastAsia}}` ＋ `paragraph:{border.bottom, tabStops:[{type:RIGHT}], spacing, outlineLevel}`） | ◎ 宣言的 |
| 表題段落（中央・20pt・下罫線） | `Paragraph({alignment:CENTER, border, children:[new TextRun({bold,size:40,font})]})` | ◎ |
| 目次（TOC 複合フィールド＋「目次」ラベル） | `new TableOfContents("目次",{hyperlink,headingStyleRange:"1-4"})` | ◎ ネイティブ |
| 開時のフィールド更新（settings の updateFields） | `Document({features:{updateFields:true}})` | ◎ 文字列依存が消える |
| 所要時間の右詰め（`@@DXTAB@@`→タブへ文字列分割） | 段落 `tabStops` ＋ `new TextRun({children:[new Tab(),"⏱5分"], color})` | ◎ ハック撤廃 |
| フッター PAGE/NUMPAGES（footer1.xml 丸ごと置換） | `Footer` ＋ `Paragraph({alignment:CENTER, children:[PageNumber.CURRENT," / ",PageNumber.TOTAL_PAGES]})` | ◎ |
| docDefaults の和文フォント游明朝（後付け） | `Document.styles.default.document.run.font:{eastAsia:"游明朝"}` | ◎ |
| 見出しへの直付け spacing 除去（正規表現） | 不要（余計な spacing を注入するライブラリが無い） | ◎ 問題自体が消える |

結論：現状の見た目要素は `docx` の標準機能で宣言的に再現でき、**後処理層（242行）を丸ごと撤廃できる**
見込み（ロードマップ L438 の想定と一致）。

## 観点2: 保守性・負債解消

- **後処理ハック 242 行を削除**できる。styles 差し替え／マーカー置換／footer 丸ごと置換／
  eastAsia 後付け／updateFields 挿入という「ライブラリ出力癖への密結合」が消える。
- 依存が**活発にメンテされる `docx`** に一本化。`html-to-docx`（^1.8.0・停滞気味）と、その出力に
  依存する脆い正規表現群を手放せる。
- pPr のスキーマ順手書き（順序ミスで Word 修復要求）という**壊れやすさが構造的に解消**する
  （`docx` が要素順を内部で保証）。
- 生成ロジックが「HTML 文字列＋マーカー＋OOXML 文字列置換」から「型のあるドキュメントモデル構築」に
  変わり、読みやすさ・変更容易性が上がる。

## 観点3: リスク・互換性

- **Word「修復要求」の回避**: 現状はハックの順序依存で潜在リスク。`docx` は OOXML 構造を組み立てる
  ため native に回避できる（最大の安定化ポイント）。
- **和文フォント埋め込み**: `docx`・`html-to-docx` とも游明朝の**フォント埋め込みはしない**
  （Windows のシステムフォント前提）。この点は現状と同じで**新たなリスクは増えない**。
- **既存仕様との整合**: `docs/spec-word-cover-image-toc.md`（表紙画像・目次トグル・フェイルソフト）は
  現行のマーカー＋後処理フロー前提。移行時はフローを作り直すが、**ユーザーに見える挙動
  （表紙画像・目次の有無・失敗時の中止）は維持**する必要がある。回帰は `test/docx.test.js` で担保。
- **移行の主コスト＝リッチ本文 HTML の変換**: 手順の本文（`it.body`）は現在 `sanitizeBodyHtml` を通した
  **任意の HTML** を html-to-docx がそのまま docx 化している。`docx` へ移行するとこの本文 HTML を
  docx モデル（太字・斜体・箇条書き等の run/段落）へ**自前で変換**する必要があり、ここが移行の
  最大の作業量・リスク。**表紙画像・本文画像**は `ImageRun` で埋め込み可能だが、html-to-docx が
  自動でやっていた「原寸を読みページ幅に自動縮小」を**明示的な寸法計算**に置き換える必要がある
  （3-B の `materializeChecklist` が原寸 dataURL を渡す入口は共通で使える）。

## 移行の作業範囲（実装する場合の見取り図・工数は概算）

- `index.html` `renderDocxView`：HTML 生成 → **構造化ペイロード**（章・手順・本文・画像・所要時間・
  表紙情報）へ。あるいは docx モデル構築をどこで行うかの設計判断。
- `main.js` `saveDocx`：`html-to-docx` → `docx` の `Document`/`Packer.toBuffer` に置換。
- `docx-postprocess.js`：**削除**（機能は `docx` の宣言的 API に吸収）。
- 追加実装：リッチ本文 HTML → docx run 変換、画像寸法計算、表紙画像の `ImageRun` 埋め込み。
- 規模感：見出し・目次・フッター・フォント・右詰めは低リスクで移植可。**本文 HTML 変換が中〜大**。
  回帰は本調査で用意した `test/docx.test.js` の観点を `docx` 出力にも適用して担保する。

## 判断（推奨）

技術的負債（242行の後処理ハック・停滞ライブラリへの密結合・Word 修復要求リスク）の解消効果は大きく、
見た目・目次・フッター・フォント・右詰めは低リスクで再現できる。一方、**リッチ本文 HTML の変換**が
移行の主コスト。総合的には**移行の価値は高い**が、本文変換の工数を許容できるタイミングで着手するのが妥当。

**実装可否・着手時期はユーザーが判断する**（本工程は調査まで）。着手する場合は、本調査の
`test/docx.test.js` をゴールデンとして、移行後の docx 出力が同じ OOXML 骨格を満たすことを確認しながら
段階移行するのが安全。
