# CheckListMaker `.exe`（インストーラ）作成ガイド

CheckListMaker の **Windows 用インストーラ（`.exe`）を作る側**のための手順書です。
できあがった `.exe` を**配る・使う**側の手順は
[使い始めガイド（Windows）](インストールと使い方ガイド.md) を見てください。

---

## まずはどっちで作る？（2つの方法）

`.exe` を作る方法は 2 つあります。**急ぎでなければ「方法A（クラウド）」がおすすめ**です。

| | 方法A：クラウドで作る | 方法B：自分のPCで作る |
|---|---|---|
| 場所 | GitHub のサーバー上 | 自分の **Windows** PC |
| 必要なもの | GitHub アカウントだけ | Node.js・Windows 環境 |
| 開発ツールの準備 | **不要** | 必要（`npm install` など） |
| 向いている人 | とにかく `.exe` が欲しい人 | 手元で何度も作り直したい人 |
| かかる時間 | 数分（待つだけ） | 初回は環境準備込みで長め |

> 💡 **迷ったら方法A。** ボタンを押して数分待つだけで `.exe` ができ、
> ダウンロードできます。PC に何もインストールする必要がありません。

---

## 方法A：GitHub Actions でクラウドビルド（おすすめ）

PC に開発環境を作らず、**GitHub のサーバー上で `.exe` を組み立てて**もらう方法です。

### 手順

1. ブラウザで GitHub のリポジトリを開く。
2. 上部のタブから **「Actions」** を開く。
3. 左の一覧から **「Build Windows installer」** を選ぶ。
4. 右側の **「Run workflow ▾」** ボタンを押す → ブランチを選んで
   **緑の「Run workflow」** を押す。
5. ビルドが始まる（数分）。一覧の一番上の実行が **緑のチェック ✅** になれば成功。
6. その実行ページを開き、一番下の **「Artifacts」** にある
   **`CheckListMaker-Windows-installer`** をクリック → zip がダウンロードされる。
7. zip を解凍すると **`CheckListMaker Setup 1.0.0.exe`** が入っている。これが完成品。

> 📝 各実行ページ上部の **「Summary」** にも、その回のダウンロードリンクが自動表示されます。
>
> ⚠ Artifact（成果物）は **約90日で期限切れ**。切れていたら、上の手順で
> もう一度 **Run workflow** すれば新しい `.exe` が作られます。

### この方法のしくみ（参考）

ビルドの中身は `.github/workflows/build-windows.yml` に書かれています。GitHub が
Windows マシンを用意し、`npm install` → `npm run dist` を実行して `.exe` を作り、
成果物としてアップロードしてくれます。**署名証明書は使っていない**ので、できる `.exe`
は未署名です（→ 後述の「SmartScreen の警告」）。

---

## 方法B：自分の Windows PC でビルド

手元で何度も作り直したいときはこちら。**Windows 上で**実行してください
（録画用のネイティブモジュールを含むため、Windows 版は Windows で作るのが確実です）。

### 事前準備

- **Node.js**（LTS / 20 系を推奨）をインストール。
- このリポジトリを手元に取得（`git clone` など）。

### 手順

```bash
npm install      # 依存（electron / electron-builder など）を取得
npm run dist     # dist/ に CheckListMaker のインストーラ(.exe)を生成
```

- 出力先は **`dist/`**。例：`dist/CheckListMaker Setup 1.0.0.exe`。
- うまくいかないときは、先に次を実行してから `npm run dist` を試す：

```bash
npm run rebuild  # ネイティブモジュール(uiohook-napi)を Electron 用に再ビルド
```

> ⚠ 環境によっては **Visual Studio Build Tools** や **Python** が必要になることが
> あります。その場合は `npm run rebuild` がエラーメッセージで案内します。

---

## できあがるもの

どちらの方法でも、できる `.exe` は同じ仕様です。

- ファイル名：**`CheckListMaker Setup <バージョン>.exe`**（例：`... 1.0.0.exe`）。
- 種類：**ワンクリックのインストーラ（NSIS）**。実行するとインストールされ、
  デスクトップとスタートメニューにショートカットが作られます。
- 権限：**管理者不要**（現在のユーザー向けにインストール）。
- 導入先：`%LOCALAPPDATA%\Programs\CheckListMaker\`。

バージョン番号は `package.json` の `"version"` を変えると上がります。

---

## 仕上げ：アイコンと署名（任意）

- **独自アイコンを付けたい** → `build/icon.ico`（256×256 以上）を置けば自動採用。
  未配置だと既定の Electron アイコンになります。
- **SmartScreen の警告を消したい** → コード署名証明書が必要です。証明書を用意して
  `package.json` の `build` 設定に署名情報を足します（有料の証明書が必要）。
  未署名のままでも動作はします（初回に「詳細情報 → 実行」で起動可能）。

---

## 困ったとき

- **Actions に「Build Windows installer」が出ない** → リポジトリの `.github/workflows/`
  にワークフローがあるか確認。なければこのブランチをマージ／push してください。
- **`npm run dist` が失敗する** → まず `npm run rebuild` を実行。それでも失敗する場合は
  Build Tools / Python の導入が必要なことがあります（方法A なら準備不要なので、
  急ぎは方法A を使ってください）。
- **mac / Linux 版が欲しい** → それぞれの OS 上で
  `npx electron-builder --mac` / `--linux` を実行します（`build` 設定は流用可）。

---

## まとめ（最短ルート）

```
方法A：GitHub →「Actions」→「Build Windows installer」→「Run workflow」
       → ✅ になったら Artifacts から zip を取得 → 解凍 → .exe 完成
```

詳しい配布・インストール手順は
[使い始めガイド（Windows）](インストールと使い方ガイド.md) を参照してください。
