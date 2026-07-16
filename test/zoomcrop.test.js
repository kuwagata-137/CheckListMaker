'use strict';
// zoomcrop.js（要素矩形ベースの自動ズーム＋枠ハイライト 2-R3）の単体テスト。
// 純関数のため、採用基準の分岐と切り出し範囲の境界を表で検証する。
// 基準・数値は docs/spec-2-R3-zoom-highlight.md 参照。

const test = require('node:test');
const assert = require('node:assert/strict');
const { planShot } = require('../zoomcrop');

const IMG = { w: 1920, h: 1080 };
const ORIGIN = { x: 0, y: 0 };

// 解決済みの UIA（steptext.normalizeUia 後の形）を作る
function uiaOf(over = {}) {
  return {
    resolved: true,
    name: '保存',
    controlType: 'Button',
    rect: [1200, 640, 100, 40], // 画面物理px [l,t,w,h]
    windowTitle: '文書 1 - Word',
    appName: 'WINWORD.EXE',
    ...over,
  };
}
function plan(over = {}, extra = {}) {
  return planShot({
    uia: uiaOf(over),
    click: { x: 1230, y: 660 },
    imageSize: IMG,
    displayOrigin: ORIGIN,
    scale: 1,
    ...extra,
  });
}

test('planShot — 要素矩形の採用と枠・ズーム範囲', async (t) => {
  await t.test('採用時: element / 枠(PAD 6) / ズーム(余白48＋最小480×320＋案A 1.5倍 中心維持)', () => {
    const p = plan();
    assert.deepEqual(p.element, [1200, 640, 100, 40]);
    assert.deepEqual(p.frame, [1194, 634, 112, 52]);
    // 100×40 → 余白込み 196×136 → 最小 480×320 → 案A で中心維持 1.5倍 = 720×480
    assert.deepEqual(p.zoom, { rect: [890, 420, 720, 480], source: 'element' });
  });

  await t.test('displayOrigin（右側ディスプレイ等）は画像座標へ換算される', () => {
    const p = planShot({
      uia: uiaOf({ rect: [3120, 640, 100, 40] }),
      click: { x: 1230, y: 660 },
      imageSize: IMG,
      displayOrigin: { x: 1920, y: 0 },
      scale: 1,
    });
    assert.deepEqual(p.element, [1200, 640, 100, 40]);
  });

  await t.test('大きい要素は余白48のみ（最小サイズなし）＋案A 1.5倍', () => {
    const p = plan({ rect: [600, 300, 600, 400] }, { click: { x: 900, y: 500 } });
    // 余白込み 696×496（中心 900,500）→ 案A 1.5倍 = 1044×744
    assert.deepEqual(p.zoom.rect, [378, 128, 1044, 744]);
  });

  await t.test('画面端の要素は枠もズームも画像内へクランプされる', () => {
    // 横いっぱいのツールバー（幅だけ 90% 以上は正当なので採用される）
    const p = plan({ rect: [0, 0, 1920, 60] }, { click: { x: 500, y: 30 } });
    assert.deepEqual(p.element, [0, 0, 1920, 60]);
    assert.deepEqual(p.frame, [0, 0, 1920, 72]);
    // 余白＋最小で 1920×320 → 案A 1.5倍で高さ 480（幅は画像幅でクランプ）
    assert.deepEqual(p.zoom.rect, [0, 0, 1920, 480]);
  });

  await t.test('画像からはみ出す要素は重なり部分だけ採用される', () => {
    const p = plan({ rect: [-50, 500, 100, 40] }, { click: { x: 20, y: 510 } });
    assert.deepEqual(p.element, [0, 500, 50, 40]);
  });

  await t.test('scaleFactor は余白・最小サイズ・PAD に効く', () => {
    const p = planShot({
      uia: uiaOf({ rect: [1200, 640, 100, 40] }),
      click: { x: 1230, y: 660 },
      imageSize: { w: 3840, h: 2160 },
      displayOrigin: ORIGIN,
      scale: 2,
    });
    assert.deepEqual(p.frame, [1188, 628, 124, 64]); // PAD 6×2
    // 最小 480×320 ×scale2 = 960×640 → 案A 1.5倍 = 1440×960
    assert.deepEqual(p.zoom.rect, [530, 180, 1440, 960]);
  });
});

test('planShot — 不採用（クリック中心フォールバック）の条件', async (t) => {
  // click(1230,660) 中心の 480×320 → 案A 1.5倍 = 720×480
  const FALLBACK = { rect: [870, 420, 720, 480], source: 'click' };

  await t.test('未解決（resolved:false）はフォールバック', () => {
    const p = plan({ resolved: false, rect: null });
    assert.equal(p.element, null);
    assert.equal(p.frame, null);
    assert.deepEqual(p.zoom, FALLBACK);
  });

  await t.test('コンテナ系（Window/Pane/Document/TitleBar）はフォールバック', () => {
    for (const type of ['Window', 'Pane', 'Document', 'TitleBar']) {
      const p = plan({ controlType: type });
      assert.equal(p.element, null, `ControlType=${type}`);
      assert.equal(p.zoom.source, 'click');
    }
  });

  await t.test('矩形なし・幅高さ0はフォールバック', () => {
    assert.equal(plan({ rect: null }).element, null);
    assert.equal(plan({ rect: [10, 10, 0, 40] }).element, null);
    assert.equal(plan({ rect: [10, 10, 100, -1] }).element, null);
  });

  await t.test('クリック点が矩形の外（許容4px 超）はフォールバック', () => {
    // rect の左端は x=1200。許容内(1196)は採用・許容外(1195)は不採用
    assert.notEqual(plan({}, { click: { x: 1196, y: 660 } }).element, null);
    assert.equal(plan({}, { click: { x: 1195, y: 660 } }).element, null);
  });

  await t.test('幅・高さの両方が画像の90%以上（画面ほぼ全体）はフォールバック', () => {
    const p = plan({ rect: [0, 0, 1920, 1080] }, { click: { x: 960, y: 540 } });
    assert.equal(p.element, null);
    assert.equal(p.zoom.source, 'click');
  });

  await t.test('フォールバックの切り出しは画像端でクランプされる（案A 1.5倍後もクランプ）', () => {
    const p = plan({ resolved: false }, { click: { x: 1900, y: 1060 } });
    assert.deepEqual(p.zoom.rect, [1200, 600, 720, 480]);
    const q = plan({ resolved: false }, { click: { x: 10, y: 10 } });
    assert.deepEqual(q.zoom.rect, [0, 0, 720, 480]);
  });

  await t.test('画像サイズ不明なら計画なし（zoom も null）', () => {
    const p = plan({}, { imageSize: null });
    assert.deepEqual(p, { element: null, frame: null, zoom: null });
  });
});
