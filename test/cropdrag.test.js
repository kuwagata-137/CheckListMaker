// 画像編集画面のトリミング（ドラッグでトリミング範囲を決める・境界アイコンを範囲の内側に描く）の試験。
// jsdom に canvas が無いため画像編集画面は開かず、トリミングの純関数だけを確認する。
// 仕様は docs/spec-image-editor-enhancements.md 25章。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));

test('cropdrag — 境界アイコンの位置と当たり判定（仕様 25章）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const r = { x: 100, y: 50, w: 200, h: 120 };

  await t.test('cropIconRects — 四隅は □ の外側の角、各辺は □ の外側の辺を範囲に合わせる', () => {
    const ics = plain(T.cropIconRects(r, 16));
    assert.deepEqual(ics.map((i) => i.kind), ['n', 'e', 's', 'w', 'nw', 'ne', 'se', 'sw'],
      '各辺 → 四隅の順番（四隅を後に描いて上に重ねる）');
    const by = Object.fromEntries(ics.map((i) => [i.kind, i]));
    assert.deepEqual(by.nw, { kind: 'nw', x: 100, y: 50, w: 16, h: 16 }, '左上の角');
    assert.deepEqual(by.ne, { kind: 'ne', x: 284, y: 50, w: 16, h: 16 }, '右上の角');
    assert.deepEqual(by.se, { kind: 'se', x: 284, y: 154, w: 16, h: 16 }, '右下の角');
    assert.deepEqual(by.sw, { kind: 'sw', x: 100, y: 154, w: 16, h: 16 }, '左下の角');
    assert.deepEqual(by.n, { kind: 'n', x: 192, y: 50, w: 16, h: 16 }, '上の辺の中央');
    assert.deepEqual(by.e, { kind: 'e', x: 284, y: 102, w: 16, h: 16 }, '右の辺の中央');
    assert.deepEqual(by.s, { kind: 's', x: 192, y: 154, w: 16, h: 16 }, '下の辺の中央');
    assert.deepEqual(by.w, { kind: 'w', x: 100, y: 102, w: 16, h: 16 }, '左の辺の中央');
    for (const i of ics) {
      assert.ok(i.x >= r.x && i.y >= r.y && i.x + i.w <= r.x + r.w && i.y + i.h <= r.y + r.h, `${i.kind} は範囲の内側`);
    }
  });

  await t.test('cropIconRects — 範囲が画像全体でも、8 個すべてが画像内に収まる', () => {
    const whole = { x: 0, y: 0, w: 400, h: 300 };
    for (const i of plain(T.cropIconRects(whole, 16))) {
      assert.ok(i.x >= 0 && i.y >= 0 && i.x + i.w <= 400 && i.y + i.h <= 300, `${i.kind} は画像内`);
    }
  });

  await t.test('hitCropIcon — □ の上下左右を pad ずつ広げた所まで当たる', () => {
    assert.equal(T.hitCropIcon(r, { x: 100, y: 50 }, 16, 8), 'nw', '範囲の角');
    assert.equal(T.hitCropIcon(r, { x: 92, y: 42 }, 16, 8), 'nw', '範囲の外へ 8px まで当たる');
    assert.equal(T.hitCropIcon(r, { x: 91, y: 50 }, 16, 8), null, '9px 外は当たらない');
    assert.equal(T.hitCropIcon(r, { x: 123, y: 73 }, 16, 8), 'nw', '範囲の内側へ □＋8px まで当たる');
    assert.equal(T.hitCropIcon(r, { x: 200, y: 58 }, 16, 8), 'n', '上の辺の □ の中心');
    assert.equal(T.hitCropIcon(r, { x: 296, y: 110 }, 16, 8), 'e', '右の辺の □');
    assert.equal(T.hitCropIcon(r, { x: 200, y: 110 }, 16, 8), null, '範囲の中ほどは □ が無い');
  });

  await t.test('hitCropIcon — 範囲が小さく □ が重なる時は四隅を優先し、同じ種類は □ の中心が近い方', () => {
    const tiny = { x: 0, y: 0, w: 20, h: 20 };
    assert.equal(T.hitCropIcon(tiny, { x: 1, y: 1 }, 16, 8), 'nw');
    assert.equal(T.hitCropIcon(tiny, { x: 19, y: 19 }, 16, 8), 'se');
    // (11,1) は上の辺の □ の中心 (10,8) にも近いが、四隅が優先される
    assert.equal(T.hitCropIcon(tiny, { x: 11, y: 1 }, 16, 8), 'ne');
    assert.equal(T.hitCropIcon(tiny, { x: 1, y: 19 }, 16, 8), 'sw');
  });
});

test('cropdrag — 押した所で決まるドラッグの種類とカーソル（仕様 25章）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const W = 400, H = 300;
  const mode = (rect, x, y) => T.cropDragMode(rect, W, H, { x, y }, 16, 8);

  await t.test('cropIsWhole — 範囲が画像全体か（画素に丸めて比べる）', () => {
    assert.equal(T.cropIsWhole({ x: 0, y: 0, w: 400, h: 300 }, W, H), true);
    assert.equal(T.cropIsWhole({ x: 0.3, y: 0, w: 400.2, h: 299.6 }, W, H), true, '丸めると画像全体');
    assert.equal(T.cropIsWhole({ x: 1, y: 0, w: 399, h: 300 }, W, H), false);
    assert.equal(T.cropIsWhole(null, W, H), false);
  });

  await t.test('範囲が画像全体の時（［トリミング］を押した直後）は、境界アイコン以外のどこでも新しい範囲を描く', () => {
    const whole = { x: 0, y: 0, w: W, h: H };
    assert.equal(mode(whole, 200, 150), 'new', '画像の中央');
    assert.equal(mode(whole, 60, 200), 'new');
    assert.equal(mode(whole, 4, 4), 'nw', '左上の境界アイコンは大きさを変える');
    assert.equal(mode(whole, 200, 8), 'n', '上の辺の境界アイコン');
    assert.equal(mode(whole, 396, 296), 'se', '右下の境界アイコン');
  });

  await t.test('範囲を決めた後は、外側から新しい範囲・内側は範囲を動かす・境界アイコンは大きさを変える', () => {
    const r = { x: 100, y: 50, w: 200, h: 120 };
    assert.equal(mode(r, 200, 110), 'move', '範囲の内側（質問 Q1 の推奨案）');
    assert.equal(mode(r, 50, 30), 'new', '範囲の外側（暗い所）');
    assert.equal(mode(r, 350, 250), 'new', '範囲の外側（右下）');
    assert.equal(mode(r, 100, 50), 'nw', '左上の角');
    assert.equal(mode(r, 96, 110), 'w', '左の辺の □ は範囲の外へ 8px まで当たる');
  });

  await t.test('cropCursor — 新しい範囲は十字・境界アイコンは向きに合った矢印・内側は移動', () => {
    assert.equal(T.cropCursor('new'), 'crosshair');
    assert.equal(T.cropCursor('move'), 'move');
    assert.equal(T.cropCursor('nw'), 'nwse-resize');
    assert.equal(T.cropCursor('se'), 'nwse-resize');
    assert.equal(T.cropCursor('ne'), 'nesw-resize');
    assert.equal(T.cropCursor('sw'), 'nesw-resize');
    assert.equal(T.cropCursor('n'), 'ns-resize');
    assert.equal(T.cropCursor('s'), 'ns-resize');
    assert.equal(T.cropCursor('e'), 'ew-resize');
    assert.equal(T.cropCursor('w'), 'ew-resize');
    assert.equal(T.cropCursor(null), '');
  });
});

test('cropdrag — ドラッグ中と離した時のトリミング範囲（仕様 25章）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const W = 400, H = 300;
  const r = { x: 100, y: 50, w: 200, h: 120 };
  const drag = (mode, sx, sy, x, y) => plain(T.cropDragRect({ mode, sx, sy, rect: { ...r } }, { x, y }, W, H));

  await t.test('new — 押した所から今の所までの長方形（向きによらず正規化）', () => {
    assert.deepEqual(drag('new', 50, 40, 150, 100), { x: 50, y: 40, w: 100, h: 60 });
    assert.deepEqual(drag('new', 150, 100, 50, 40), { x: 50, y: 40, w: 100, h: 60 }, '右下から左上へ引いても同じ');
  });

  await t.test('new — 画像の外までドラッグしても、画像の端で止まる', () => {
    assert.deepEqual(drag('new', 50, 40, -30, 500), { x: 0, y: 40, w: 50, h: 260 });
    assert.deepEqual(drag('new', 380, 10, 999, -50), { x: 380, y: 0, w: 20, h: 10 });
  });

  await t.test('move — 範囲を平行移動し、画像の外へは出さない', () => {
    assert.deepEqual(drag('move', 200, 100, 230, 90), { x: 130, y: 40, w: 200, h: 120 });
    assert.deepEqual(drag('move', 200, 100, 900, -200), { x: 200, y: 0, w: 200, h: 120 });
  });

  await t.test('境界アイコン — 変更前と同じく大きさを変える（最小 10px・画像内）', () => {
    assert.deepEqual(drag('se', 300, 170, 350, 200), { x: 100, y: 50, w: 250, h: 150 });
    assert.deepEqual(drag('se', 300, 170, 1000, 1000), { x: 100, y: 50, w: 300, h: 250 }, '画像の端で止まる');
    assert.deepEqual(drag('w', 100, 110, 600, 110), { x: 290, y: 50, w: 10, h: 120 }, '最小幅 10px');
    assert.deepEqual(drag('n', 200, 50, 200, -40), { x: 100, y: 0, w: 200, h: 170 }, '上の辺だけ動く');
  });

  await t.test('cropDragEndRect — 新しい範囲の幅か高さが 10px に満たなければ、ドラッグ前の範囲に戻す', () => {
    const end = (mode, rect) => plain(T.cropDragEndRect({ mode, rect: { ...r } }, rect));
    assert.deepEqual(end('new', { x: 0, y: 0, w: 9, h: 50 }), r, '幅が 9px');
    assert.deepEqual(end('new', { x: 0, y: 0, w: 50, h: 9.5 }), r, '高さが 9.5px');
    assert.deepEqual(end('new', { x: 0, y: 0, w: 0, h: 0 }), r, 'クリックだけ');
    assert.deepEqual(end('new', { x: 5, y: 6, w: 10, h: 10 }), { x: 5, y: 6, w: 10, h: 10 }, '10px ちょうどは決まる');
    assert.deepEqual(end('move', { x: 1, y: 2, w: 200, h: 120 }), { x: 1, y: 2, w: 200, h: 120 }, '移動はそのまま');
    assert.deepEqual(end('se', { x: 100, y: 50, w: 250, h: 150 }), { x: 100, y: 50, w: 250, h: 150 });
  });
});
