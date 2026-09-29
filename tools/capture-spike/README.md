# capture-spike — クリック直前キャプチャのスパイク（v1.0.8 作業2）

録画中に常駐させる撮影プロセス（`capture-host.js`）の方式を決めるための計測スクリプト。
GDI（`CreateDIBSection` + `BitBlt`）でカーソルのあるモニタを一定間隔で撮り続け、
1枚あたりの撮影時間と CPU 負荷を測る。**撮った画面はメモリ上に置くだけで、ファイルには保存しない。**

```bash
node tools/capture-spike/measure.js 8 100 150 200
```

- 引数：計測秒数（既定 8）、撮る間隔 ms（既定 100 150 200）。Windows 専用。
- 結果と決定（間隔 100ms など）は `docs/spec-preclick-capture.md` の「スパイクの結果」に記録した。
