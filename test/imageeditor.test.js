// 画像編集エディタの図形ジオメトリ（純関数）のテスト。
// jsdom に canvas が無いためエディタ画面そのものは開かず、
// クロージャ外に切り出した純関数だけを検証する。
// 仕様は docs/spec-image-editor-enhancements.md 参照。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));

test('imageeditor — 図形ジオメトリ（8ハンドル・フリーフォーム・線分距離）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('objHandles — rect/ellipse/cross は四つ角＋各辺中点の8か所', () => {
    for (const type of ['rect', 'ellipse', 'cross']) {
      const hs = plain(T.objHandles({ type, x: 10, y: 20, w: 100, h: 60 }));
      assert.equal(hs.length, 8, `${type} は8ハンドル`);
      const byKind = Object.fromEntries(hs.map((h) => [h.kind, h]));
      assert.deepEqual(byKind.nw, { kind: 'nw', x: 10, y: 20 });
      assert.deepEqual(byKind.n, { kind: 'n', x: 60, y: 20 }, '上辺の中点');
      assert.deepEqual(byKind.e, { kind: 'e', x: 110, y: 50 }, '右辺の中点');
      assert.deepEqual(byKind.s, { kind: 's', x: 60, y: 80 }, '下辺の中点');
      assert.deepEqual(byKind.w, { kind: 'w', x: 10, y: 50 }, '左辺の中点');
      assert.deepEqual(byKind.se, { kind: 'se', x: 110, y: 80 });
    }
  });

  await t.test('objHandles — 線は端点のみ・freeform は頂点ごと・text は無し', () => {
    assert.equal(plain(T.objHandles({ type: 'line', x1: 0, y1: 0, x2: 9, y2: 9 })).length, 2);
    const ff = plain(T.objHandles({ type: 'freeform', pts: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 0 }] }));
    assert.deepEqual(ff.map((h) => h.kind), ['pt0', 'pt1', 'pt2']);
    assert.deepEqual(plain(T.objHandles({ type: 'text', x: 0, y: 0 })), []);
  });

  await t.test('applyObjDrag — 辺中点は縦のみ／横のみのリサイズ', () => {
    const drag = (mode, dx, dy) => {
      const obj = { type: 'rect', x: 10, y: 20, w: 100, h: 60 };
      T.applyObjDrag({ mode, obj, sx: 0, sy: 0, orig: { ...obj } }, { x: dx, y: dy });
      return plain(obj);
    };
    assert.deepEqual(drag('e', 30, 999), { type: 'rect', x: 10, y: 20, w: 130, h: 60 }, 'e は横だけ伸びる');
    assert.deepEqual(drag('w', 30, 999), { type: 'rect', x: 40, y: 20, w: 70, h: 60 }, 'w は左辺だけ動く');
    assert.deepEqual(drag('n', 999, 10), { type: 'rect', x: 10, y: 30, w: 100, h: 50 }, 'n は上辺だけ動く');
    assert.deepEqual(drag('s', 999, -10), { type: 'rect', x: 10, y: 20, w: 100, h: 50 }, 's は下辺だけ動く');
    assert.deepEqual(drag('se', 10, 10), { type: 'rect', x: 10, y: 20, w: 110, h: 70 }, '四隅は従来どおり両方向');
    const tiny = drag('e', -200, 0);
    assert.equal(tiny.w, 4, '最小サイズ4pxを割らない');
  });

  await t.test('applyObjDrag — freeform の移動と頂点の個別変形', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const obj = { type: 'freeform', pts: plain(pts), closed: true };
    T.applyObjDrag({ mode: 'move', obj, sx: 0, sy: 0, orig: { ...obj, pts: plain(pts) } }, { x: 5, y: 7 });
    assert.deepEqual(plain(obj.pts), [{ x: 5, y: 7 }, { x: 15, y: 7 }, { x: 15, y: 17 }], '全頂点が平行移動');
    T.applyObjDrag({ mode: 'pt1', obj, sx: 0, sy: 0, orig: { ...obj, pts: plain(obj.pts) } }, { x: -1, y: 2 });
    assert.deepEqual(plain(obj.pts[1]), { x: 14, y: 9 }, '指定頂点だけ動く');
    assert.deepEqual(plain(obj.pts[0]), { x: 5, y: 7 }, '他の頂点は動かない');
  });

  await t.test('freeformBounds — 外接矩形と不正入力', () => {
    assert.deepEqual(
      plain(T.freeformBounds([{ x: 3, y: 9 }, { x: -2, y: 4 }, { x: 7, y: 5 }])),
      { x: -2, y: 4, w: 9, h: 5 }
    );
    assert.deepEqual(plain(T.freeformBounds([])), { x: 0, y: 0, w: 0, h: 0 });
    assert.deepEqual(plain(T.freeformBounds(null)), { x: 0, y: 0, w: 0, h: 0 });
  });

  await t.test('distSeg — 線分への距離（cross・freeform のヒットテストの土台）', () => {
    assert.equal(T.distSeg({ x: 5, y: 3 }, 0, 0, 10, 0), 3, '線分の中ほどは垂線距離');
    assert.equal(T.distSeg({ x: -4, y: 3 }, 0, 0, 10, 0), 5, '端の外側は端点距離');
    assert.equal(T.distSeg({ x: 1, y: 1 }, 2, 2, 2, 2), Math.hypot(1, 1), '長さ0の線分は点距離');
  });
});
