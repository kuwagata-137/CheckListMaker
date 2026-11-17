// 画像編集画面の吹き出しの大きさを、四角と同じハンドル 8 個で変える試験（計画外の追加要望）。
// jsdom に canvas が無いため画像編集画面は開かず、吹き出しの行組みとハンドルの純関数だけを確認する。
// 仕様は docs/spec-image-editor-enhancements.md 26章。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));
// 擬似の measureText: 全角＝10px・半角＝5px（文字サイズによらない）
const measure = (s) => Array.from(s).reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 10 : 5), 0);
const TEXT15 = 'あいうえおかきくけこさしすせそ'; // 全角15字

test('calloutresize — 吹き出しの行組みと文字の位置（仕様 26章）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('calloutLayout — 大きさを変えていない吹き出しは、全角12字で折り返し、文字量で大きさが決まる（変更前と同じ）', () => {
    const lay = plain(T.calloutLayout(TEXT15, 10, measure, { type: 'callout' }));
    // 文字サイズ 10: 余白 P = round(5.5) = 6、行の高さ = 13、折り返し幅 = 10×12 = 120（全角12字）
    assert.deepEqual(lay.lines, ['あいうえおかきくけこさし', 'すせそ']);
    assert.equal(lay.P, 6);
    assert.equal(lay.lh, 13);
    assert.equal(lay.tw, 120);
    assert.equal(lay.th, 26);
    assert.equal(lay.w, 132, '幅 = 文字の幅 + 余白×2');
    assert.equal(lay.h, 38, '高さ = 行数×行の高さ + 余白×2');
    assert.equal(lay.needH, 38);
  });

  await t.test('calloutLayout — 保存データに w・h があっても、wFixed・hMin が無ければ使わない（互換）', () => {
    const lay = plain(T.calloutLayout(TEXT15, 10, measure, { type: 'callout', w: 999, h: 999 }));
    assert.equal(lay.w, 132);
    assert.equal(lay.h, 38);
  });

  await t.test('calloutLayout — 空の文字は 1 行ぶん（変更前と同じ）', () => {
    const lay = plain(T.calloutLayout('', 10, measure, {}));
    assert.deepEqual(lay.lines, [' ']);
    assert.equal(lay.h, 25);
  });

  await t.test('calloutLayout — 幅を変えた吹き出し（wFixed）は、その幅から余白を除いた幅で折り返す', () => {
    const lay = plain(T.calloutLayout(TEXT15, 10, measure, { wFixed: true, w: 80 }));
    // 折り返し幅 = 80 − 12 = 68 → 全角6字（60px）ずつ
    assert.deepEqual(lay.lines, ['あいうえおか', 'きくけこさし', 'すせそ']);
    assert.equal(lay.w, 80, '幅は決めた幅のまま');
    assert.equal(lay.tw, 60);
    assert.equal(lay.h, 51, '高さは文字量（3 行）で決まる');
  });

  await t.test('calloutLayout — 高さを変えた吹き出し（hMin）は、hMin と文字が入る高さの大きい方', () => {
    assert.equal(T.calloutLayout(TEXT15, 10, measure, { hMin: 100 }).h, 100, '大きくした高さ');
    assert.equal(T.calloutLayout(TEXT15, 10, measure, { hMin: 20 }).h, 38, '文字を隠す高さにはしない');
    assert.equal(T.calloutLayout(TEXT15 + TEXT15, 10, measure, { hMin: 40 }).h, 51,
      '文字を増やして入りきらない時は下へ伸びる（3 行）');
  });

  await t.test('calloutTextOffset — 大きさを変えていない吹き出しは、余白 P の位置（変更前と同じ）', () => {
    const lay = T.calloutLayout(TEXT15, 10, measure, {});
    assert.deepEqual(plain(T.calloutTextOffset(lay)), { x: 6, y: 6 });
  });

  await t.test('calloutTextOffset — 大きくした吹き出しは、文字のかたまりを上下左右の中央に置く（質問 Q3 の推奨案）', () => {
    const lay = T.calloutLayout('あいう', 10, measure, { wFixed: true, w: 200, hMin: 100 });
    // 文字のかたまり 30×13 → x = (200 − 30) / 2 = 85、y = (100 − 13) / 2 = 43.5
    assert.deepEqual(plain(T.calloutTextOffset(lay)), { x: 85, y: 43.5 });
  });
});

test('calloutresize — ハンドル 8 個と尻尾（objHandles。仕様 26章）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('本体の大きさが分かれば、四角と同じ 8 個と尻尾（尻尾は最後＝上に描く）', () => {
    const hs = plain(T.objHandles({ type: 'callout', x: 10, y: 20, w: 100, h: 60, tip: { x: 30, y: 120 } }));
    assert.deepEqual(hs.map((h) => h.kind), ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se', 'tip']);
    const by = Object.fromEntries(hs.map((h) => [h.kind, h]));
    assert.deepEqual(by.nw, { kind: 'nw', x: 10, y: 20 });
    assert.deepEqual(by.n, { kind: 'n', x: 60, y: 20 });
    assert.deepEqual(by.e, { kind: 'e', x: 110, y: 50 });
    assert.deepEqual(by.se, { kind: 'se', x: 110, y: 80 });
    assert.deepEqual(by.tip, { kind: 'tip', x: 30, y: 120 });
  });

  await t.test('描く前（w・h が無い）は尻尾だけ（変更前と同じ）', () => {
    assert.deepEqual(plain(T.objHandles({ type: 'callout', x: 10, y: 20, tip: { x: 30, y: 120 } })),
      [{ kind: 'tip', x: 30, y: 120 }]);
  });
});

test('calloutresize — ハンドルで吹き出しの大きさを変える（applyObjDrag。仕様 26章）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  // 大きさを変えていない吹き出し（全角15字・文字サイズ 10 → 132×38、2 行）
  const base = () => ({ type: 'callout', x: 100, y: 100, w: 132, h: 38, text: TEXT15, fs: 10, tip: { x: 120, y: 200 } });
  const drag = (mode, dx, dy, o0 = base()) => {
    const obj = plain(o0);
    T.applyObjDrag({ mode, obj, sx: 0, sy: 0, orig: plain(o0), measure }, { x: dx, y: dy });
    return obj;
  };

  await t.test('右下（se）: 幅と高さが変わり、wFixed と hMin が付く。尻尾の先は動かない', () => {
    const o = drag('se', 48, 62);
    assert.equal(o.x, 100);
    assert.equal(o.y, 100);
    assert.equal(o.w, 180);
    assert.equal(o.h, 100);
    assert.equal(o.wFixed, true);
    assert.equal(o.hMin, 100);
    assert.deepEqual(plain(o.tip), { x: 120, y: 200 });
  });

  await t.test('右の辺（e）: 幅だけを変え、狭めて行が増えたら上の辺を固定して下へ伸びる', () => {
    const o = drag('e', -72, 0); // 幅 60 → 折り返し幅 48 → 全角4字ずつ → 4 行
    assert.equal(o.w, 60);
    assert.equal(o.wFixed, true);
    assert.equal(o.y, 100);
    assert.equal(o.h, 64, '4 行×13 + 余白×2');
    assert.equal(o.hMin, undefined, '高さは決めていない');
  });

  await t.test('右の辺（e）: 決めた高さ（hMin）は保ち、文字が入らなくなったら hMin より伸びる', () => {
    const tall = { ...base(), h: 100, hMin: 100 };
    assert.equal(drag('e', 48, 0, tall).h, 100, '広げても hMin の高さ');
    assert.equal(drag('e', -72, 0, tall).h, 100, '4 行（64）は hMin（100）に収まる');
    assert.equal(drag('e', -100, 0, tall).h, 116, '幅 32 → 全角2字ずつ 8 行（116）は hMin より伸びる');
    assert.equal(drag('e', -100, 0, tall).hMin, 100, 'hMin はそのまま');
  });

  await t.test('上の辺（n）: 文字が入る高さより小さくできない。決めた高さを hMin に入れる', () => {
    const shrink = drag('n', 0, 50); // 文字が入る高さ 38 より小さくしようとする
    assert.equal(shrink.y, 100);
    assert.equal(shrink.h, 38);
    assert.equal(shrink.hMin, 38);
    const grow = drag('n', 0, -40);
    assert.equal(grow.y, 60);
    assert.equal(grow.h, 78);
    assert.equal(grow.hMin, 78);
    assert.equal(grow.wFixed, undefined, '高さだけを変えたなら、幅は文字量で決まるまま');
    assert.deepEqual(plain(grow.tip), { x: 120, y: 200 }, '尻尾の先は動かない');
  });

  await t.test('左の辺（w）: 最小幅は 1 文字ぶん（文字サイズ＋余白×2）。行が増えた分だけ下へ伸びる', () => {
    const o = drag('w', 500, 0);
    assert.equal(o.w, 22);
    assert.equal(o.x, 210, '右の辺は動かない');
    assert.equal(o.y, 100);
    assert.equal(o.h, 207, '1 字ずつ 15 行');
  });

  await t.test('文字幅を測る関数（measure）が無くても落ちない', () => {
    const obj = plain(base());
    T.applyObjDrag({ mode: 'se', obj, sx: 0, sy: 0, orig: plain(base()) }, { x: 10, y: -30 });
    assert.equal(obj.w, 142);
    assert.equal(obj.h, 25, '折り返しを測れないので 1 行ぶん（13 + 12）まで縮む');
  });

  await t.test('回転した吹き出し: 固定した辺と尻尾の先は、画面上で動かない', () => {
    const o0 = { type: 'callout', x: 0, y: 0, w: 100, h: 50, hMin: 50, rot: 90, text: 'あ', fs: 10, tip: { x: 50, y: 80 } };
    const near = (a, b, msg) => assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6,
      `${msg}: (${a.x},${a.y}) ≠ (${b.x},${b.y})`);
    const fixed0 = plain(T.toWorldPoint(o0, { x: 0, y: 0 })); // 左上の角（e・se では動かない）
    const tip0 = plain(T.toWorldPoint(o0, o0.tip));
    // 90°回転中は、画面の下方向 (0, 30) が吹き出しの軸の +x（右の辺を外へ）
    const o = drag('e', 0, 30, o0);
    assert.ok(Math.abs(o.w - 130) < 1e-9, `幅 130（実際 ${o.w}）`);
    assert.equal(o.h, 50);
    near(T.toWorldPoint(o, { x: o.x, y: o.y }), fixed0, '左上の角');
    near(T.toWorldPoint(o, o.tip), tip0, '尻尾の先');
    // 四隅（se）で高さも変える: 画面の (−20, 30) は吹き出しの軸の (+30, +20)
    const o2 = drag('se', -20, 30, o0);
    assert.ok(Math.abs(o2.w - 130) < 1e-9 && Math.abs(o2.h - 70) < 1e-9, `130×70（実際 ${o2.w}×${o2.h}）`);
    near(T.toWorldPoint(o2, { x: o2.x, y: o2.y }), fixed0, 'se でも左上の角');
    near(T.toWorldPoint(o2, o2.tip), tip0, 'se でも尻尾の先');
  });
});
