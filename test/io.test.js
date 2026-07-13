'use strict';
// io — 共有リンク（URL ハッシュ）の encode/decode と、単体 HTML 書き出しのテスト。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, PX_JPEG } = require('./harness');

test('io — 共有リンクと単体HTML', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const api = await app.api();
  const { M, encodeShareLink, readShareFromHash, buildStandaloneHtml } = api;

  await t.test('共有リンク — encode → decode で往復できる', () => {
    const c = M.createChecklist('template', '日本語タイトル ✓');
    M.addItem(c, c.sections[0].id, '手順1');
    const { url, hadImages } = encodeShareLink(c);
    assert.equal(hadImages, false);
    const decoded = readShareFromHash(url.slice(url.indexOf('#')));
    assert.equal(decoded.title, '日本語タイトル ✓');
    assert.equal(decoded.sections[0].items[0].text, '手順1');
  });

  await t.test('共有リンク — 画像は除外され hadImages が立つ', () => {
    const c = M.createChecklist('template', '画像つき');
    M.addItem(c, c.sections[0].id, 'a');
    const item = c.sections[0].items[0];
    M.addItemImage(c, c.sections[0].id, item.id, PX_JPEG);
    M.replaceItemImage(c, c.sections[0].id, item.id, 0, PX_JPEG, { v: 1, base: PX_JPEG, strokes: '', objects: [] });
    const { url, hadImages } = encodeShareLink(c);
    assert.equal(hadImages, true);
    const decoded = readShareFromHash(url.slice(url.indexOf('#')));
    assert.equal(decoded.sections[0].items[0].images.length, 0, '画像は載らない');
    assert.equal(decoded.sections[0].items[0].imageEdits, undefined, '編集ソースも載らない');
    assert.ok(!url.includes(PX_JPEG.slice(30, 60)), 'URL に dataURL 断片が漏れない');
  });

  await t.test('共有リンク — 壊れた payload は null（例外にしない）', () => {
    assert.equal(readShareFromHash('#share=%%%broken%%%'), null);
    assert.equal(readShareFromHash('#share=' + Buffer.from('{"x":1}').toString('base64')), null, 'sections 配列が無ければ拒否');
    assert.equal(readShareFromHash('#/c/abc'), null, '共有ハッシュ以外は null');
  });

  await t.test('単体HTML — 書き出したファイルが単体文書モードで起動する', async () => {
    const c = M.createChecklist('template', 'スタンドアロン試験');
    M.addItem(c, c.sections[0].id, '埋め込み手順');
    const html = buildStandaloneHtml(c);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('window.__CLM_STANDALONE__ = true'), '単体文書モードのマーカーが入る');
    assert.ok(html.includes('スタンドアロン試験'), 'データが埋め込まれる');

    // 書き出した HTML をそのまま起動 → 埋め込みデータで editor が開く
    const solo = bootApp({ html, url: 'https://localhost/downloads/doc.html' });
    try {
      const soloApi = await solo.api();
      assert.equal(soloApi.store.state.checklists[0].title, 'スタンドアロン試験');
      assert.ok(solo.document.body.classList.contains('clm-standalone'), '単体文書モードで起動');
    } finally {
      solo.close();
    }
  });
});
