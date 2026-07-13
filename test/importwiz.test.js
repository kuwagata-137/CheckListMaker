'use strict';
// 録画取り込みウィザード（2-R4）の純関数テスト。
// ブラウザモードで1回起動し、window.__test__ 経由で呼ぶ。
// 仕様は docs/spec-2-R4-import-wizard.md 参照。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, PX_JPEG } = require('./harness');

// jsdom（別 Realm）で作られた配列・オブジェクトは deepStrictEqual がプロトタイプ
// 不一致で落ちるため、JSON 経由でプレーンな値に正規化してから比較する。
const plain = (v) => JSON.parse(JSON.stringify(v));

// session.readSession が返す形のステップを作る
function step(over = {}) {
  return {
    seq: 1,
    image: '001.png',
    zoomImage: '001z.png',
    zoomSource: 'element',
    text: '「保存」ボタンをクリック',
    uia: null,
    click: null,
    time: null,
    ...over,
  };
}

test('importwiz — 取り込みウィザードの純関数', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('wizardDefaultChoice — 要素採用なら拡大・それ以外は全景', () => {
    assert.equal(T.wizardDefaultChoice(step()), 'zoom');
    assert.equal(T.wizardDefaultChoice(step({ zoomSource: 'click' })), 'full', 'クリック中心フォールバックは全景');
    assert.equal(T.wizardDefaultChoice(step({ zoomImage: null, zoomSource: null })), 'full', '拡大なし（旧形式）は全景');
  });

  await t.test('wizardStepsFrom — セッション → ステップモデル（text null は空文字）', () => {
    const steps = T.wizardStepsFrom({
      steps: [step(), step({ seq: 2, image: '002.png', zoomImage: null, zoomSource: null, text: null })],
    });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].text, '「保存」ボタンをクリック');
    assert.deepEqual(plain(steps[0].shots), [{ seq: 1, image: '001.png', zoomImage: '001z.png', choice: 'zoom' }]);
    assert.equal(steps[1].text, '');
    assert.equal(steps[1].shots[0].choice, 'full');
    assert.deepEqual(plain(T.wizardStepsFrom(null)), [], 'null でも落ちない');
  });

  await t.test('wizardMergeUp — 文は「、」連結・ショットは結合・先頭/範囲外は何もしない', () => {
    const mk = () => T.wizardStepsFrom({
      steps: [
        step({ text: '「ファイル」タブを選択' }),
        step({ seq: 2, image: '002.png', text: '「保存」ボタンをクリック' }),
        step({ seq: 3, image: '003.png', text: '' }),
      ],
    });
    let steps = mk();
    T.wizardMergeUp(steps, 1);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].text, '「ファイル」タブを選択、「保存」ボタンをクリック');
    assert.equal(steps[0].shots.length, 2);
    // 片方が空文なら「、」を挟まない
    steps = mk();
    T.wizardMergeUp(steps, 2);
    assert.equal(steps[1].text, '「保存」ボタンをクリック');
    // 先頭・範囲外は無変更
    steps = mk();
    T.wizardMergeUp(steps, 0);
    T.wizardMergeUp(steps, 99);
    assert.equal(steps.length, 3);
  });

  await t.test('wizardBulkReplace — 全ステップへの単純置換と件数', () => {
    const steps = T.wizardStepsFrom({
      steps: [
        step({ text: '「保存」ボタンをクリック' }),
        step({ seq: 2, text: 'クリック、クリック' }),
        step({ seq: 3, text: '対象なし' }),
      ],
    });
    assert.equal(T.wizardBulkReplace(steps, 'クリック', '押下'), 3);
    assert.equal(steps[0].text, '「保存」ボタンを押下');
    assert.equal(steps[1].text, '押下、押下');
    assert.equal(steps[2].text, '対象なし');
    assert.equal(T.wizardBulkReplace(steps, '', 'x'), 0, '空の検索語は何もしない');
  });

  await t.test('wizardShotFiles — 選択 → 添付ファイル列（両方は全景→拡大の順）', () => {
    const shot = { image: '001.png', zoomImage: '001z.png', choice: 'zoom' };
    assert.deepEqual(plain(T.wizardShotFiles(shot)), ['001z.png']);
    assert.deepEqual(plain(T.wizardShotFiles({ ...shot, choice: 'full' })), ['001.png']);
    assert.deepEqual(plain(T.wizardShotFiles({ ...shot, choice: 'both' })), ['001.png', '001z.png']);
    // 拡大が無いショットは choice によらず全景
    assert.deepEqual(plain(T.wizardShotFiles({ image: '001.png', zoomImage: null, choice: 'zoom' })), ['001.png']);
    assert.deepEqual(plain(T.wizardShotFiles({ image: '001.png', zoomImage: null, choice: 'both' })), ['001.png']);
  });

  await t.test('buildImportSection — セクション生成（文のトリム・画像の添付）', () => {
    const steps = T.wizardStepsFrom({
      steps: [step({ text: '  「保存」ボタンをクリック  ' }), step({ seq: 2, text: null })],
    });
    const sec = T.buildImportSection('録画 2026/07/13 09:05', steps, [[PX_JPEG, PX_JPEG], []]);
    assert.equal(sec.title, '録画 2026/07/13 09:05');
    assert.equal(sec.items.length, 2);
    assert.equal(sec.items[0].text, '「保存」ボタンをクリック');
    assert.deepEqual(plain(sec.items[0].images), [PX_JPEG, PX_JPEG]);
    assert.deepEqual(plain(sec.items[1].images), []);
    assert.ok(sec.id && sec.items[0].id, 'セクション・項目とも id が振られる');
  });
});
