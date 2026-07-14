# 3-B 画像画質の向上 — 確定仕様

ロードマップ `docs/品質向上ロードマップ.md`（3-B, L405-412）に対応する確定仕様。
着手前にユーザーと確定（2026-07-14。後半は視覚モックで比較して決定）。実装はこの仕様に従う。

## 背景・目的

現在の画像パイプラインは取り込み時に**長辺1600px・JPEG q0.85 へ不可逆圧縮した1枚だけ**を保持する
（`index.html` の `IMG_MAX_EDGE`/`IMG_QUALITY`/`compressImage`）。容量対策として導入された仕様だが、
細かい文字のスクリーンショットが**印刷・Word・PDF で潰れる**。

本仕様では**原寸の元画像**と**表示用サムネイル**を別々に持つ 2 段構成へ移行する。
画面表示・編集はサムネイル、出力（印刷/Word/PDF/Excel/単体HTML）は原寸を使う。
前提の 1-1（localStorage → ファイル保存への移行）は完了済み。

## 決定事項

| # | 論点 | 決定 |
|---|------|------|
| 1 | 原寸の符号化形式 | **入力フォーマット維持**（PNG→PNG / JPEG→JPEG） |
| 2 | 原寸の解像度上限 | **長辺 2560px**（超過分のみ縮小・再符号化） |
| 3 | 原寸を使う出力 | **全出力で原寸**（印刷 / Word / PDF / Excel / 単体HTML） |
| 4 | JSON エクスポート | **原寸を含める（無損失バックアップ）** |
| A | 録画スクショ | **原寸PNGで2段構成**（他画像と一貫） |
| B | 画像エディタ | **原寸で編集・出力も原寸**（注釈も鮮明） |
| C | 既存データ画像 | **マイグレーションなし**（2段構成は新規追加から適用） |
| D | 非対応形式(webp/gif等) | **JPEG q0.92 に再符号化** |

補足：
- 原寸が上限 2560px 以内かつ PNG/JPEG なら、**元 dataURL を無変換で保存**（真の無損失）。
  超過時のみ形式を保ったまま縮小＋再符号化（PNG は可逆 PNG／JPEG は q0.92）。
  PNG/JPEG 以外（webp・gif 等）は大きさに関わらず **JPEG q0.92** に再符号化する。
- 表示用サムネは現状（長辺 1600px / JPEG 0.85）を「表示用設定」として据え置き。
- 2 段構成は **ファイル保存モード（Electron）でのみ**適用する。ブラウザ単体モードは
  state を localStorage に持つため原寸をインラインで抱えると容量が破綻する。従来どおり
  サムネ 1 枚のみ（`imagesFull` は付けない）＝**無改修互換**。
- 画像エディタで注釈を焼き込んだ合成は、原寸で **JPEG q0.92** として保存する
  （注釈付き合成に可逆は不要。原寸 PNG スクショも編集後は JPEG 合成になる）。

## データモデル

`item.imagesFull[]` を新設。既存 `item.imageEdits[]` と同じく **`item.images[]` と index を
揃えた並行配列**。各要素は原寸画像の参照（`img:<uuid>.<ext>`）、原寸を持たない場合は `null`。

- `item.images[]` … 表示用サムネ（現状のまま。表示・編集・render・共有は無改修）。
- `item.imagesFull[]` … 原寸（出力・JSON バックアップ用）。`null` 可。
- `item.imageEdits[]` … 再編集ソース `{v:1, base, strokes, objects}`。`base` は**原寸**を保持。

後方互換：既存データは `images[]` のみで `imagesFull` 不在。出力は `imagesFull[i] || images[i]` と
フォールバックするため、既存画像は従来どおりサムネが使われる。マイグレーションは行わない。

## 出力ルーティング（単一チョークポイント）

- `materializeChecklist(checklist)` … 印刷 / PDF / Word / Excel / 単体HTML が通る。
  出力用 clone に対し **`images[i] = imagesFull[i] || images[i]` を適用して `imagesFull` を落として**
  から参照を dataURL へ解決する。下流の出力コードは無改修で原寸を受け取る。
- `materializeState(state)` … JSON エクスポートが通る。**差し替えず** `images` と `imagesFull`
  の双方を dataURL 解決して保持する（無損失バックアップ）。
- 画面表示・編集は materialize を通らないため常にサムネ。

## 取り込み・保存

- 新規画像（貼り付け / ドロップ / ファイル選択）: 原寸（形式維持・2560px・webp 等は JPEG）と
  サムネ（1600px/0.85）の 2 枚を保存し、`images[i]`＝サムネ参照・`imagesFull[i]`＝原寸参照。
- 録画取り込み: 各スクショの原寸 PNG を読み直し、同じ 2 段構成で保存。
- 画像エディタ保存: 原寸で編集し、原寸合成（JPEG q0.92）→ `imagesFull`、その縮小 → `images`、
  再編集ソース `imageEdits.base` は原寸を保持。

## GC・保存基盤

- `mapChecklistImages` の走査対象に `imagesFull[]` を追加する（`storeImage`/`resolveImage`/
  インポート吸収がまとめて対応）。
- 起動時の孤児画像 GC（`storage.js`）は state JSON 内の全 `img:` 参照を走査するため、
  `imagesFull` 参照も state に載れば自動的に保護される。**`storage.js` は無改修**
  （原寸は全て png/jpeg に正規化されるため既存の `image:save` 制約に収まる）。

## テスト

`test/imagequality.test.js` を追加（canvas 非依存の範囲）。
- 原寸の形式決定（純関数）: PNG/JPEG は上限内で無変換、超過時は形式維持で再符号化、
  webp/gif は JPEG。
- モデル: `addItemImage` が原寸参照を受けて `imagesFull` を揃える／replace・remove で整合維持。
- `materializeChecklist` が出力で `imagesFull` 優先・無ければ `images` にフォールバック。
- `materializeState` が `images` と `imagesFull` の双方を保持（JSON 無損失）。
- インポート吸収（`absorbChecklistImages`）で `imagesFull` も参照化され、GC が両参照を残す。
- レガシー（`imagesFull` 不在）が従来どおり出力される。

canvas を要する部分（`makeFullImage`/`compressImage`/エディタ合成の実描画、実画質・容量）は
jsdom で実行できないため、**Windows 実機検証**（全開発完了後にまとめて実施の方針）で確認する。
