'use strict';
// storage.js（メインプロセス側の保存基盤）の単体テスト。
// Electron を起動せず、app / ipcMain をスタブして IPC ハンドラを直接叩く。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createMainStorage, PX_PNG } = require('./harness');

test('storage.js — 保存基盤', async (t) => {
  const st = createMainStorage();
  t.after(() => st.cleanup());

  let ref; // image:save が返す参照（後続サブテストで使う）
  const state1 = () =>
    JSON.stringify({ checklists: [{ id: 'a', sections: [{ items: [{ images: [ref] }] }] }], settings: {} });

  await t.test('初回 load は json: null を返す', async () => {
    const r = await st.ipc('storage:load');
    assert.equal(r.ok, true);
    assert.equal(r.json, null);
  });

  await t.test('image:save が img:<uuid>.<ext> 参照を返し image:get で往復できる', async () => {
    const r = await st.ipc('image:save', PX_PNG);
    assert.equal(r.ok, true);
    assert.match(r.ref, /^img:[0-9a-f-]{36}\.png$/);
    ref = r.ref;
    const g = await st.ipc('image:get', ref);
    assert.equal(g.ok, true);
    assert.equal(g.dataUrl, PX_PNG);
  });

  await t.test('パストラバーサルなど不正な参照は拒否される', async () => {
    for (const bad of ['img:../../etc/passwd', 'img:x.png', 'img:' + 'a'.repeat(36) + '.exe', 'foo']) {
      const r = await st.ipc('image:get', bad);
      assert.equal(r.ok, false, `拒否されるべき参照: ${bad}`);
    }
  });

  await t.test('storage:save → load が同じ内容を返す', async () => {
    const r = await st.ipc('storage:save', state1());
    assert.equal(r.ok, true);
    const l = await st.ipc('storage:load');
    assert.equal(l.json, state1());
  });

  await t.test('2回目の保存で直前世代が .bak に残る', async () => {
    const state2 = state1().replace('"a"', '"b"');
    await st.ipc('storage:save', state2);
    const bak = fs.readFileSync(path.join(st.dataDir, 'checklists.json.bak'), 'utf8');
    assert.equal(bak, state1());
  });

  await t.test('本体 JSON が破損していたら .bak にフォールバックする', async () => {
    fs.writeFileSync(path.join(st.dataDir, 'checklists.json'), '{broken');
    const r = await st.ipc('storage:load');
    assert.equal(r.ok, true);
    assert.equal(r.json, state1(), '.bak（直前世代）が返る');
  });

  await t.test('起動時 GC — 参照されない画像だけ削除される', async () => {
    await st.ipc('storage:save', state1()); // ref を参照する正常な state に戻す
    await st.ipc('image:save', PX_PNG); // 孤児画像
    assert.equal(fs.readdirSync(st.imageDir).length, 2, 'GC 前は2ファイル');
    await st.ipc('storage:load'); // load 時に GC が走る
    const rest = fs.readdirSync(st.imageDir);
    assert.equal(rest.length, 1);
    assert.equal('img:' + rest[0], ref, '参照される画像は残る');
  });

  await t.test('並行 save は直列化され最後の内容が残る', async () => {
    const a = state1();
    const b = state1().replace('"a"', '"b"');
    await Promise.all([st.ipc('storage:save', a), st.ipc('storage:save', b), st.ipc('storage:save', a)]);
    const r = await st.ipc('storage:load');
    assert.equal(r.json, a);
  });

  await t.test('image:delete で画像ファイルが消える', async () => {
    const r = await st.ipc('image:save', PX_PNG);
    const d = await st.ipc('image:delete', r.ref);
    assert.equal(d.ok, true);
    const g = await st.ipc('image:get', r.ref);
    assert.equal(g.ok, false);
  });
});
