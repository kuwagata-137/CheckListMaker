# チェックリストメーカー

チェックリストを**簡単に作れる**、依存ゼロ・ビルド不要の HTML アプリです。ブラウザだけで
動作し、データは端末内（localStorage）に保存されます。

## 特長

- **2つのモードを入口で選択**
  - **テンプレート型** — 点検表・持ち物・手順など、繰り返し使うリスト。チェック後に
    **一括リセット**して再利用できます。
  - **ToDo型** — その都度追加して消化する使い捨てのリスト。
- **セクション分け** — 見出しで項目をグループ化できます。
- **進捗表示** — 全体／セクション別に完了数とパーセンテージを表示。
- **ドラッグ&ドロップ** — 項目もセクションも並べ替え可能（セクション間の移動も対応）。
- **自動保存 & Undo/Redo** — 変更は自動保存。直近50操作まで元に戻せます。
- **JSON エクスポート/インポート** — バックアップや別端末への移行に。
- **URLリンク共有** — チェックリストをリンクに埋め込んで共有（サーバー不要）。
- **ダーク/ライトテーマ** — OS設定に追従、または手動切替（🌓ボタン）。
- **レスポンシブ & 印刷対応**。

## 使い方

ES Modules を使用しているため、ローカルの簡易サーバー経由で開いてください。

```sh
cd CheckListMaker
python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

GitHub Pages などの静的ホスティングにそのまま置いても動作します。

## 構成

```
index.html        画面骨格とトップバー
css/styles.css    テーマ変数・レイアウト・ダーク/印刷対応
js/model.js       データモデルと純粋な操作関数
js/storage.js     永続化の抽象化(StorageAdapter)＋Undo/Redoストア
js/render.js      画面の描画
js/dragdrop.js    ドラッグ&ドロップ並べ替え
js/io.js          JSON入出力・URL共有のエンコード/デコード
js/router.js      ハッシュベースのルーティング
js/app.js         エントリポイント（結線）
```

`storage.js` の `StorageAdapter` は「アプリ全体の状態を読み書きする」薄いインターフェースです。
今回は `LocalStorageAdapter` のみ実装していますが、同じIFを満たすリモートアダプタ（サーバー
同期）に差し替えれば、将来グループウェア等での共用にも拡張できます。

## 着想元・クレジット

設計やUXの参考にした優れた先行プロジェクト（コードは引用せず新規実装しています）:

- [Nullboard](https://github.com/apankrat/nullboard) — 単一HTMLファイル・localStorage・
  JSON入出力・Undo/Redo・完全オフラインという構成の手本。
- [Checklist-Tools-Website](https://github.com/AlexisDanizan/Checklist-Tools-Website) —
  チェックリストをデータとして定義する発想。
- [Vikunja](https://vikunja.io/) — 進捗表示やテンプレート再利用といった機能発想。

## ライセンス

MIT License（[LICENSE](LICENSE) を参照）。
