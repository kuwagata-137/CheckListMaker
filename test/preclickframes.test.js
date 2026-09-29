'use strict';
// preclick-frames.js（クリック直前キャプチャのフレーム選び 2026-09-29 / v1.0.8 作業2）の単体テスト。
// 仕様は docs/spec-preclick-capture.md 参照。

const test = require('node:test');
const assert = require('node:assert/strict');
const { tickDiff, pickFrameBefore, fillAlpha, ringSizeFor, nextCaptureDelay } = require('../preclick-frames');

// モニタの矩形（物理 px）と、撮影の開始・撮り終えの時刻（GetTickCount の ms）を持つ1枚
const MON_A = { x: 0, y: 0, w: 1920, h: 1080 };
const MON_B = { x: 1920, y: 0, w: 2560, h: 1440 };
const f = (id, start, end, rect = MON_A) => ({ id, start, end, rect });

test('tickDiff — 32bit のティックの差（一周をまたいでも符号付きで正しい）', () => {
  assert.equal(tickDiff(1500, 1000), 500);
  assert.equal(tickDiff(1000, 1500), -500);
  assert.equal(tickDiff(100, 0xffffff00), 356, '一周（約49.7日）をまたいだ直後');
  assert.equal(tickDiff(0xffffff00, 100), -356);
});

test('pickFrameBefore — イベントより前に撮り終えた最新の1枚', async (t) => {
  const frames = [f(1, 1000, 1040), f(2, 1100, 1140), f(3, 1200, 1240)];

  await t.test('撮り終えがイベント以前のうち、いちばん新しいもの', () => {
    assert.equal(pickFrameBefore(frames, 1250, 10, 10).id, 3);
    assert.equal(pickFrameBefore(frames, 1239, 10, 10).id, 2, '撮影中（開始はイベント前・撮り終えは後）の1枚は使わない');
    assert.equal(pickFrameBefore(frames, 1240, 10, 10).id, 3, '撮り終えとイベントが同じ時刻なら使う');
  });
  await t.test('並び順に依らない（リングの書き込み位置が回っていても）', () => {
    const ring = [f(3, 1200, 1240), f(1, 1000, 1040), f(2, 1100, 1140)];
    assert.equal(pickFrameBefore(ring, 1150, 10, 10).id, 2);
  });
  await t.test('イベントより前の1枚が無ければ null（その場で撮る）', () => {
    assert.equal(pickFrameBefore(frames, 1030, 10, 10), null);
    assert.equal(pickFrameBefore([], 1030, 10, 10), null);
    assert.equal(pickFrameBefore(null, 1030, 10, 10), null);
  });
  await t.test('撮り終えから maxAge（既定 1000ms）を超えた古い1枚は使わない', () => {
    assert.equal(pickFrameBefore(frames, 2240, 10, 10).id, 3, 'ちょうど 1000ms 前は使う');
    assert.equal(pickFrameBefore(frames, 2241, 10, 10), null, '撮影が止まっていたときの古い画面は使わない');
    assert.equal(pickFrameBefore(frames, 1600, 10, 10, 300), null, 'maxAge を指定できる');
  });
  await t.test('イベントの座標がそのモニタの中にある1枚だけ', () => {
    const mixed = [f(1, 1000, 1040, MON_A), f(2, 1100, 1140, MON_B)];
    assert.equal(pickFrameBefore(mixed, 1200, 100, 100).id, 1, 'モニタ A のクリックは A の1枚');
    assert.equal(pickFrameBefore(mixed, 1200, 2000, 100).id, 2, 'モニタ B のクリックは B の1枚');
    assert.equal(pickFrameBefore(mixed, 1200, 5000, 100), null, 'どのモニタでもない');
    assert.equal(pickFrameBefore(mixed, 1200, 1920, 0).id, 2, '左上の端は含む');
    assert.equal(pickFrameBefore(mixed, 1200, 1919, 1079).id, 1, '右下の端（幅−1）は含む');
  });
  await t.test('ティックが一周をまたいでも選べる', () => {
    const wrap = [f(1, 0xffffff00, 0xffffff28), f(2, 30, 70)];
    assert.equal(pickFrameBefore(wrap, 80, 10, 10).id, 2);
    assert.equal(pickFrameBefore(wrap, 50, 10, 10).id, 1);
  });
});

test('fillAlpha — BGRA のアルファ（4バイトごと）を 255 に埋める', () => {
  const b = Buffer.from([10, 20, 30, 0, 40, 50, 60, 0, 70, 80, 90, 7]);
  assert.equal(fillAlpha(b), b, 'その場で書き換えて同じバッファを返す');
  assert.deepEqual([...b], [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
});

test('ringSizeFor — 合計 64MB 以内・2〜5枚', () => {
  assert.equal(ringSizeFor(1920, 1080), 5, '1920×1080（約 8MB）は5枚');
  assert.equal(ringSizeFor(2560, 1440), 4, '2560×1440（約 14MB）は4枚');
  assert.equal(ringSizeFor(3840, 2160), 2, '4K（約 33MB）は2枚（下限）');
  assert.equal(ringSizeFor(7680, 4320), 2, '8K でも2枚');
  assert.equal(ringSizeFor(0, 0), 2, '壊れた入力でも2枚');
});

test('nextCaptureDelay — 間隔 100ms を守り、撮影が長いときは最低 30ms 休む', () => {
  assert.equal(nextCaptureDelay(40), 60, '40ms かかったら次は 60ms 後（100ms ごと）');
  assert.equal(nextCaptureDelay(95), 30, '間隔を使い切っても最低 30ms 休む');
  assert.equal(nextCaptureDelay(160), 30, '4K などで長くても 30ms 休む（間隔が延びる）');
  assert.equal(nextCaptureDelay(NaN), 100, '壊れた入力は間隔どおり');
});
