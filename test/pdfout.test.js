// PDF出力の倍率・用紙・向き（純関数＋設定保存）のテスト。
// 仕様は docs/spec-pdf-output-scale.md 参照。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, PX_PNG } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));

test('pdfout — 倍率・用紙・向き', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('clampPdfScale — 30〜200にクランプ・非数は既定100', () => {
    assert.equal(T.clampPdfScale(100), 100);
    assert.equal(T.clampPdfScale(70), 70);
    assert.equal(T.clampPdfScale(10), 30, '下限30');
    assert.equal(T.clampPdfScale(999), 200, '上限200');
    assert.equal(T.clampPdfScale('abc'), 100, '非数は既定');
    assert.equal(T.clampPdfScale(null), 100);
    assert.equal(T.clampPdfScale(72.6), 73, '整数に丸める');
  });

  await t.test('pdfPaperDims — mm実寸（B4/B5はJIS）・横は縦横を入れ替え', () => {
    assert.deepEqual(plain(T.pdfPaperDims('A4', 'portrait')), { w: 210, h: 297 });
    assert.deepEqual(plain(T.pdfPaperDims('A4', 'landscape')), { w: 297, h: 210 });
    assert.deepEqual(plain(T.pdfPaperDims('B4', 'portrait')), { w: 257, h: 364 }, 'JIS B4（ISOの250×353ではない）');
    assert.deepEqual(plain(T.pdfPaperDims('B5', 'portrait')), { w: 182, h: 257 }, 'JIS B5');
    assert.deepEqual(plain(T.pdfPaperDims('Letter', 'portrait')), { w: 215.9, h: 279.4 });
    assert.deepEqual(plain(T.pdfPaperDims('X9', 'portrait')), { w: 210, h: 297 }, '未知の用紙はA4');
  });

  await t.test('pdfPageStyleCss — @page と coverpage の両方に size を出す', () => {
    const css = T.pdfPageStyleCss('A3', 'landscape');
    assert.match(css, /@page \{ size: 420mm 297mm; \}/);
    assert.match(css, /@page coverpage \{ size: 420mm 297mm; \}/);
    assert.ok(!/margin/.test(css), 'margin は基本CSSに任せて上書きしない');
  });

  // 倍率は #print-root の zoom で掛ける（印刷・PDF 共通。v1.0.8）。v1.0.9 から画像の大きさは
  // ページを組むときに px で決めるので、zoom だけで文字と一緒に縮む（--print-img-scale は廃止）。
  await t.test('pdfPageStyleCss — 倍率を zoom として出す', () => {
    assert.ok(T.pdfPageStyleCss('A4', 'portrait', 0.7).includes('#print-root { zoom: 0.7; }'));
    for (const bad of [undefined, null, 0, -1, NaN, 'あ']) {
      assert.ok(T.pdfPageStyleCss('A4', 'portrait', bad).includes('#print-root { zoom: 1; }'),
        `不正な倍率(${String(bad)})は等倍に倒す`);
    }
  });

  await t.test('pdfOutSettings / setPdfOutSettings — 既定と保存（Undo履歴に積まない）', () => {
    assert.deepEqual(plain(T.pdfOutSettings()), { scale: 100, paper: 'A4', orient: 'portrait' }, '既定は100%・A4・縦');
    const before = T.store.canUndo();
    T.setPdfOutSettings({ scale: '65', paper: 'B4', orient: 'landscape' });
    assert.deepEqual(plain(T.pdfOutSettings()), { scale: 65, paper: 'B4', orient: 'landscape' });
    assert.equal(T.store.canUndo(), before, '出力設定は Undo 履歴に積まない');
    T.setPdfOutSettings({ scale: 5, paper: 'なにか', orient: 'ななめ' });
    assert.deepEqual(plain(T.pdfOutSettings()), { scale: 30, paper: 'A4', orient: 'portrait' }, '不正値は安全側に倒す');
  });
});
test('pdfout — 改ページ位置（純関数）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  // A4縦の本文高さ（297mm - 上下15mm）を px にしたもの。テストでは丸い 1000 を使う。
  const H = 1000;

  await t.test('切れない塊が無ければ、1ページ分の高さで等間隔に刻む', () => {
    assert.deepEqual(plain(T.paginateBreaks([], H, 3500, 0)), [1000, 2000, 3000]);
    assert.deepEqual(plain(T.paginateBreaks([], H, 900, 0)), [], '1ページに収まれば線は要らない');
  });

  await t.test('start から数え始める（表紙・目次の下端を起点にできる）', () => {
    assert.deepEqual(plain(T.paginateBreaks([], H, 2600, 500)), [1500, 2500]);
  });

  await t.test('境界にかかった塊は、その塊の先頭まで改ページを繰り上げる', () => {
    // 950〜1120 の手順カードが 1000 の境界をまたぐ → 実際は丸ごと次ページへ送られる
    const blocks = [{ top: 950, bottom: 1120 }];
    assert.deepEqual(plain(T.paginateBreaks(blocks, H, 2500, 0)), [950, 1950],
      '2ページ目以降も送ったぶんだけ後ろへずれる');
  });

  // v1.0.8 で実測（Electron 31 の printToPDF）に合わせて改めた。以前は「送らずに境界で切る」としていた。
  await t.test('1ページに収まらない塊も、ページの途中から始まれば次ページへ送る（そこで分割）', () => {
    const blocks = [{ top: 100, bottom: 1500 }]; // 高さ1400 > 1ページ
    assert.deepEqual(plain(T.paginateBreaks(blocks, H, 2500, 0)), [100, 1100, 2100]);
  });

  await t.test('送りは連鎖する。位置は必ず前へ進み、無限ループしない', () => {
    // 900〜1100 を2ページ目へ送ると、2ページ目に残るのは 900〜1900。
    // 次の 1100〜2000 はそこへ収まらないので、さらに3ページ目へ送られる。
    const blocks = [{ top: 900, bottom: 1100 }, { top: 1100, bottom: 2000 }];
    const out = plain(T.paginateBreaks(blocks, H, 3000, 0));
    assert.deepEqual(out, [900, 1100, 2100]);
    assert.ok(out.every((v, i) => i === 0 || v > out[i - 1]), '位置は必ず前へ進む');
  });

  await t.test('ページ先頭から始まる塊は送らない（送っても同じ位置なので）', () => {
    assert.deepEqual(plain(T.paginateBreaks([{ top: 0, bottom: 1100 }], H, 2500, 0)), [1000, 2000]);
  });

  await t.test('複数の塊があっても、境界をまたぐものだけが効く', () => {
    const blocks = [
      { top: 100, bottom: 300 },   // 1ページ目に収まる
      { top: 980, bottom: 1200 },  // 1000 をまたぐ
      { top: 1300, bottom: 1500 }, // 2ページ目に収まる
    ];
    assert.deepEqual(plain(T.paginateBreaks(blocks, H, 2000, 0)), [980, 1980]);
  });

  await t.test('紙面の終わりを越える線は出さない', () => {
    assert.deepEqual(plain(T.paginateBreaks([], H, 1001, 0)), [], '残り 1px なら線は要らない');
    assert.deepEqual(plain(T.paginateBreaks([], H, 1500, 0)), [1000]);
  });

  await t.test('壊れた入力でも落ちない', () => {
    assert.deepEqual(plain(T.paginateBreaks(null, H, 2500, 0)), [1000, 2000], 'blocks が無くても刻む');
    assert.deepEqual(plain(T.paginateBreaks([], 0, 2500, 0)), [], '本文高が0なら計算しない');
    assert.deepEqual(plain(T.paginateBreaks([], NaN, 2500, 0)), []);
    assert.deepEqual(plain(T.paginateBreaks([], H, 2500, NaN)), [1000, 2000], 'start が非数なら0とみなす');
  });
});

// PDF のページ範囲（「ページ N 〜 M」。空欄＝最初／最後）
test('pdfout — ページ範囲（純関数）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('parsePdfPageRange — 空欄は最初／最後', () => {
    assert.deepEqual(plain(T.parsePdfPageRange('', '', 7)), { from: 1, to: 7 });
    assert.deepEqual(plain(T.parsePdfPageRange('3', '', 7)), { from: 3, to: 7 });
    assert.deepEqual(plain(T.parsePdfPageRange('', '4', 7)), { from: 1, to: 4 });
    assert.deepEqual(plain(T.parsePdfPageRange('2', '5', 7)), { from: 2, to: 5 });
  });
  await t.test('parsePdfPageRange — 逆転は入れ替え・総ページ数にクランプ・不正は空欄扱い', () => {
    assert.deepEqual(plain(T.parsePdfPageRange('5', '2', 7)), { from: 2, to: 5 });
    assert.deepEqual(plain(T.parsePdfPageRange('9', '12', 7)), { from: 7, to: 7 });
    assert.deepEqual(plain(T.parsePdfPageRange('abc', '0', 7)), { from: 1, to: 7 });
    assert.deepEqual(plain(T.parsePdfPageRange('2.9', '4.2', 7)), { from: 2, to: 4 }, '小数は切り捨て');
  });
  await t.test('parsePdfPageRange — 総ページ数が不明なら to は null（最後まで）', () => {
    assert.deepEqual(plain(T.parsePdfPageRange('3', '', null)), { from: 3, to: null });
    assert.deepEqual(plain(T.parsePdfPageRange('', '', null)), { from: 1, to: null });
  });
  await t.test('pdfPageRangeString — 全ページなら null、それ以外は 1 始まりの文字列', () => {
    assert.equal(T.pdfPageRangeString({ from: 1, to: 7 }, 7), null);
    assert.equal(T.pdfPageRangeString({ from: 1, to: null }, null), null);
    assert.equal(T.pdfPageRangeString({ from: 2, to: 5 }, 7), '2-5');
    assert.equal(T.pdfPageRangeString({ from: 1, to: 3 }, 7), '1-3');
    assert.equal(T.pdfPageRangeString({ from: 3, to: null }, null), '3-');
    assert.equal(T.pdfPageRangeString(null, 7), null);
  });
});

// ---- v1.0.8：改ページの入れ子（目次の改ページで使う） ----
// 仕様は docs/spec-pdf-output-scale.md の「v1.0.8 の追加・変更」参照。

test('pdfout — 改ページ位置（入れ子の塊。実測の規則）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const H = 1000;

  await t.test('ページの先頭から始まる塊が収まらないときは、中の塊の境目で切る', () => {
    const card = { top: 0, bottom: 1500, kids: [
      { top: 20, bottom: 600 }, { top: 620, bottom: 1200 }, { top: 1220, bottom: 1480 },
    ] };
    assert.deepEqual(plain(T.paginateBreaks([card], H, 1600, 0)), [620]);
  });

  await t.test('送られた塊は、次のページで中の塊の境目で切れる（実測 tallAvoidNested と同じ形）', () => {
    // 0〜300 の塊のあと、300〜1500 の塊（中に 600px の画像が2枚）。外側ごと2ページ目へ送られ、
    // 2ページ目の終わり（1300）をまたぐ2枚目が3ページ目へ送られる → 3ページ
    const blocks = [
      { top: 0, bottom: 300 },
      { top: 300, bottom: 1500, kids: [{ top: 300, bottom: 900 }, { top: 900, bottom: 1500 }] },
    ];
    assert.deepEqual(plain(T.paginateBreaks(blocks, H, 1500, 0)), [300, 900]);
  });

  await t.test('中の塊もページ先頭から始まって収まらなければ、ページの終わりで切る', () => {
    const blocks = [{ top: 0, bottom: 2500, kids: [{ top: 0, bottom: 2500 }] }];
    assert.deepEqual(plain(T.paginateBreaks(blocks, H, 2500, 0)), [1000, 2000]);
  });

  await t.test('ページの終わりが塊のあいだの余白に落ちたら、次のページは次の塊の上端から始まる', () => {
    // 0〜990 の塊のあと、余白 25px をおいて 1015〜2600 の大きな塊。実出力では余白が切り捨てられ、
    // 大きな塊は2ページ目の先頭から始まる（送られない）→ 3ページ。余白を数えると空のページが増える。
    const blocks = [{ top: 0, bottom: 990 }, { top: 1015, bottom: 2600 }];
    assert.deepEqual(plain(T.paginateBreaks(blocks, H, 2600, 0)), [1015, 2015]);
  });

  await t.test('余白とみなすのは狭いあいだだけ（広いあいだは end で切る）', () => {
    const blocks = [{ top: 0, bottom: 900 }, { top: 1100, bottom: 1500 }];
    assert.deepEqual(plain(T.paginateBreaks(blocks, H, 1600, 0)), [1000]);
  });

  await t.test('中の塊のあいだ（画像の行のあいだ）に落ちたときも、次の行の上端から始まる', () => {
    const card = { top: 0, bottom: 1700, kids: [{ top: 40, bottom: 990 }, { top: 1006, bottom: 1690 }] };
    assert.deepEqual(plain(T.paginateBreaks([card], H, 1700, 0)), [1006]);
  });

  await t.test('位置は必ず前へ進む（ページ先頭と同じ上端の塊は送らない）', () => {
    const blocks = [{ top: 0, bottom: 1500, kids: [{ top: 0, bottom: 1500 }] }];
    const out = plain(T.paginateBreaks(blocks, H, 1500, 0));
    assert.deepEqual(out, [1000]);
  });
});

// ---- v1.0.9：手順の配置（縦○段×横○列・上半分／下半分・余白の均等） ----
// 仕様は docs/spec-pdf-output-scale.md の「手順の配置（v1.0.9）」参照。

// 目次（表紙の直後）は今までどおり Chromium の改ページに任せ、プレビューの紙の分け方だけ計算する
test('pdfout — 目次の改ページの塊（printBreakBlocks）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  const root = app.document.createElement('div');
  root.innerHTML = '<div class="print-toc"><ul class="print-toc-list">' +
    '<li class="print-toc-sec" data-top="40" data-bottom="300"></li>' +
    '<li class="print-toc-sec" data-top="310" data-bottom="620"></li>' +
    '<li class="print-toc-sec" data-top="630" data-bottom="900"></li></ul></div>';
  app.document.body.appendChild(root);
  const boxOf = (el) => ({ top: Number(el.dataset.top), bottom: Number(el.dataset.bottom) });
  const blocks = plain(T.printBreakBlocks(root, boxOf));

  await t.test('目次のフェーズが1つずつ塊になる', () => {
    assert.deepEqual(blocks.map((b) => [b.top, b.bottom]), [[40, 300], [310, 620], [630, 900]]);
  });
  await t.test('ページの終わりをまたぐフェーズは、次のページへ送る', () => {
    // 1ページ 500：500 をまたぐ 310〜620 を送る → 2ページ目は 310〜810。810 をまたぐ 630〜900 を送る
    assert.deepEqual(plain(T.paginateBreaks(blocks, 500, 900, 0)), [310, 630]);
  });
});

test('pdfout — 手順の配置の設定（clampPrintGrid・setPrintGrid）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('縦は 1〜6 と自動（空欄）。奇数も選べ、6 を超えたら 6', () => {
    const rows = (v) => T.clampPrintGrid({ rows: v }).rows;
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(rows), [1, 2, 3, 4, 5, 6]);
    assert.equal(rows(8), 6);
    assert.equal(rows(2.5), 2, '小数は切り捨て');
    assert.equal(rows('3'), 3, '画面の選択肢は文字列');
    for (const bad of ['', null, undefined, 0, -2, 'あ', NaN]) assert.equal(rows(bad), '', `${String(bad)} は自動`);
  });
  await t.test('横は 1〜4 と自動（空欄）', () => {
    const cols = (v) => T.clampPrintGrid({ cols: v }).cols;
    assert.deepEqual([1, 2, 3, 4].map(cols), [1, 2, 3, 4]);
    assert.equal(cols(7), 4);
    assert.equal(cols(1.7), 1);
    for (const bad of ['', null, 0, 'x']) assert.equal(cols(bad), '', `${String(bad)} は自動`);
  });
  await t.test('既定は縦も横も自動。保存は Undo 履歴に積まず、廃止した「1列／2列」は消す', () => {
    assert.deepEqual(plain(T.printGridSettings()), { rows: '', cols: '' });
    T.store.state.settings.printImgLayout = '1col'; // v1.0.8 までの設定が残っている文書
    const before = T.store.canUndo();
    T.setPrintGrid({ rows: '3' });
    assert.deepEqual(plain(T.printGridSettings()), { rows: 3, cols: '' });
    T.setPrintGrid({ cols: '2' });
    assert.deepEqual(plain(T.printGridSettings()), { rows: 3, cols: 2 }, '片方だけ変えても、もう片方は残る');
    assert.equal(T.store.canUndo(), before, '配置の設定は Undo 履歴に積まない');
    assert.equal('printImgLayout' in T.store.state.settings, false);
    T.setPrintGrid({ rows: '' });
    assert.deepEqual(plain(T.printGridSettings()), { rows: '', cols: 2 });
  });
});

test('pdfout — 余白の配り方（balancedGaps）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const gaps = (...a) => plain(T.balancedGaps(...a));

  await t.test('間隔は最大 72 で頭打ちにし、余りは上と下に半分ずつ（下にだけためない）', () => {
    const { g, top } = gaps([100, 100], 1000, 28, 72);
    assert.equal(g, 72);
    assert.equal(top, 364);
    assert.equal(1000 - (top + 100 + g + 100), top, '下の余り＝上の余り');
  });
  await t.test('余りが少なければ最小 28 で並べ、残りを上と下に分ける', () => {
    assert.deepEqual(gaps([300, 300, 300], 1000, 28, 72), { g: 28, top: 22 });
  });
  await t.test('入りきらなければ間隔を詰める（0 まで）', () => {
    assert.deepEqual(gaps([500, 520], 1000, 28, 72), { g: 0, top: 0 });
  });
  await t.test('1つだけなら、その範囲の真ん中（流し込みで、区切りに手順が1つだけのとき）', () => {
    assert.equal(gaps([200], 1000, 28, 72).top, 400);
  });
  await t.test('上限なし：上・あいだ・下が同じ', () => {
    const { g, top } = gaps([300, 300], 932, 16, Infinity);
    assert.ok(Math.abs(g - top) < 1e-9);
    assert.ok(Math.abs(932 - (top + 600 + g) - top) < 1e-9);
  });
  await t.test('空・壊れた入力でも落ちない', () => {
    assert.deepEqual(gaps([], 1000, 28, 72), { g: 0, top: 0 });
    assert.deepEqual(gaps(null, 1000, 28, 72), { g: 0, top: 0 });
  });
});

test('pdfout — ページの区切り（pageDivisions・planPrintDivisions）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  // 区切りは [フェーズの番号, 見出しがあるか, 段の数]。使わない区切りは [-1, false, 0]
  const shape = (pages) => plain(pages).map((p) => p.divs.map((d) => [d.sec, d.title, d.rows.length]));
  const oneRow = () => false; // 縦 R 段：1つの区切りに1段
  const area = () => 500;

  await t.test('縦の数で、ページを上から等分する（縦2＝上と下、縦3＝3つ、縦1＝分けない）', () => {
    assert.deepEqual(plain(T.pageDivisions(0, 1000, 2, 16)), [{ top: 0, bot: 492 }, { top: 508, bot: 1000 }]);
    const three = plain(T.pageDivisions(0, 1000, 3, 16));
    assert.equal(three.length, 3);
    assert.ok(Math.abs(three[2].bot - 1000) < 1e-9, '最後の区切りはページの下端まで');
    three.forEach((d) => assert.ok(Math.abs(d.bot - d.top - (1000 - 32) / 3) < 1e-9, '区切りの高さは同じ'));
    assert.deepEqual(plain(T.pageDivisions(0, 1000, 1, 16)), [{ top: 0, bot: 1000 }]);
  });
  await t.test('縦2：1つの区切りに1段。続きの区切りには見出しを出さない。フェーズは区切りの先頭から', () => {
    const secs = [
      { title: true, rows: ['1', '2', '3'] },
      { title: true, rows: ['4'] },
    ];
    assert.deepEqual(shape(T.planPrintDivisions(secs, 2, oneRow, area)), [
      [[0, true, 1], [0, false, 1]], // 1ページ目：上に見出し＋1段、下は続き（見出しなし）
      [[0, false, 1], [1, true, 1]], // 2ページ目：続きの1段、次のフェーズは下の区切りから
    ]);
  });
  await t.test('縦3：ページを3つに分け、フェーズは次の区切りの先頭から', () => {
    const secs = [{ title: true, rows: ['1', '2'] }, { title: true, rows: ['3'] }, { title: true, rows: ['4', '5'] }];
    assert.deepEqual(shape(T.planPrintDivisions(secs, 3, oneRow, area)), [
      [[0, true, 1], [0, false, 1], [1, true, 1]],
      [[2, true, 1], [2, false, 1], [-1, false, 0]], // 文書の終わりの区切りは空けたまま
    ]);
  });
  await t.test('1ページ目の最初の区切りが文書の表題で埋まるときは、手順を次の区切りから入れる（firstDiv）', () => {
    const secs = [{ title: true, rows: ['1', '2'] }];
    assert.deepEqual(shape(T.planPrintDivisions(secs, 3, oneRow, area, 1)), [
      [[-1, false, 0], [0, true, 1], [0, false, 1]], // 1ページ目の最初の区切りは表題だけ
    ]);
    assert.deepEqual(shape(T.planPrintDivisions([{ title: true, rows: ['1', '2', '3'] }], 2, oneRow, area, 1)), [
      [[-1, false, 0], [0, true, 1]], [[0, false, 1], [0, false, 1]], // 2ページ目からは最初の区切りから
    ]);
  });
  await t.test('縦1：1ページに1段', () => {
    const secs = [{ title: true, rows: ['1', '2'] }, { title: true, rows: ['3'] }];
    assert.deepEqual(shape(T.planPrintDivisions(secs, 1, oneRow, area)), [[[0, true, 1]], [[0, false, 1]], [[1, true, 1]]]);
  });
  await t.test('縦が自動（上半分・下半分）：フェーズの手順が1つだけなら上半分に1つ。次のフェーズは下半分から', () => {
    const secs = [{ title: true, rows: ['1'] }, { title: true, rows: ['2', '3'] }];
    assert.deepEqual(shape(T.planPrintDivisions(secs, 2, () => true, area)), [[[0, true, 1], [1, true, 2]]]);
  });
  await t.test('縦が自動：区切りに入る限り入れ、入らない段は次の区切りへ（段と段の間は最小 28）', () => {
    const fits = (rows, row, areaH) => T.flowRowFits(rows.map((r) => r.h), row.h, areaH, 28);
    const secs = [{ title: true, rows: [{ h: 200 }, { h: 200 }, { h: 200 }, { h: 200 }] }];
    // 500 の区切り：200＋28＋200＝428 は入る。もう1段（428＋28＋200＝656）は入らない
    assert.deepEqual(shape(T.planPrintDivisions(secs, 2, fits, area)), [[[0, true, 2], [0, false, 2]]]);
  });
  await t.test('空の区切りには、区切りより高い段でも必ず入れる（描くときに縮める）', () => {
    const fits = (rows, row, areaH) => T.flowRowFits(rows.map((r) => r.h), row.h, areaH, 28);
    const secs = [{ title: true, rows: [{ h: 900 }, { h: 900 }] }];
    assert.deepEqual(shape(T.planPrintDivisions(secs, 2, fits, area)), [[[0, true, 1], [0, false, 1]]]);
  });
  await t.test('見出しだけのフェーズも区切りを1つ使い、次のフェーズは次の区切りから', () => {
    const secs = [{ title: true, rows: [] }, { title: true, rows: ['1'] }];
    assert.deepEqual(shape(T.planPrintDivisions(secs, 2, () => true, area)), [[[0, true, 0], [1, true, 1]]]);
  });
  await t.test('手順に使える高さは、見出しの有無ごとに聞く', () => {
    const calls = [];
    const areaOf = (pi, di, div) => { calls.push([pi, di, div.title]); return 500; };
    T.planPrintDivisions([{ title: true, rows: ['1', '2', '3', '4'] }], 2, (rows) => rows.length < 2, areaOf);
    assert.deepEqual(calls, [[0, 0, true], [0, 0, true], [0, 1, false]]);
  });
  await t.test('壊れた入力でも落ちない', () => {
    assert.deepEqual(plain(T.planPrintDivisions(null, 2, () => true, area)), []);
  });
});

test('pdfout — 画像の大きさ（fitFlowCardImages・fitImagesInBox）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  // 並べ方 k（1段の枚数）で、画像が欄 W×H に収まっているか
  const inBox = ({ k, sizes }, W, H, gap) => {
    const rows = [];
    for (let i = 0; i < sizes.length; i += k) rows.push(sizes.slice(i, i + k));
    const w = Math.max(...rows.map((r) => r.reduce((a, [x]) => a + x, 0) + gap * (r.length - 1)));
    const h = rows.reduce((a, r) => a + Math.max(...r.map(([, y]) => y)), 0) + gap * (rows.length - 1);
    return w <= W + 1e-9 && h <= H + 1e-9;
  };
  const ratioKept = (sizes, dims) => sizes.every(([w, h], i) => Math.abs(h / w - dims[i][1] / dims[i][0]) < 0.02);

  await t.test('流し込み：上限が無ければ画像は手順の中の幅いっぱい（縦に積む）', () => {
    const r = plain(T.fitFlowCardImages(60, 500, [[1000, 500], [1000, 750]], null, 10));
    assert.equal(r.k, 1);
    assert.deepEqual(r.sizes, [[500, 250], [500, 375]]);
    assert.equal(r.h, 60 + 10 + 250 + 375);
    assert.equal(r.over, false);
  });
  await t.test('流し込み：区切りより高い手順は、画像を縦横比のまま縮めて欄に収める', () => {
    const dims = [[1000, 500], [1000, 750]];
    const r = plain(T.fitFlowCardImages(60, 500, dims, 400, 10));
    assert.equal(r.h, 400);
    assert.ok(inBox(r, 500, 340, 10), '画像の欄（400−60）に収まる');
    assert.ok(ratioKept(r.sizes, dims));
    assert.equal(r.over, false);
  });
  await t.test('流し込み：縮めるときは、画像が大きく見える並べ方にする（4枚なら 2枚×2段）', () => {
    const dims = Array(4).fill([1600, 900]);
    const r = plain(T.fitFlowCardImages(40, 500, dims, 360, 10));
    assert.equal(r.k, 2);
    assert.ok(inBox(r, 500, 320, 10));
  });
  await t.test('流し込み：文だけで入りきらない手順は「はみ出し」', () => {
    assert.equal(T.fitFlowCardImages(500, 0, [], 400, 10).over, true);
    assert.equal(T.fitFlowCardImages(300, 0, [], 400, 10).h, 300, '画像の無い手順の高さは文の高さ');
  });
  await t.test('マス：横に広い欄では横に並べ、縦に高い欄では縦に積む（画像が大きく出るほう）', () => {
    const wide = [[1600, 900], [1600, 900]];
    assert.equal(T.fitImagesInBox(600, 200, wide, 10).k, 2);
    assert.equal(T.fitImagesInBox(300, 600, wide, 10).k, 1);
  });
  await t.test('マス：画像は縦横比を保ち、欄からはみ出さない', () => {
    for (const [W, H] of [[600, 200], [300, 600], [480, 480]]) {
      const dims = [[1280, 900], [1000, 1000], [1200, 1414]];
      const r = plain(T.fitImagesInBox(W, H, dims, 10));
      assert.ok(inBox(r, W, H, 10), `${W}×${H}`);
      assert.ok(ratioKept(r.sizes, dims));
    }
  });
  await t.test('マス：欄が残っていなければ大きさ 0', () => {
    assert.deepEqual(plain(T.fitImagesInBox(300, -5, [[4, 3]], 10)).sizes, [[0, 0]]);
  });
});

test('pdfout — 段の中の横の位置（rowCells・fillRowWidths・packRowsByWidth）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('横 C 列：段の手順の数で本文の幅いっぱいを等分する', () => {
    assert.deepEqual(plain(T.rowCells(2, 1000, 16)), [{ x: 0, w: 492 }, { x: 508, w: 492 }]);
  });
  await t.test('横の割りは強制しない：手順が1つだけの段は、手順の箱が左右いっぱい', () => {
    assert.deepEqual(plain(T.rowCells(1, 1000, 16)), [{ x: 0, w: 1000 }]);
  });
  await t.test('横が自動：幅の目安の比で、本文の幅いっぱいを分ける', () => {
    const cells = plain(T.fillRowWidths([300, 600], 1000, 16));
    assert.equal(cells[0].x, 0);
    assert.ok(Math.abs(cells[1].x + cells[1].w - 1000) < 1e-9, '右端は本文の右端');
    assert.ok(Math.abs(cells[1].w / cells[0].w - 2) < 1e-9, '幅の比は目安のまま');
  });
  await t.test('横が自動：1段に入る限り並べる', () => {
    assert.deepEqual(plain(T.packRowsByWidth([400, 400, 400, 900, 100], 1000, 16)), [[0, 1], [2], [3], [4]]);
  });
});

// 印刷の試験文書。フェーズ「準備」に手順5つ、「作業」「確認」に手順1つずつ
const layoutFixture = (type = 'template', extra = {}) => {
  const item = (id, text, images = [PX_PNG]) => ({ id, text, done: false, note: '', time: '', body: '', images });
  return {
    id: 'p1', title: '印刷試験', type, createdAt: 1, updatedAt: 1,
    sections: [
      { id: 'a', title: '準備', items: ['1', '2', '3', '4', '5'].map((n) => item('a' + n, '手順' + n)) },
      { id: 'b', title: '作業', items: [item('b1', '手順6', [])] },
      { id: 'c', title: '確認', items: [item('c1', '手順7')] },
    ],
    ...extra,
  };
};
// 組んだページを DOM にして、区切りごとの中身を読む。区切りは、置いた要素の入るべき範囲（data-reg）の上端で決める。
// jsdom では高さが 0 なので、段を指定した配置で並びを見る
const readPages = (T, doc, layout, n = 2) => Array.from(layout.pages, (html) => {
  const box = doc.createElement('div');
  box.innerHTML = html;
  const page = box.firstElementChild;
  const divs = plain(T.pageDivisions(0, layout.H, n, 16));
  const divOf = (el) => {
    const top = Number(el.dataset.reg.split(',')[0]);
    return Math.max(0, divs.findIndex((d) => top < d.bot));
  };
  const halves = divs.map(() => []);
  page.querySelectorAll('.pl-abs').forEach((el) => {
    if (el.querySelector('.print-doc-title')) return;
    const title = el.querySelector('.print-section-title');
    const step = el.querySelector('.print-step-text, .print-todo .print-text');
    halves[divOf(el)].push(title ? `【${title.textContent}】` : step.textContent);
  });
  return { page, halves, hasDocTitle: !!page.querySelector('.print-doc-title') };
});

test('pdfout — ページの組み立て（composePrintPages）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const opts = (grid) => ({ paper: 'A4', orient: 'portrait', scale: 100, grid });

  await t.test('縦2×横2：左上・右上・左下・右下。続きは見出しなし。フェーズは上か下の区切りの先頭から', async () => {
    const layout = await T.composePrintPages(layoutFixture(), opts({ rows: 2, cols: 2 }));
    const pages = readPages(T, app.document, layout);
    assert.deepEqual(pages.map((p) => p.halves), [
      [['【準備】', '手順1', '手順2'], ['手順3', '手順4']],
      [['手順5'], ['【作業】', '手順6']],
      [['【確認】', '手順7'], []],
    ]);
    assert.equal(pages[0].hasDocTitle, true, '1ページ目の上に文書の表題');
    assert.equal(pages[1].hasDocTitle, false);
  });
  await t.test('縦2×横2：手順が1つだけの段は、手順の箱を左右いっぱいに（横の割りは強制しない）', async () => {
    const layout = await T.composePrintPages(layoutFixture(), opts({ rows: 2, cols: 2 }));
    const card = readPages(T, app.document, layout)[1].page.querySelector('.pl-cell');
    assert.equal(parseFloat(card.style.left), 0);
    assert.ok(Math.abs(parseFloat(card.style.width) - layout.W) < 0.02, `幅 ${card.style.width} / ${layout.W}`);
  });
  await t.test('縦3×横2：ページを3つに分け、1つの区切りに1段。フェーズは次の区切りの先頭から', async () => {
    const layout = await T.composePrintPages(layoutFixture(), opts({ rows: 3, cols: 2 }));
    assert.deepEqual(readPages(T, app.document, layout, 3).map((p) => p.halves), [
      [['【準備】', '手順1', '手順2'], ['手順3', '手順4'], ['手順5']],
      [['【作業】', '手順6'], ['【確認】', '手順7'], []],
    ]);
  });
  await t.test('縦1×横1：1ページに手順1つ。手順はページの上に詰め、箱は中身の高さのまま', async () => {
    const layout = await T.composePrintPages(layoutFixture(), opts({ rows: 1, cols: 1 }));
    const pages = readPages(T, app.document, layout, 1);
    assert.deepEqual(pages.map((p) => p.halves), [
      [['【準備】', '手順1']], [['手順2']], [['手順3']], [['手順4']], [['手順5']], [['【作業】', '手順6']], [['【確認】', '手順7']],
    ]);
    pages.forEach(({ page }) => {
      const card = page.querySelector('.pl-flow');
      assert.ok(card, '縦1は流し込みと同じ手順の箱（中身の高さ）');
      const [top, bot] = card.dataset.reg.split(',').map(Number);
      // jsdom では見出しの高さが 0 なので、上に詰めると手順の上端＝区切りの上端
      assert.ok(Math.abs(parseFloat(card.style.top) - top) < 0.01, '上に詰める（真ん中に寄せない）');
      assert.ok(parseFloat(card.style.height) < bot - top, '手順の箱をページいっぱいに伸ばさない');
    });
  });
  await t.test('縦4×横2（ToDo 型）：ページを4つに分ける', async () => {
    const layout = await T.composePrintPages(layoutFixture('todo'), opts({ rows: 4, cols: 2 }));
    const pages = readPages(T, app.document, layout, 4);
    assert.deepEqual(pages[0].halves, [['【準備】', '手順1', '手順2'], ['手順3', '手順4'], ['手順5'], ['【作業】', '手順6']]);
    assert.ok(pages[0].page.querySelector('.pl-cell > .print-todo'), 'ToDo の項目も手順の箱に入る');
  });
  await t.test('縦が自動：手順の画像に大きさ（px）を書き、1ページの高さの .print-page に入れる', async () => {
    const layout = await T.composePrintPages(layoutFixture(), opts({ rows: '', cols: '' }));
    const { page } = readPages(T, app.document, layout)[0];
    assert.ok(page.classList.contains('print-page'));
    assert.equal(parseFloat(page.style.height), Number(layout.H.toFixed(2)));
    const img = page.querySelector('.pl-flow .print-img-row .print-img');
    assert.match(img.getAttribute('style'), /width:\d+px;height:\d+px/);
    // A4縦・100% の本文の高さ（297−30mm）より、端数の余裕のぶんだけ低い
    assert.ok(layout.H < 267 * 96 / 25.4 && layout.H > 267 * 96 / 25.4 - 6);
  });
  await t.test('倍率を下げると、本文の内部座標の1ページは広くなる（zoom で縮めて印刷するため）', async () => {
    const a = await T.composePrintPages(layoutFixture(), opts({ rows: 2, cols: 2 }));
    const b = await T.composePrintPages(layoutFixture(), { ...opts({ rows: 2, cols: 2 }), scale: 50 });
    assert.ok(Math.abs(b.W - a.W * 2) < 0.01);
  });
  await t.test('表紙と目次があれば、プレビューの紙は表紙・目次・手順のページの順', async () => {
    const c = layoutFixture('template', { coverPage: { enabled: true, includeToc: true } });
    const layout = await T.composePrintPages(c, opts({ rows: 2, cols: 2 }));
    assert.ok(layout.coverHtml.includes('print-cover'));
    assert.equal(layout.tocSegments.length, 1);
    assert.equal(readPages(T, app.document, layout)[0].hasDocTitle, false, '表紙があれば文書の表題は出さない');
    const sheets = T.previewSheetsHtml(layout, opts({ rows: 2, cols: 2 }));
    assert.equal(sheets.count, 1 + 1 + layout.pages.length);
    assert.match(sheets.html, /pp-sheet pp-sheet-cover/);
  });
});

test('pdfout — 印刷ボタン：ページを組んでから、PDF と同じ倍率を #print-root の zoom で掛ける', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  T.setPdfOutSettings({ scale: 70, paper: 'A4', orient: 'landscape' });
  await T.printChecklist(layoutFixture());
  const css = app.document.getElementById('print-page-style').textContent;
  assert.ok(css.includes('#print-root { zoom: 0.7; }'), css);
  assert.ok(css.includes('@page { size: 297mm 210mm; }'), '用紙・向きも効く');
  assert.ok(app.document.querySelector('#print-root .print-page .print-section-title'), '組んだページが入っている');
  assert.equal(app.document.querySelector('.print-measure'), null, '高さを測る箱は片付ける');
});
