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
