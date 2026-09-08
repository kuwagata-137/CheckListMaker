// 画像一括インポート（フォルダから選択）の純関数テスト。
// 仕様は docs/spec-image-batch-import.md 参照。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./harness');

const plain = (v) => JSON.parse(JSON.stringify(v));

test('imagefiles — フォルダから選択した画像のステップ変換', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('naturalCompareFilenames — 数字は自然順・大小文字は無視', () => {
    assert.ok(T.naturalCompareFilenames('img2.png', 'img10.png') < 0, 'img2 < img10');
    assert.ok(T.naturalCompareFilenames('img10.png', 'img2.png') > 0);
    assert.equal(T.naturalCompareFilenames('A.png', 'a.png'), 0, '大小文字は同順');
    assert.ok(T.naturalCompareFilenames('手順1.png', '手順10.png') < 0, '日本語名でも自然順');
    assert.equal(T.naturalCompareFilenames(null, null), 0, 'null でも落ちない');
  });

  await t.test('wizardStepsFromFiles — 1ファイル=1ステップ・名前の自然順', () => {
    const steps = T.wizardStepsFromFiles([
      { path: 'C:/pics/b10.png', name: 'b10.png' },
      { path: 'C:/pics/b2.png', name: 'b2.png' },
      { path: 'C:/pics/a1.jpg', name: 'a1.jpg' },
    ]);
    assert.equal(steps.length, 3);
    assert.deepEqual(steps.map((s) => s.shots[0].name), ['a1.jpg', 'b2.png', 'b10.png'], '自然順ソート');
    assert.deepEqual(steps.map((s) => s.text), ['', '', ''], '文は空で取り込む');
    const shot = steps[0].shots[0];
    assert.equal(shot.kind, 'file');
    assert.equal(shot.image, 'C:/pics/a1.jpg', 'image はフルパス');
    assert.equal(shot.zoomImage, null, '拡大なし');
    assert.equal(shot.choice, 'full', '既定は全景（元画像そのまま）');
  });

  await t.test('wizardStepsFromFiles — 不正入力で落ちない', () => {
    assert.deepEqual(plain(T.wizardStepsFromFiles(null)), []);
    assert.deepEqual(plain(T.wizardStepsFromFiles([])), []);
    assert.deepEqual(plain(T.wizardStepsFromFiles([null, { name: 'x' }])), [], 'path 無しは除外');
  });

  await t.test('wizardShotFiles — file ステップは元画像1枚を返す', () => {
    const [step] = T.wizardStepsFromFiles([{ path: 'C:/pics/one.png', name: 'one.png' }]);
    assert.deepEqual(plain(T.wizardShotFiles(step.shots[0])), ['C:/pics/one.png']);
  });

  await t.test('buildImportItems / insertItemsAt — 既存パイプラインにそのまま通る', () => {
    const steps = T.wizardStepsFromFiles([
      { path: 'C:/pics/1.png', name: '1.png' },
      { path: 'C:/pics/2.png', name: '2.png' },
    ]);
    steps[0].text = '一枚目';
    const items = T.buildImportItems(steps, [[{ thumb: 'data:1', full: 'data:1f' }], []]);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, '一枚目');
    assert.deepEqual(plain(items[0].images), ['data:1']);
    assert.deepEqual(plain(items[0].imagesFull), ['data:1f']);
    assert.deepEqual(plain(items[1].images), [], '画像なしステップも項目になる');

    const section = { id: 's1', title: '既存', items: [{ id: 'x1' }, { id: 'x2' }] };
    T.insertItemsAt(section, 1, items);
    assert.deepEqual(
      section.items.map((it) => it.id === 'x1' || it.id === 'x2' ? it.id : '(new)'),
      ['x1', '(new)', '(new)', 'x2'],
      '指定位置へ割り込み・既存は消えない'
    );
  });

  await t.test('makeFilesSource — load がステップと表示情報を返し、空なら null', async () => {
    const src = T.makeFilesSource([{ path: 'C:/pics/z.png', name: 'z.png' }]);
    assert.equal(src.kind, 'files');
    assert.equal(src.canOpenDir, false);
    const loaded = await src.load();
    assert.equal(loaded.steps.length, 1);
    assert.equal(loaded.newListTitle, '画像の取り込み');
    assert.match(loaded.defaultTitle, /^画像 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/, '既定セクション名は「画像 日時」');
    assert.match(loaded.headerHtml, /選択した画像 1枚/);
    const empty = T.makeFilesSource([]);
    assert.equal(await empty.load(), null, '0枚は null（呼び出し側でエラー表示）');
    assert.equal(src.markImported(), undefined, 'markImported は no-op');
  });
});
