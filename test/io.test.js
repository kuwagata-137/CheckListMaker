'use strict';
// io — 共有リンク（URL ハッシュ）の encode/decode と、単体 HTML 書き出しのテスト。
// あわせて JSON 取り込みのマージと、その取り込み方を選ばせる3択ダイアログも見る。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, PX_JPEG } = require('./harness');

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

// JSON 取り込みのマージ（1件追加・同一ID更新）。仕様は docs/spec-json-merge-import.md。
// 従来は全置換しかできず、取り込むとユーザーの既存データが消えていた。
test('io — JSON のマージ取り込み', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const { M } = await app.api();

  // id を固定したチェックリストを作る（マージ判定は id で行うため）
  const make = (id, title) => {
    const c = M.createChecklist('template', title);
    c.id = id;
    M.addItem(c, c.sections[0].id, `${title}の手順`);
    return c;
  };
  // 戻り値は jsdom 側の realm のオブジェクトなので deepStrictEqual だと
  // プロトタイプ違いで落ちる。件数だけを見る。
  const counts = (r) => `${r.added}/${r.updated}`;
  const baseState = () => ({
    checklists: [make('A', '既存A'), make('B', '既存B')],
    settings: { theme: 'dark' },
  });

  await t.test('新しい id は追加され、既存は消えない', () => {
    const s = baseState();
    const res = M.mergeChecklistsInto(s, { checklists: [make('C', '新規C')] });
    assert.equal(counts(res), '1/0');
    assert.deepEqual(s.checklists.map((c) => c.id), ['A', 'B', 'C'], '既存を残して末尾に追加');
    assert.equal(s.checklists[0].title, '既存A', '既存の中身が変わらない');
  });

  await t.test('同一 id は置換される', () => {
    const s = baseState();
    const res = M.mergeChecklistsInto(s, { checklists: [make('B', '更新後B')] });
    assert.equal(counts(res), '0/1');
    assert.equal(s.checklists.length, 2, '件数は増えない');
    assert.equal(s.checklists[1].title, '更新後B');
    assert.equal(s.checklists[0].title, '既存A', '他は巻き添えにならない');
  });

  await t.test('追加と更新が混ざっても正しく数える', () => {
    const s = baseState();
    const res = M.mergeChecklistsInto(s, {
      checklists: [make('A', '更新後A'), make('C', '新規C'), make('D', '新規D')],
    });
    assert.equal(counts(res), '2/1');
    assert.deepEqual(s.checklists.map((c) => c.id), ['A', 'B', 'C', 'D']);
    assert.equal(s.checklists[0].title, '更新後A');
  });

  await t.test('settings は取り込み側で上書きされない', () => {
    const s = baseState();
    M.mergeChecklistsInto(s, { checklists: [make('C', 'C')], settings: { theme: 'light' } });
    assert.equal(s.settings.theme, 'dark', '既存のテーマ設定を保持する');
  });

  await t.test('空・不正な入力は何もしない（例外にしない）', () => {
    const s = baseState();
    assert.equal(counts(M.mergeChecklistsInto(s, { checklists: [] })), '0/0');
    assert.equal(counts(M.mergeChecklistsInto(s, {})), '0/0');
    assert.equal(counts(M.mergeChecklistsInto(s, null)), '0/0');
    assert.equal(counts(M.mergeChecklistsInto(s, { checklists: [null, 'x'] })), '0/0');
    assert.equal(s.checklists.length, 2, '既存は無傷');
  });

  await t.test('HTML 取り込みと同じ意味論になっている', () => {
    // HTML 取り込み（index.html）は「同一 id なら置換、無ければ push」。
    // マージも同じ規則なので、同じ入力なら同じ結果になる。
    const s1 = baseState();
    const incoming = make('B', 'HTML経由B');
    const s2 = baseState();
    const idx = s2.checklists.findIndex((c) => c.id === incoming.id);
    s2.checklists[idx] = incoming;                       // HTML 取り込み相当
    M.mergeChecklistsInto(s1, { checklists: [incoming] }); // JSON マージ
    assert.deepEqual(s1.checklists.map((c) => c.title), s2.checklists.map((c) => c.title));
  });
});

// JSON 取り込みの3択ダイアログ。confirm() の2択では全置換しか選べなかったため、
// 「追加・更新 / すべて置き換える / キャンセル」を選ばせるモーダルに差し替えている。
test('io — JSON 取り込みの3択ダイアログ', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const { askJsonImportMode } = await app.api();
  const doc = app.document;
  const overlay = () => doc.querySelector('.modal-overlay');

  const openAndClick = async (selector) => {
    const p = askJsonImportMode(3);
    await waitFor(() => overlay(), { label: 'ダイアログの表示' });
    overlay().querySelector(selector).click();
    return p;
  };

  await t.test('「追加・更新する」で merge を返す', async () => {
    assert.equal(await openAndClick('[data-mode="merge"]'), 'merge');
    assert.equal(overlay(), null, 'ダイアログが閉じる');
  });

  await t.test('「すべて置き換える」で replace を返す', async () => {
    assert.equal(await openAndClick('[data-mode="replace"]'), 'replace');
    assert.equal(overlay(), null);
  });

  await t.test('キャンセルで null を返す（Promise を残さない）', async () => {
    assert.equal(await openAndClick('[data-close]'), null);
    assert.equal(overlay(), null);
  });

  await t.test('背景クリックでも null を返す', async () => {
    const p = askJsonImportMode(1);
    await waitFor(() => overlay(), { label: 'ダイアログの表示' });
    overlay().click(); // オーバーレイ自身＝背景
    assert.equal(await p, null);
  });

  await t.test('件数と、既定が「追加・更新」であることが文面に出る', async () => {
    const p = askJsonImportMode(7);
    await waitFor(() => overlay(), { label: 'ダイアログの表示' });
    const html = overlay().innerHTML;
    assert.ok(html.includes('7件'), '取り込む件数を示す');
    assert.match(
      overlay().querySelector('[data-mode="merge"]').className,
      /primary/,
      '「追加・更新する」が既定（primary）'
    );
    assert.ok(html.includes('すべて破棄'), '置き換えが破壊的だと明記する');
    overlay().querySelector('[data-close]').click();
    await p;
  });
});
