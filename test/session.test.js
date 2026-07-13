'use strict';
// session.js（録画セッション形式 2-R1）の単体テスト。
// Electron 不要の純粋な fs モジュールなので、一時フォルダで直接テストする。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../session');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // 中身は問わない（PNGヘッダ断片）

test('session.js — 録画セッション形式', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'clm-session-'));
  t.after(() => {
    session.endSession(); // テスト失敗時にモジュール状態を残さない
    fs.rmSync(parent, { recursive: true, force: true });
  });

  await t.test('startSession が <名前>_<yyyymmdd>_<hhmmss> フォルダと session.json を作る', () => {
    const { dir } = session.startSession('点検', parent, { now: new Date(2026, 6, 13, 9, 5, 7).getTime() });
    assert.equal(path.basename(dir), '点検_20260713_090507');
    assert.equal(session.isActive(), true);
    assert.equal(session.sessionDir(), dir);
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    assert.equal(info.type, 'checklistmaker-recording');
    assert.equal(info.name, '点検');
    assert.equal(info.endedAt, null);
    assert.equal(info.shots, 0);
    session.endSession();
  });

  await t.test('同名フォルダがあれば _2, _3… で衝突を回避する', () => {
    const now = new Date(2026, 6, 13, 10, 0, 0).getTime();
    fs.mkdirSync(path.join(parent, '点検_20260713_100000'));
    fs.mkdirSync(path.join(parent, '点検_20260713_100000_2'));
    const { dir } = session.startSession('点検', parent, { now });
    assert.equal(path.basename(dir), '点検_20260713_100000_3');
    session.endSession();
  });

  await t.test('recordShot が連番の PNG とサイドカー JSON を併記する', () => {
    const start = new Date(2026, 6, 13, 11, 0, 0).getTime();
    const { dir } = session.startSession('記録', parent, { now: start });

    const r1 = session.recordShot(PNG, {
      now: start + 1500,
      button: 'left',
      clicks: 1,
      x: 2418,
      y: 507,
      imagePoint: { x: 498, y: 507 },
      display: { id: 7, boundsDip: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      marker: { drawn: true, x: 498, y: 507, radius: 20, lineWidth: 4, color: '#ef4444' },
      capture: { source: 'precapture' },
    });
    assert.equal(r1.fileName, '001.png');
    assert.equal(r1.seq, 1);
    assert.deepEqual(fs.readFileSync(path.join(dir, '001.png')), PNG);

    const sc = JSON.parse(fs.readFileSync(path.join(dir, '001.json'), 'utf8'));
    assert.equal(sc.version, 2);
    assert.equal(sc.seq, 1);
    assert.equal(sc.image, '001.png');
    assert.equal(sc.elapsedMs, 1500);
    assert.deepEqual(sc.click, { button: 'left', clicks: 1, x: 2418, y: 507 });
    assert.deepEqual(sc.imagePoint, { x: 498, y: 507 });
    assert.equal(sc.display.scaleFactor, 1);
    assert.equal(sc.marker.drawn, true);
    assert.equal(sc.capture.source, 'precapture');
    // uia / text 未指定（解決なし）は雛形と null（2-R2）
    assert.equal(sc.text, null);
    assert.deepEqual(sc.uia, {
      resolved: false, name: null, controlType: null, rect: null, windowTitle: null, appName: null,
    });

    // 2枚目はゼロ埋め連番で、session.json の shots も追随する。
    // UIA 解決結果と生成文（2-R2）はそのまま記録される。
    const uiaInfo = {
      resolved: true, name: '保存', controlType: 'Button', localizedType: 'ボタン',
      className: 'X', frameworkId: 'Win32', rect: [1, 2, 3, 4],
      windowTitle: '文書 1 - Word', appName: 'WINWORD.EXE', elapsedMs: 24,
    };
    const r2 = session.recordShot(PNG, {
      now: start + 3000, button: 'right', text: '「保存」を右クリック', uia: uiaInfo,
    });
    assert.equal(r2.fileName, '002.png');
    const sc2 = JSON.parse(fs.readFileSync(path.join(dir, '002.json'), 'utf8'));
    assert.equal(sc2.click.button, 'right');
    assert.equal(sc2.click.clicks, null, '未指定の項目は null で記録される');
    assert.equal(sc2.marker.drawn, false, 'marker 未指定は drawn:false');
    assert.equal(sc2.text, '「保存」を右クリック');
    assert.deepEqual(sc2.uia, uiaInfo);
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    assert.equal(info.shots, 2);

    const ended = session.endSession({ now: start + 10000 });
    assert.deepEqual(ended, { dir, shots: 2, removed: false });
    const fin = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    assert.equal(fin.endedAt, new Date(start + 10000).toISOString());
    assert.equal(session.isActive(), false);
  });

  await t.test('1枚も撮らずに終了したら空フォルダごと削除される', () => {
    const { dir } = session.startSession('空', parent);
    const ended = session.endSession();
    assert.deepEqual(ended, { dir, shots: 0, removed: true });
    assert.equal(fs.existsSync(dir), false);
  });

  await t.test('セッション未開始の recordShot は throw、endSession は null', () => {
    assert.throws(() => session.recordShot(PNG, {}));
    assert.equal(session.endSession(), null);
    assert.equal(session.sessionDir(), null);
  });
});
