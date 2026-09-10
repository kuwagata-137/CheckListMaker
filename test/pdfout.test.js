// PDF出力の倍率・用紙・向き（純関数＋設定保存）のテスト。
// 仕様は docs/spec-pdf-output-scale.md 参照。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./harness');

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

  // 画像の幅は親基準の % なので、zoom / printToPDF の scale だけでは縮まない。
  // 同じ倍率を --print-img-scale として降ろすのが唯一の追従手段（仕様の「制約（既知）」参照）。
  await t.test('pdfPageStyleCss — 倍率を --print-img-scale として出す', () => {
    assert.ok(T.pdfPageStyleCss('A4', 'portrait', 0.7).includes('#print-root { --print-img-scale: 0.7; }'));
    for (const bad of [undefined, null, 0, -1, NaN, 'あ']) {
      assert.ok(T.pdfPageStyleCss('A4', 'portrait', bad).includes('--print-img-scale: 1;'),
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

  await t.test('1ページに収まらない塊は送らない（実際にも分割される）', () => {
    const blocks = [{ top: 100, bottom: 1500 }]; // 高さ1400 > 1ページ
    assert.deepEqual(plain(T.paginateBreaks(blocks, H, 2500, 0)), [1000, 2000]);
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
