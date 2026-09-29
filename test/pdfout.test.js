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

  // 倍率は #print-root の zoom で掛ける（印刷・PDF 共通。v1.0.8）。画像の幅は親基準の % なので
  // zoom だけでは縮まず、同じ倍率を --print-img-scale としても降ろす（仕様の「制約（既知）」参照）。
  await t.test('pdfPageStyleCss — 倍率を zoom と --print-img-scale として出す', () => {
    assert.ok(T.pdfPageStyleCss('A4', 'portrait', 0.7).includes('#print-root { zoom: 0.7; --print-img-scale: 0.7; }'));
    for (const bad of [undefined, null, 0, -1, NaN, 'あ']) {
      assert.ok(T.pdfPageStyleCss('A4', 'portrait', bad).includes('#print-root { zoom: 1; --print-img-scale: 1; }'),
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

// ---- v1.0.8：改ページの入れ子・フェーズ見出しのまとまり・倍率の自動調整・印刷への倍率 ----
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

// 印刷ビュー（renderPrintView）を DOM に入れ、各要素の位置は data-top / data-bottom で与える
const printDom = (T, doc, checklist, pos) => {
  const root = doc.createElement('div');
  root.innerHTML = T.renderPrintView(checklist);
  doc.body.appendChild(root);
  pos(root);
  const boxOf = (el) => ({ top: Number(el.dataset.top), bottom: Number(el.dataset.bottom) });
  return { root, boxOf };
};
const setBox = (el, top, bottom) => { el.dataset.top = String(top); el.dataset.bottom = String(bottom); };
const printChecklistFixture = () => ({
  id: 'p1', title: '印刷試験', type: 'template', createdAt: 1, updatedAt: 1,
  sections: [
    { id: 'a', title: '準備', items: [
      { id: 'a1', text: '手順1', done: false, note: '', time: '', body: '', images: [PX_PNG, PX_PNG] },
      { id: 'a2', text: '手順2', done: false, note: '', time: '', body: '', images: [] },
    ] },
    { id: 'b', title: '', items: [
      { id: 'b1', text: '手順3', done: false, note: '', time: '', body: '', images: [PX_PNG] },
    ] },
    { id: 'c', title: '見出しだけ', items: [] },
  ],
});

test('pdfout — 改ページの塊を印刷ビューから組む（printBreakBlocks）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  const { root, boxOf } = printDom(T, app.document, printChecklistFixture(), (r) => {
    const titles = r.querySelectorAll('.print-section-title');
    const steps = r.querySelectorAll('.print-step');
    const imgs = r.querySelectorAll('.print-img');
    setBox(titles[0], 0, 40);      // 準備
    setBox(steps[0], 54, 700);     // 手順1（画像2枚）
    setBox(imgs[0], 100, 380);
    setBox(imgs[1], 396, 680);
    setBox(steps[1], 728, 800);    // 手順2（画像なし）
    setBox(steps[2], 850, 1200);   // 手順3（見出しなしのフェーズ）
    setBox(imgs[2], 900, 1180);
    setBox(titles[1], 1250, 1290); // 見出しだけのフェーズ
  });
  const blocks = plain(T.printBreakBlocks(root, boxOf));

  await t.test('フェーズの最初の手順は、見出しの上端から始まる1つの塊になる', () => {
    assert.equal(blocks[0].top, 0, '見出し（0）から');
    assert.equal(blocks[0].bottom, 700, '最初の手順の下端（700）まで');
  });
  await t.test('手順カードの中の画像は kids（トップレベルには出ない）', () => {
    assert.deepEqual(blocks[0].kids.map((k) => k.top), [100, 396]);
    assert.equal(blocks.filter((b) => b.top === 100 || b.top === 396).length, 0);
  });
  await t.test('見出しの無いフェーズの手順はそのまま。見出しだけのフェーズは見出しを1つの塊にする', () => {
    assert.deepEqual(blocks.map((b) => [b.top, b.bottom]), [[0, 700], [728, 800], [850, 1200], [1250, 1290]]);
    assert.deepEqual(blocks[2].kids.map((k) => k.top), [900]);
  });
  await t.test('見出しがページ先頭なら送らず、最初の手順の中（画像の境目）で切る（見出しは手順の先頭と同じページ）', () => {
    // 1ページ 500。見出し(0)＋手順1(〜700) は 500 をまたぐが、ページ先頭から始まるので送れない
    // → 中の画像の境目（396）で切る。
    assert.deepEqual(plain(T.paginateBreaks(blocks, 500, 1290, 0)), [396, 850]);
  });
  await t.test('見出しがページの途中なら、見出しごと次ページへ送る', () => {
    const shifted = [{ top: 0, bottom: 300 }, ...blocks.map((b) => ({ ...b, top: b.top + 320, bottom: b.bottom + 320,
      kids: (b.kids || []).map((k) => ({ top: k.top + 320, bottom: k.bottom + 320 })) }))];
    // 見出し(320)＋手順1(〜1020) が 500 をまたぐ → 見出しの上端 320 で改ページ
    assert.equal(plain(T.paginateBreaks(shifted, 500, 1610, 0))[0], 320);
  });
});

test('pdfout — 倍率の自動調整（autoPrintScale）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const PAGE = 1000; // 1ページの本文の高さ（物理 px）

  await t.test('100% で収まるなら 100%', () => {
    assert.equal(T.autoPrintScale(() => [800, 600], PAGE), 100);
  });
  await t.test('収まる最大の倍率を 5% 刻みで選ぶ（1300px → 75%）', () => {
    assert.equal(T.autoPrintScale(() => [1300], PAGE), 75);
  });
  await t.test('倍率で高さが変わっても（実際の組版を測る想定）収まる最大を選ぶ', () => {
    // 75%: (1200+150)×0.75=1012 > 1000 ✕ / 70%: (1200+140)×0.7=938 ○
    assert.equal(T.autoPrintScale((p) => [1200 + 2 * p], PAGE), 70);
  });
  await t.test('30% でも収まらない項目は計算から外す（全体を 30% に引きずらない）', () => {
    assert.equal(T.autoPrintScale(() => [1300, 5000], PAGE), 75);
    assert.equal(T.autoPrintScale(() => [5000], PAGE), 100, '全部外れたら変えない');
    assert.equal(T.autoPrintScale(() => [], PAGE), 100, '画像が無ければ 100%');
  });
  await t.test('下限は 30%', () => {
    assert.equal(T.autoPrintScale(() => [3300], PAGE), 30); // 30%: 990 ○ / 35%: 1155 ✕
  });
  await t.test('二分探索の答えは総当たりと同じ', () => {
    // 総当たり：30% でも収まらない項目を外したうえで、100% から順に試す
    const brute = (fn) => {
      const fit = (p, h) => h * p / 100 <= PAGE + 0.5;
      const keep = fn(30).map((h, i) => (fit(30, h) ? i : -1)).filter((i) => i >= 0);
      for (let p = 100; p >= 30; p -= 5) if (keep.every((i) => fit(p, fn(p)[i]))) return p;
      return 30;
    };
    for (let k = 0; k < 40; k++) {
      const a = 900 + k * 97, b = (k % 7) * 3;
      const fn = (p) => [a + b * p, 400 + k * 10];
      assert.equal(T.autoPrintScale(fn, PAGE), brute(fn), `k=${k}`);
    }
  });
  await t.test('壊れた入力でも落ちない', () => {
    assert.equal(T.autoPrintScale(() => [1300], 0), 100);
    assert.equal(T.autoPrintScale(null, PAGE), 100);
    assert.equal(T.autoPrintScale(() => null, PAGE), 100);
  });
});

test('pdfout — フェーズ見出しの改ページ指定と、印刷ボタンへの倍率', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('フェーズ見出しに break-after: avoid（最初の項目と別ページにしない）', () => {
    const css = [...app.document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const rule = (css.match(/\.print-section-title\s*\{[^}]*\}/) || [''])[0];
    assert.ok(/break-after:\s*avoid/.test(rule), `.print-section-title の規則: ${rule.replace(/\s+/g, ' ')}`);
  });
  await t.test('印刷ボタンも、PDF と同じ倍率を #print-root の zoom で掛ける', () => {
    T.setPdfOutSettings({ scale: 70, paper: 'A4', orient: 'landscape' });
    T.printChecklist(printChecklistFixture());
    const css = app.document.getElementById('print-page-style').textContent;
    assert.ok(css.includes('#print-root { zoom: 0.7; --print-img-scale: 0.7; }'), css);
    assert.ok(css.includes('@page { size: 297mm 210mm; }'), '用紙・向きも効く');
    assert.ok(app.document.querySelector('#print-root .print-section-title'), '印刷ビューが入っている');
  });
});
