# 2-R2 UI要素解決＋テンプレート文生成 — 確定仕様

ロードマップ **2-R2（フェーズ2の本丸）** の実装方針。クリック座標から UIA
（Windows UI Automation）で UI 要素を解決し、「『保存』ボタンをクリック」のような
手順文をテンプレート文法で**決定的に生成**（AI不要・オフライン・幻覚なし）して、
2-R1 のサイドカー JSON に記録する。前提は 2-R0 スパイクの実測
（`docs/spike-2-R0-results.md`。判定 go・koffi＋UIA の本番経路は実機で成立済み）。

## アーキテクチャ（プロセス分離）

```
main.js ──(mousedown で並行キック)──► uia.js（親側ラッパ）
                                        │ postMessage {id,x,y}
                                        ▼
                                 uia-host.js（utilityProcess・Windows のみ）
                                   koffi FFI → UIA ElementFromPoint → 要素情報
                                        │ 返信 {id, name, controlType, rect, ...}
                                        ▼
persistShot ──► steptext.js（純関数）で手順文を生成 ──► session.js がサイドカーへ記録
```

- **UIA 呼び出しは Electron の `utilityProcess`（子プロセス）で実行する。**
  理由は2つ（ロードマップの技術リスク「koffi（FFI）の安定性」への回答）:
  1. **クラッシュ隔離** — FFI/COM のクラッシュが録画中のアプリ本体を巻き込まない。
     子プロセスが死んでも録画は継続し、以降の手順文はフォールバックになるだけ。
  2. **非ブロッキング** — 解決は実測 5〜281ms の同期 FFI 呼び出し。メインプロセスの
     イベントループ（uiohook・IPC・撮影制御）を止めない。
- 子プロセスは**録画開始（`rec:begin`）で起動し、録画停止で終了**する。待機中は存在しない。
- 録画中に子プロセスが死んだ場合は**セッション内では再起動しない**（ログのみ。
  次回の録画開始で再起動）。録画自体は止めない。
- **Windows 以外では uia.js は何もしない**（解決結果 null → 全クリックがフォールバック文）。
  開発環境（Linux）でも録画機能そのものは従来どおり動く。

## 解決のタイミングと合流

- **mousedown の瞬間**（撮影開始と同じガード通過後）に**撮影と並行して**解決を
  非同期キックする。クリックで消える UI（メニュー等）も消える前に解決できる。
- `persistShot`（保存確定後・直列キュー内）で解決結果を待ち合わせる。
  **タイムアウトは 2000ms（初期値）**。タイムアウト・失敗・子プロセス不在は
  すべて「解決なし」として扱い、**必ずフォールバック文で続行**する（前提10）。

## テンプレート文法（steptext.js・純関数）

要素名 `name` は正規化（改行・連続空白を1つに・トリム・40字超は「…」省略）してから使う。
右クリックは種類を問わず **「◯◯」を右クリック**（フォールバック時は下記の右クリック版）。

| ControlType | 生成される文（左クリック） |
| --- | --- |
| Button / SplitButton | 「**◯◯**」ボタンをクリック |
| TabItem | 「**◯◯**」タブを選択 |
| MenuItem | メニューから「**◯◯**」を選択 |
| CheckBox | 「**◯◯**」にチェック |
| RadioButton / ListItem / TreeItem | 「**◯◯**」を選択 |
| ComboBox | 「**◯◯**」を開く |
| Edit | 「**◯◯**」欄をクリック（※入力検出は R2b で「に入力」へ昇格） |
| Hyperlink | リンク「**◯◯**」をクリック |
| DataItem（Excel のセル番地） | セル「**B5**」をクリック（`appName` が Excel かつ名前がセル番地形式のとき） |
| DataItem（上記以外） | 「**◯◯**」を選択 |
| その他の種類で名前あり（Text / Image / Group / Custom 等） | 「**◯◯**」をクリック |
| **フォールバック** | ウィンドウ「**◯◯**」内の図の位置をクリック（タイトルも無ければ「図の位置をクリック」） |

- **フォールバックになる条件**: 要素が解決できない／名前が空／種類がコンテナ系
  （**Window / Pane / Document / TitleBar**。RemoteApp 業務システムは実測でここに
  落ちる＝主系統の一つ。2-R0 発見①）。
- 「図の位置」は撮影画像のクリックマーカーを指す（画像とセットで読む前提の文言）。
- 文体は**体言止め**（ロードマップの例文どおり）。文面の微調整は steptext.js の
  テーブル1箇所＋テストの修正で済む。

## サイドカーへの記録（スキーマ v2）

2-R1 の NNN.json に次を追加・変更する（`version: 2`）:

```json
{
  "version": 2,
  "text": "「保存」ボタンをクリック",
  "uia": {
    "resolved": true,
    "name": "保存",
    "controlType": "Button",
    "localizedType": "ボタン",
    "className": "NetUIRibbonButton",
    "frameworkId": "Win32",
    "rect": [1180, 640, 96, 32],
    "windowTitle": "文書 1 - Word",
    "appName": "WINWORD.EXE",
    "elapsedMs": 24
  }
}
```

- `text`: 生成された手順文（トップレベル）。R4 の取り込みウィザードはこれを項目文の
  初期値に使う。`uia` の生データも保存するため、**文生成ロジックを改良したら過去の
  録画からも再生成できる**（2-R1 の狙いどおり）。
- `uia.controlType` は**名前文字列**（"Button" 等。2-R1 spec では null プレースホルダー
  だった欄の型をここで確定）。`rect` は **[left, top, width, height] の物理px・
  スクリーン座標**（R3 の切り出しはこれと display 情報から画像内座標へ変換する）。
- `localizedType` / `className` / `frameworkId` / `elapsedMs` は R4 のヒューリスティクスと
  デバッグ用に軽量なので保存しておく（2-R0 計測ツールと同じ項目）。
- 解決なしの場合は従来どおり `resolved: false`・各項目 null で、`text` はフォールバック文。

## 依存とパッケージング

- **koffi を本体の dependencies に追加**（ロードマップ確定済みの手段。プリビルト
  バイナリでコンパイラ不要）。ネイティブモジュールのため `build.asarUnpack` に追加。
- `build.files` に `session.js` / `uia.js` / `uia-host.js` / `steptext.js` を追加。
  （**2-R1 の抜けの修正を含む**: `session.js` が files に無く、パッケージ版で
  起動に失敗する状態だった。）

## 検証計画

- **単体テスト（このセッションで実施）**: steptext.js の文生成（全種類・フォールバック・
  右クリック・Excel セル・名前の正規化）、session.js のサイドカー v2（uia/text の記録）。
  uia.js / uia-host.js の FFI 部分は Windows 専用のため単体テスト対象外。
- **実機検証（ユーザーの Windows 実機）**: 録画して Word/Excel/エクスプローラー/
  RemoteApp を数クリック → セッションフォルダの NNN.json の `text` と `uia` を確認。
  あわせて 2-R0 で持ち越した **Chrome ページ内コンテンツの解決品質**を再確認する
  （スパイク発見④）。手順は実装完了時に報告する。

## R2 に含めないもの（スコープ境界）

- キーボード・ドラッグ・アプリ切替・**ダブルクリック文**（→ R2b。必須要件として確定済み）
- 要素矩形での自動ズーム・枠ハイライト（→ R3。今回は rect を記録するまで）
- 取り込みウィザードでの文の編集 UI（→ R4）
- Chrome の `--force-renderer-accessibility` 等のブリッジ調整（実機再計測の結果を見て判断）
