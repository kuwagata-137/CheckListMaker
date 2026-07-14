'use strict';
// 3-B 画像画質の向上（原寸 2 段構成）のテスト。確定仕様は
// docs/spec-3-B-image-quality.md。canvas 非依存の範囲を検証する
//（実描画・実画質・容量は Windows 実機検証にまとめて回す方針）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bootApp, createMainStorage, PX_JPEG, PX_PNG } = require('./harness');

// ---- 純関数（canvas 不要）: 原寸の形式決定 ----
test('3-B 原寸の形式決定（imageMime / fullImagePlan）', async (t) => {
  const app = bootApp({});
  t.after(() => app.close());
  const { imageMime, fullImagePlan } = await app.api();

  await t.test('imageMime — dataURL の MIME を返す', () => {
    assert.equal(imageMime(PX_JPEG), 'image/jpeg');
    assert.equal(imageMime(PX_PNG), 'image/png');
    assert.equal(imageMime('data:image/webp;base64,AAAA'), 'image/webp');
    assert.equal(imageMime('これは画像ではない'), '');
  });

  // fullImagePlan は jsdom レルムのオブジェクトを返すため、cross-realm な
  // deepEqual（prototype 不一致で落ちる）を避け、フィールド単位で比較する。
  const plan = (mime, edge) => {
    const p = fullImagePlan(mime, edge, 2560);
    return p.reencode + '/' + p.mime;
  };
  await t.test('上限内の PNG/JPEG は無変換（真の無損失）', () => {
    assert.equal(plan('image/png', 1000), 'false/image/png');
    assert.equal(plan('image/jpeg', 2560), 'false/image/jpeg');
  });

  await t.test('上限超過は形式を保ったまま再符号化', () => {
    assert.equal(plan('image/png', 4000), 'true/image/png');
    assert.equal(plan('image/jpeg', 4000), 'true/image/jpeg');
  });

  await t.test('PNG/JPEG 以外（webp・gif）は大きさに関わらず JPEG', () => {
    assert.equal(plan('image/webp', 500), 'true/image/jpeg');
    assert.equal(plan('image/gif', 3000), 'true/image/jpeg');
  });
});

// ---- モデル: imagesFull は images と index を揃えた並行配列 ----
test('3-B モデル — imagesFull が images / imageEdits と同期する', async (t) => {
  const app = bootApp({});
  t.after(() => app.close());
  const { M } = await app.api();

  const c = M.createChecklist('todo');
  const sid = c.sections[0].id;
  M.addItem(c, sid, 'a');
  const item = c.sections[0].items[0];

  M.addItemImage(c, sid, item.id, 'img:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg', 'img:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png');
  M.addItemImage(c, sid, item.id, 'img:cccccccc-cccc-cccc-cccc-cccccccccccc.jpg'); // 原寸なし
  assert.equal(item.imagesFull.length, 2, '追加で長さが揃う');
  assert.equal(item.imagesFull[0], 'img:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png');
  assert.equal(item.imagesFull[1], null, '原寸を渡さなければ null');
  assert.equal(item.imageEdits.length, 2, 'imageEdits も揃う');

  // replace: fullRef 指定で原寸を差し替え
  M.replaceItemImage(c, sid, item.id, 1, 'img:dddddddd-dddd-dddd-dddd-dddddddddddd.jpg',
    { v: 1, base: 'img:eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jpg', strokes: '', objects: [] },
    'img:ffffffff-ffff-ffff-ffff-ffffffffffff.png');
  assert.equal(item.imagesFull[1], 'img:ffffffff-ffff-ffff-ffff-ffffffffffff.png');
  assert.ok(item.imageEdits[1], '編集ソースが保持される');

  // replace: fullRef 未指定（undefined）は原寸を変更しない
  M.replaceItemImage(c, sid, item.id, 0, 'img:00000000-0000-0000-0000-000000000000.jpg', null);
  assert.equal(item.imagesFull[0], 'img:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png', '未指定は据え置き');

  // remove: images / imagesFull / imageEdits が揃って縮む
  M.removeItemImage(c, sid, item.id, 0);
  assert.equal(item.images.length, 1);
  assert.equal(item.imagesFull.length, 1);
  assert.equal(item.imagesFull[0], 'img:ffffffff-ffff-ffff-ffff-ffffffffffff.png');
  assert.equal(item.imageEdits.length, 1);
});

// ---- 出力ルーティング: 原寸差し替え / JSON は両方保持 ----
test('3-B materialize — 視覚出力は原寸、JSON バックアップは両方保持', async (t) => {
  const st = createMainStorage();
  t.after(() => st.cleanup());
  const app = bootApp({ storage: st });
  t.after(() => app.close());
  const { M, storeImage, materializeChecklist, materializeState } = await app.api();

  const thumbRef = await storeImage(PX_JPEG); // サムネ（.jpg）
  const fullRef = await storeImage(PX_PNG);   // 原寸（.png）

  const mk = (imagesFull) => {
    const c = M.createChecklist('todo');
    c.sections = [{ id: 's1', title: '', items: [
      { id: 'i1', text: 't', done: false, note: '', time: '', body: '',
        images: [thumbRef], imagesFull, imageEdits: [null] },
    ] }];
    return c;
  };

  await t.test('materializeChecklist は原寸(imagesFull)を images に差し替える', async () => {
    const out = await materializeChecklist(mk([fullRef]));
    const it = out.sections[0].items[0];
    assert.ok(it.images[0].startsWith('data:image/png'), '原寸(png)が images に入る');
    assert.equal(it.imagesFull, undefined, 'imagesFull は視覚出力から落ちる');
  });

  await t.test('原寸が null ならサムネにフォールバック', async () => {
    const out = await materializeChecklist(mk([null]));
    assert.ok(out.sections[0].items[0].images[0].startsWith('data:image/jpeg'));
  });

  await t.test('imagesFull キー自体が無いレガシーも従来どおり出力される', async () => {
    const cl = mk(undefined);
    delete cl.sections[0].items[0].imagesFull;
    const out = await materializeChecklist(cl);
    assert.ok(out.sections[0].items[0].images[0].startsWith('data:image/jpeg'));
  });

  await t.test('materializeState は images と imagesFull の両方を dataURL 保持（無損失）', async () => {
    const state = { checklists: [mk([fullRef])], settings: { theme: 'auto' } };
    const out = await materializeState(state);
    const it = out.checklists[0].sections[0].items[0];
    assert.ok(it.images[0].startsWith('data:image/jpeg'), 'サムネは jpeg 保持');
    assert.ok(it.imagesFull[0].startsWith('data:image/png'), '原寸は png 保持');
  });
});

// ---- 参照化と GC: 原寸参照も孤児として消されない ----
test('3-B 参照化＋GC — imagesFull も保存され GC で保護される', async (t) => {
  const st = createMainStorage();
  t.after(() => st.cleanup());
  const app = bootApp({ storage: st });
  t.after(() => app.close());
  const { absorbChecklistImages } = await app.api();

  const cl = {
    id: 'c1', title: '', type: 'todo', createdAt: 1, updatedAt: 1,
    sections: [{ id: 's1', title: '', items: [
      { id: 'i1', text: '', done: false, note: '', time: '', body: '',
        images: [PX_JPEG], imagesFull: [PX_PNG], imageEdits: [null] },
    ] }],
  };
  await absorbChecklistImages(cl);
  const item = cl.sections[0].items[0];
  assert.match(item.images[0], /^img:[0-9a-f-]{36}\.jpg$/, 'サムネが参照化される');
  assert.match(item.imagesFull[0], /^img:[0-9a-f-]{36}\.png$/, '原寸も参照化される');

  // state を保存（原寸＋サムネの 2 ファイル）
  const state = { checklists: [cl], settings: { theme: 'auto' } };
  await st.ipc('storage:save', JSON.stringify(state));
  assert.equal(fs.readdirSync(st.imageDir).length, 2, '原寸＋サムネの2ファイル');

  // 参照されない孤児ファイルを1つ置く → ロード時 GC で消える。
  // 参照済み（imagesFull を含む）は残ることを確認する。
  const orphan = 'aaaaaaaa-1111-2222-3333-444444444444.png';
  fs.writeFileSync(path.join(st.imageDir, orphan), Buffer.from(PX_PNG.split(',')[1], 'base64'));
  assert.equal(fs.readdirSync(st.imageDir).length, 3);

  await st.ipc('storage:load'); // 起動ロードで孤児 GC が走る
  const remaining = fs.readdirSync(st.imageDir);
  assert.equal(remaining.length, 2, '孤児は消え、参照済み（原寸含む）は残る');
  assert.ok(!remaining.includes(orphan), '孤児ファイルが削除される');
});
