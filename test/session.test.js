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
    assert.equal(sc.version, 4);
    assert.equal(sc.kind, 'click'); // kind 省略の既定はクリック（2-R2b）
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
    // zoom 未指定（生成なし）は null で、NNNz.png も書かれない（2-R3）
    assert.equal(sc.zoom, null);
    assert.equal(fs.existsSync(path.join(dir, '001z.png')), false);

    // 2枚目はゼロ埋め連番で、session.json の shots も追随する。
    // UIA 解決結果と生成文（2-R2）はそのまま記録される。
    const uiaInfo = {
      resolved: true, name: '保存', controlType: 'Button', localizedType: 'ボタン',
      className: 'X', frameworkId: 'Win32', rect: [1, 2, 3, 4],
      windowTitle: '文書 1 - Word', appName: 'WINWORD.EXE', elapsedMs: 24,
    };
    const ZOOM_PNG = Buffer.from('89504e470d0a1a0a00', 'hex');
    const r2 = session.recordShot(PNG, {
      now: start + 3000, button: 'right', text: '「保存」を右クリック', uia: uiaInfo,
      zoom: { png: ZOOM_PNG, rect: [1010, 500, 480, 320], source: 'element' },
    });
    assert.equal(r2.fileName, '002.png');
    const sc2 = JSON.parse(fs.readFileSync(path.join(dir, '002.json'), 'utf8'));
    assert.equal(sc2.click.button, 'right');
    assert.equal(sc2.click.clicks, null, '未指定の項目は null で記録される');
    assert.equal(sc2.marker.drawn, false, 'marker 未指定は drawn:false');
    assert.equal(sc2.text, '「保存」を右クリック');
    assert.deepEqual(sc2.uia, uiaInfo);
    // 拡大画像（2-R3）: NNNz.png が書かれ、サイドカーに範囲と根拠が記録される
    assert.deepEqual(fs.readFileSync(path.join(dir, '002z.png')), ZOOM_PNG);
    assert.deepEqual(sc2.zoom, { image: '002z.png', rect: [1010, 500, 480, 320], source: 'element' });
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

test('session.js — 取り込みウィザード用の一覧・読み込み・マーク（2-R4）', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'clm-import-'));
  t.after(() => {
    session.endSession();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  // 素材: 完了セッション（2枚・うち1枚は拡大とサイドカー付き）と未完了セッション
  const t1 = new Date(2026, 6, 13, 9, 0, 0).getTime();
  const t2 = new Date(2026, 6, 13, 10, 0, 0).getTime();
  const s1 = session.startSession('点検', parent, { now: t1 });
  session.recordShot(PNG, { now: t1 + 1000, text: '「保存」ボタンをクリック',
    zoom: { png: PNG, rect: [0, 0, 480, 320], source: 'element' } });
  session.recordShot(PNG, { now: t1 + 2000 });
  session.endSession({ now: t1 + 5000 });
  const s2 = session.startSession('作業', parent, { now: t2 });
  session.recordShot(PNG, { now: t2 + 1000 });
  // s2 はあえて endSession しない（異常終了＝endedAt null の再現。t.after が後始末する）

  await t.test('listSessions — 新しい順・未完了(endedAt null)も列挙・非セッションは無視', () => {
    fs.mkdirSync(path.join(parent, 'ただのフォルダ'));
    fs.writeFileSync(path.join(parent, 'ただのファイル.png'), PNG);
    const list = session.listSessions(parent);
    assert.equal(list.length, 2);
    assert.equal(list[0].dir, s2.dir, '新しい順');
    assert.equal(list[0].name, '作業');
    assert.equal(list[0].endedAt, null, '未完了の痕跡が読める');
    assert.equal(list[1].name, '点検');
    assert.equal(list[1].shots, 2);
    assert.equal(list[1].importedAt, null);
    assert.deepEqual(session.listSessions(path.join(parent, '存在しない')), [], '失敗は空配列');
  });

  await t.test('readSession — 画像スキャン＋サイドカー併読（欠落は最小情報）', () => {
    const data = session.readSession(s1.dir);
    assert.equal(data.info.name, '点検');
    assert.equal(data.steps.length, 2);
    assert.deepEqual(
      data.steps[0],
      {
        seq: 1, kind: 'click', image: '001.png', zoomImage: '001z.png', zoomSource: 'element',
        text: '「保存」ボタンをクリック',
        uia: { resolved: false, name: null, controlType: null, rect: null, windowTitle: null, appName: null },
        click: { button: null, clicks: null, x: null, y: null },
        time: data.steps[0].time,
        keys: null, drag: null, appChange: null, // 2-R2b（クリックのみのセッションは全て null）
      }
    );
    assert.equal(data.steps[1].zoomImage, null);
    // サイドカーを消しても画像があればステップとして拾える
    fs.rmSync(path.join(s1.dir, '002.json'));
    const again = session.readSession(s1.dir);
    assert.equal(again.steps.length, 2);
    assert.equal(again.steps[1].text, null);
    assert.equal(again.steps[1].seq, 2);
    assert.equal(session.readSession(path.join(parent, 'ただのフォルダ')), null, 'session.json なしは null');
  });

  await t.test('markImported — importedAt を記録し他フィールドは保持する', () => {
    const now = new Date(2026, 6, 13, 12, 0, 0).getTime();
    assert.equal(session.markImported(s1.dir, { now }), true);
    const info = JSON.parse(fs.readFileSync(path.join(s1.dir, 'session.json'), 'utf8'));
    assert.equal(info.importedAt, new Date(now).toISOString());
    assert.equal(info.name, '点検');
    assert.equal(info.shots, 2);
    assert.ok(info.endedAt, 'endedAt は保持される');
    const list = session.listSessions(parent);
    assert.ok(list.find((s) => s.dir === s1.dir).importedAt, '一覧にも反映される');
    assert.equal(session.markImported(path.join(parent, 'ただのフォルダ')), false, '非セッションは false');
  });
});

// ── 2-R2b: サイドカー v4（kind / keys / drag / appChange / amendLastShot）──────
test('session.js — 操作種類の拡張（2-R2b）', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'clm-session-r2b-'));
  t.after(() => {
    session.endSession();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  await t.test('input / key ステップの kind と keys が記録される（内容は持たない）', () => {
    const { dir } = session.startSession('入力', parent);
    session.recordShot(PNG, { kind: 'input', keys: { type: 'input', enter: true }, text: '「ファイル名」欄に入力して Enter' });
    session.recordShot(PNG, { kind: 'key', keys: { type: 'shortcut', combo: 'Ctrl+S' }, text: 'Ctrl+S で保存' });
    const sc1 = JSON.parse(fs.readFileSync(path.join(dir, '001.json'), 'utf8'));
    assert.equal(sc1.kind, 'input');
    assert.deepEqual(sc1.keys, { type: 'input', enter: true });
    assert.deepEqual(sc1.click, { button: null, clicks: null, x: null, y: null });
    const sc2 = JSON.parse(fs.readFileSync(path.join(dir, '002.json'), 'utf8'));
    assert.equal(sc2.kind, 'key');
    assert.deepEqual(sc2.keys, { type: 'shortcut', combo: 'Ctrl+S' });
    session.endSession();
  });

  await t.test('drag ステップが終点画像 NNNe.png を書き、サイドカーに終点情報を持つ', () => {
    const { dir } = session.startSession('ドラッグ', parent);
    const END = Buffer.from('89504e470d0a1a0b', 'hex');
    session.recordShot(PNG, {
      kind: 'drag',
      text: '「A」から「B」へドラッグ',
      drag: {
        from: { x: 10, y: 20 },
        to: { x: 300, y: 400 },
        endPng: END,
        endImagePoint: { x: 290, y: 380 },
        endMarker: { drawn: true, shape: 'circle', x: 290, y: 380 },
        endUia: { resolved: true, name: 'B' },
      },
    });
    assert.deepEqual(fs.readFileSync(path.join(dir, '001e.png')), END);
    const sc = JSON.parse(fs.readFileSync(path.join(dir, '001.json'), 'utf8'));
    assert.equal(sc.kind, 'drag');
    assert.equal(sc.drag.endImage, '001e.png');
    assert.deepEqual(sc.drag.from, { x: 10, y: 20 });
    assert.deepEqual(sc.drag.to, { x: 300, y: 400 });
    assert.equal(sc.drag.endUia.name, 'B');
    // readSession が drag を透過し、NNNe.png はステップとして数えない
    session.endSession();
    const data = session.readSession(dir);
    assert.equal(data.steps.length, 1);
    assert.equal(data.steps[0].kind, 'drag');
    assert.equal(data.steps[0].drag.endImage, '001e.png');
  });

  await t.test('appChange がサイドカーに記録され readSession が透過する', () => {
    const { dir } = session.startSession('切替', parent);
    session.recordShot(PNG, {});
    session.recordShot(PNG, { appChange: { from: 'EXCEL.EXE', to: 'WINWORD.EXE' } });
    session.endSession();
    const data = session.readSession(dir);
    assert.equal(data.steps[0].appChange, null);
    assert.deepEqual(data.steps[1].appChange, { from: 'EXCEL.EXE', to: 'WINWORD.EXE' });
  });

  await t.test('amendLastShot が直前のサイドカーだけを修正する（ダブルクリック昇格）', () => {
    const { dir } = session.startSession('昇格', parent);
    session.recordShot(PNG, { button: 'left', clicks: 1, text: '「report.xlsx」を選択' });
    const ok = session.amendLastShot((sc) => {
      sc.click.clicks = 2;
      sc.text = '「report.xlsx」をダブルクリック';
      return sc;
    });
    assert.equal(ok, true);
    const sc = JSON.parse(fs.readFileSync(path.join(dir, '001.json'), 'utf8'));
    assert.equal(sc.click.clicks, 2);
    assert.equal(sc.text, '「report.xlsx」をダブルクリック');
    session.endSession();
  });

  await t.test('amendLastShot はセッション未開始・保存前は false', () => {
    assert.equal(session.amendLastShot((sc) => sc), false);
    session.startSession('未保存', parent);
    assert.equal(session.amendLastShot((sc) => sc), false);
    session.endSession();
  });

  await t.test('旧サイドカー（v3・kind なし）は readSession で kind:"click" になる', () => {
    const { dir } = session.startSession('旧形式', parent);
    session.recordShot(PNG, {});
    session.endSession();
    // v3 相当（kind を消す）に書き換えて後方互換を確認
    const p = path.join(dir, '001.json');
    const sc = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete sc.kind;
    sc.version = 3;
    fs.writeFileSync(p, JSON.stringify(sc));
    const data = session.readSession(dir);
    assert.equal(data.steps[0].kind, 'click');
    assert.equal(data.steps[0].drag, null);
    assert.equal(data.steps[0].keys, null);
  });
});
