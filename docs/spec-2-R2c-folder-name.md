# 2-R2c 「今どのフォルダ／項目を選択したか」を正しく読む — 確定仕様

エクスプローラー等で、クリック／ダブルクリックした**フォルダ（項目）の名前**を手順文へ
正しく出す。現状は要素名が **「名前」**（列見出し）になってしまう不具合の解消を含む。
UIA ベースで解決し、**OCR は使わない**。

## 背景・原因

- 現状の要素解決 `resolveAt` は `ElementFromPoint` が返す**最深の要素をそのまま読む**
  だけで、親をたどっていない（`uia-host.js:292` → `resolveWith` の
  `rec.name = elementProp(el, PROP.Name)`）。
- エクスプローラー「詳細」表示では、フォルダ行の実体は **`ListItem`（Name＝フォルダ
  表示名）** だが、`ElementFromPoint` はその中の**より深い子（列セル側）**を返しがちで、
  そこの Name が列見出しの **「名前」** になる。→ 文が「『名前』をダブルクリック」になる。
- 目的は「**今どのフォルダを選択／オープンしたか**」の名前を出すこと。**フルパスは不要**。

## ユーザー確定事項（2026-07-16）

1. **方式A＋B を併用する。**
   - **方式A**: クリック要素から**意味のある項目要素へ親をたどり（UIA TreeWalker）**、
     その Name／rect を採用する。
   - **方式B**: ダブルクリック等で**入った先（現在フォルダ）の末端名**を UIA で読む。
2. **フルパスは不要。** フォルダ名（末端の表示名）だけでよい。
3. 最重要は「**今どのフォルダを選択したか**」を知ること。
   → **A を主系統**、**B は補完・確認／フォールバック**に位置づける。

## 方式A: 項目要素まで親をたどる（主系統）

`uia-host.js` の解決を「`ElementFromPoint` → **意味のある項目まで
`ControlViewWalker` で親へ登る**」へ拡張する。

- **登る条件**: 最深要素の Name が空、または controlType がコンテナ／列見出し相当で
  「項目名として使えない」とき。既に有効な名前が取れている既存ケースは**登らず挙動不変**。
- **採用（登り停止）する controlType**: `ListItem` / `TreeItem` / `DataItem` /
  `MenuItem` / `Button` / `CheckBox` / `RadioButton` / `TabItem` / `Hyperlink` /
  `ComboBox` / `Edit`（＝ `steptext.stepText` がテンプレートを持つ種類）。
  到達したらその要素の `Name` / `BoundingRectangle` / `ControlType` を採用。
- **打ち切り**: `CONTAINER_TYPES`（`Window` / `Pane` / `Document` / `TitleBar`）に
  達したら登り終了 → 従来どおりフォールバック文。登り回数上限（例 8）で保険。
- 採用要素の **rect も更新**する（枠ハイライト・拡大が項目にフィットする）。

補足（実装メモ・実機で確定）: `IUIAutomation::get_ControlViewWalker`（vtable 14 想定）で
Walker を1つ取得し、`IUIAutomationTreeWalker::GetParentElement`（vtable 3 想定）で登る。
**vtable インデックスは実機ダンプで確定**してから実装する（下記・検証計画）。

## 方式B: 入った先のフォルダ名（補完・確認／フォールバック）

- **対象を限定**: エクスプローラー（`appName` が `explorer.exe` 相当）で、かつ
  **「開く」操作（ダブルクリック／Enter）**のときだけ読む。
- **取得**: 現在フォルダの**末端名のみ**を UIA で取得する。候補は
  ①アドレスバー（ブレッドクラム）の最後のセグメント、②Shell COM
  （`Shell.Application` の現在フォルダ表示名）。**フルパスは使わない。**
- **用途**:
  - (i) A が項目を取れない環境（RemoteApp・独自描画ファイラー）での**フォールバック**。
  - (ii) ダブルクリックで開いた**確認**（A の item 名と B の現在フォルダ名が一致すれば
    信頼度が上がる。食い違えば A を優先）。
- **タイミング**: ナビゲーション完了後に読む必要がある。ダブルクリック昇格
  `maybeAmendDblClick`（`main.js:1066`）は既に `persistChain` 上で直前ステップを
  **事後修正**する仕組みなので、そこに B の読み取りを差し込むのが自然。

## 文生成（steptext.js）への影響

- **原則、変更なし。** A で `ListItem`/`TreeItem` の Name が正しく取れれば、既存の
  `dblClickText` が「**「◯◯」をダブルクリック**」、`stepText` が「**「◯◯」を選択**」を出す。
- （任意・将来）フォルダと判別できる場合に「**「◯◯」フォルダを開く**」にする案は
  今回スコープ外。**名前が正しく出れば目的達成**。

## 実装配置

- **`uia-host.js`**: `ControlViewWalker` 取得と `GetParentElement` を追加し、
  `resolveWith`/`resolveAt` に登り処理。B 用のアドレスバー／Shell 取得関数。
- **`main.js`**: B の読み取りをダブルクリック昇格／入場時に差し込み、A が弱いときだけ
  `text`/`uia` を補完（A 優先）。
- **`steptext.js`**: 変更なし（必要になれば任意拡張）。

## 検証計画

- **実機（Windows）必須。** 本開発環境（Linux）では UIA COM を実行・検証できない
  （正直な制約）。以下はユーザーの Windows 実機で行う。
- **事前ダンプ（実装前・2-R0 スパイクと同じ先行方式）**: 1クリック分で
  「最深要素の `controlType`/`className`/`name`」「親チェーン」「アドレスバー要素の
  構造」を出すダンプを取り、**A の停止条件と B の取得経路・vtable を確定してから実装**する。
  - ツール: `tools/uia-spike/dump-element.js`（`npm run dump` / `npm run selftest:dump`）。
    クリック先の最深要素から `ControlViewWalker` で親チェーンを上へたどって記録する。
    手順は `tools/uia-spike/README.md` の「2-R2c ダンプ手順」①〜④。
  - このダンプで確定する事項: (a) 詳細ビューで「名前」を出している最深要素の実体、
    (b) フォルダ表示名を持つ `ListItem` が親チェーンの何段目か（＝A の登り停止先）、
    (c) アドレスバー（ブレッドクラム）の要素構造（＝B の読み取り経路）、
    (d) `get_ControlViewWalker`（vtable 14 想定）/`GetParentElement`（vtable 3 想定）が
    実機で通るか。
- **実装後**: 詳細／中アイコン／大アイコン各ビューでフォルダをダブルクリック →
  `NNN.json` の `uia.name` がフォルダ名、`text` が「『◯◯』をダブルクリック」。
  左ナビゲーションツリーの `TreeItem` でも同様。RemoteApp では B かフォールバックに倒れる。

## スコープ外

- フルパスの記録（不要と確定）。
- フォルダ専用の文言（「◯◯フォルダを開く」等）——名前が正しく出れば目的達成。
- A で複数候補が一致する場合の高度な優先度制御（停止条件で足りる想定）。
