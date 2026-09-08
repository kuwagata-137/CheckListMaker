# 仕様: 画像の一括インポート（フォルダから選択）と取込導線の2択化

ユーザー要望（2026-09-08）を受けて、実装前に確定した仕様。モック（取込2択モーダル・
files モードウィザード・トップバーラベル）でユーザーと合意済み。

- 要望1: ダイアログで複数選択した画像を一括インポートし、**1枚＝1手順**として挿入したい。
  録画取込ウィザードのレイアウト流用・拡張でよい。
- 要望2: 取込導線で「キャプチャを取込む」（従来の録画セッション取込）か
  「フォルダから選択」（ネイティブダイアログ・複数選択可）を選べるようにする。
- 要望3: トップバーのアイコンが小さく機能説明がないため、全ボタンに文字ラベルを付ける。
- 要望4: ホバーの「＋ ここに追加」を、手順間は「ここに手順を追加」、項目間は
  「ここに項目を追加」へ具体化する。

---

## 1. 導線（トップバー 📥）

- 📥 押下 → モーダル「画像を取り込む」を開く。上から:
  1. **「🖼 フォルダから画像を選択…」カード** — 押すとネイティブの「開く」ダイアログ
     （複数選択可）。キャンセルなら何も起きない。選択すると files モードのウィザードへ。
  2. 区切り見出し「**キャプチャを取込む**（録画セッション・新しい順）」
  3. 従来どおりのセッション一覧（名前・日時・枚数・未完了／取り込み済みバッジ）。
     選ぶと従来どおりセッションのウィザードへ。
- セッションが0件でも、フォルダ選択が使える環境ならモーダルは開く（フォルダ選択のみ表示）。
  recorderAPI も fileAPI.pickImages も無い環境（ブラウザ単体・単体HTML）では従来どおり
  📥 自体を非表示（`updateImportButton`）。**フォルダ選択は Electron 版限定。**
- 録画停止 → ウィザード自動オープン（2-R4）は従来どおり直行（2択モーダルは挟まない）。

## 2. 複数選択 IPC（main.js / preload.js）

セキュリティ姿勢は `rec:image`（`resolveSessionDirArg`＋ファイル名ホワイトリスト）と同じ
「レンダラーに任意パスを読ませない」を維持する。

| チャネル | 内容 |
| --- | --- |
| `image:pickFiles` | `dialog.showOpenDialog` を `properties:['openFile','multiSelections']` で開く。defaultPath はピクチャ\CheckListMaker（無ければ作成）。フィルタは png/jpg/jpeg/gif/bmp/webp（単一選択版と同一）。成功時は選択パスを main 側の**許可リスト（Set）へ登録**し、`{ files:[{ path, name }] }` を返す（**base64 は返さない** — 多数の大画像の一括転送を避ける）。キャンセルは `{ canceled:true }`。 |
| `image:readPicked` | 引数パスを `path.resolve` して**許可リストに含まれるときだけ** dataURL を返す。不許可・読込失敗は null（`rec:image` と同じ返し方）。 |

- 許可リストはウィンドウ生存中に累積（ダイアログで実際に選ばれたパスのみが載るため、
  レンダラー侵害時も任意ファイルは読めない）。
- mime 判定は既存 `pickImageFile` のマップを `imageMimeFromExt()` に関数抽出して共用。

## 3. ウィザードのソースアダプタ化

`openImportWizard(dir)` → `openImportWizard(source)` に抽象化する。リスト編集（並べ替え・
削除・統合・一括置換）・取り込み先パネル（新フェーズ追加／既存フェーズへ挿入・挿入位置
ピッカー）・取込実行（storeImagePair → buildImportItems → store.commit 1回=Undo 1回・
容量超過時の undo＋通知）は**セッション非依存のため無変更で共用**する。

| | `makeSessionSource(dir)`（従来） | `makeFilesSource(files)`（新規） |
| --- | --- | --- |
| ステップ生成 | `wizardStepsFrom(readSession結果)` | `wizardStepsFromFiles(files)` |
| 画像読取 | `recorderAPI.readImage(dir, file)` | `fileAPI.readPickedImage(path)` |
| ヘッダー | セッション名・日時・バッジ・📂フォルダを開く | 「選択した画像 N枚」（📂・バッジなし） |
| 既定セクション名 | `録画 yyyy/MM/dd HH:mm` | `画像 yyyy/MM/dd HH:mm`（現在時刻） |
| 画像切替セグメント | 拡大／全景／両方 | **非表示**（元画像1枚のため） |
| markImported | session.json へ記録 | no-op |

### files モードのステップモデル

- `wizardStepsFromFiles(files)`: `[{path, name}]` を **name の自然順**
  （`localeCompare(…, {numeric:true})`。img2 < img10）でソートし、
  1ファイル＝1ステップ `{ text:'', shots:[{ kind:'file', image:path, zoomImage:null, choice:'full' }] }`。
- 手順の文は空で取り込み、ウィザードの textarea でその場で入力できる。
- 並び順はウィザード内の ↑↓・削除・統合で調整できる（録画取込と同じ）。

## 4. トップバーの文字ラベル

- 4ボタン（undo / redo / record / import-rec）のアイコン下に小さいラベルを縦積み:
  「元に戻す」「やり直す」「キャプチャ撮影」「画像インポート」。
- CSS は `#topbar .icon` / `#topbar .tb-lb` に**限定**する（`.icon` は項目行の ↑↓⤒✕ 等と
  共有のため全体には触らない）。
- 録画中は `updateRecordButton` がラベルを「録画停止」へ切替（title と同期）。
- 📥 の title は「画像を取り込む（キャプチャ／フォルダから）」へ更新。
- `buildStandaloneHtml` の topbar 文字列リテラル（undo/redo のみ）にも同じ構造を同期。
- トップバー高さの変化は `syncTopbarHeight`（実測方式）が `--topbar-h` に反映するため
  `.editor-head` の sticky は自動追従する。

## 5. 「ここに追加」の文言

- `renderStep`: `＋ ここに追加` → `＋ ここに手順を追加`
- `renderItem`: `＋ ここに追加` → `＋ ここに項目を追加`
- title 属性（「この下に手順を追加」「この下に項目を追加」）は現状のまま。

## 6. テスト

- `test/imagefiles.test.js` 新規（jsdom ハーネス・node --test）:
  `naturalCompareFilenames` の自然順、`wizardStepsFromFiles` の変換（1ファイル1ステップ・
  text 空・choice 'full'・null/空入力で落ちない）、生成ステップが既存
  `buildImportItems` / `insertItemsAt` にそのまま通ること。
- 純関数は `window.__test__` へ公開（既存の流儀）。
