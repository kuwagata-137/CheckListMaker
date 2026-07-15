'use strict';
// 表紙（カバーページ）の純関数テスト。
//  - テキスト欄（タイトル/サブタイトル/作成者/版数/文書番号）は本文編集と同じリッチ編集
//    （書式付き HTML）になった。renderCoverHtml がサニタイズしつつ書式を保つこと、
//    危険な入力を落とすこと、旧データ（プレーン文字列）でも壊れないことを検証する。
//  - 改訂履歴の日付はカレンダー入力（ISO）で持ち、表示は「yyyy年m月d日」に整形する。
//  - Word 出力は表紙を SVG foreignObject(XML) に埋め込むため、<br> 等の空要素を自己終了に
//    補正した結果が XML として解析できることを確認する。

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { bootApp } = require('./harness');

// rasterizeCoverToPng が SVG へ埋め込む前に行う空要素の自己終了補正（index.html と同じ正規表現）。
const selfClose = (html) => html.replace(/<(br|hr|img|col|wbr)\b([^>]*?)\s*\/?>/gi, '<$1$2/>');

test('cover — 表紙のリッチ編集・日付整形・XML 埋め込み', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const api = await app.api();
  const { renderCoverHtml, formatCoverDate, toIsoDate } = api;

  await t.test('テキスト欄の書式（太字・色）を保って出力する', () => {
    const html = renderCoverHtml(
      { enabled: true, preset: 'centered', title: '<b>点検</b>マニュアル', subtitle: '<span style="color:#c00">重要</span>' },
      'フォールバック'
    );
    assert.match(html, /<h1 class="title"><b>点検<\/b>マニュアル<\/h1>/);
    assert.ok(html.includes('重要'), 'サブタイトルの本文が残る');
    // 色指定は残る（#c00 のまま、または rgb(204, 0, 0) へ正規化されうる）。
    assert.match(html, /<span style="color:[^"]+">重要<\/span>/, 'サブタイトルの色指定が残る');
  });

  await t.test('危険な入力（script/img/onerror）は落とし、テキストは残す', () => {
    const html = renderCoverHtml(
      { enabled: true, preset: 'centered', title: '<img src=x onerror=alert(1)><script>bad()<\/script>安全' },
      ''
    );
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /onerror/i);
    assert.ok(html.includes('安全'));
  });

  await t.test('タイトル未入力ならフォールバックを使う', () => {
    const html = renderCoverHtml({ enabled: true, preset: 'centered', title: '' }, 'タイトル未入力');
    assert.ok(html.includes('タイトル未入力'));
  });

  await t.test('旧データ（プレーン文字列）は壊れずエスケープされる', () => {
    const html = renderCoverHtml({ enabled: true, preset: 'centered', title: 'A & B <危険>' }, '');
    assert.ok(html.includes('A &amp; B'), '& がエスケープされる');
    assert.ok(html.includes('&lt;'), '< がエスケープされる');
    assert.doesNotMatch(html, /<危険>/);
  });

  await t.test('日付は ISO を「yyyy年m月d日」に整形する（本体・改訂履歴とも）', () => {
    assert.equal(toIsoDate('2026/7/5'), '2026-07-05');
    assert.equal(formatCoverDate('2026-07-05'), '2026年7月5日');
    assert.equal(formatCoverDate(''), '');
    const html = renderCoverHtml(
      {
        enabled: true, preset: 'left-top', date: '2026-07-15',
        revisions: [{ id: 'r1', version: '1.0', date: '2026-07-15', author: '山', note: '初版' }],
      },
      ''
    );
    // 本文の日付と改訂履歴の日付の両方が整形されて出る（ISO の生表示は出さない）。
    assert.ok(html.includes('2026年7月15日'));
    assert.doesNotMatch(html, /2026-07-15/);
  });

  await t.test('リッチ書式を含む表紙が Word 出力用の XML(SVG) として解析できる', () => {
    const cover = {
      enabled: true, preset: 'doc-header',
      title: '一行<br>二行<b>太</b>', subtitle: '<ul><li>あ</li><li>い</li></ul>',
      author: '<i>山田</i>', version: 'v1', docNumber: 'D-1', date: '2026-07-15',
      revisions: [{ id: 'r1', version: '1.0', date: '2026-07-15', author: '山', note: '初版<br>更新' }],
    };
    const coverHtml = selfClose(renderCoverHtml(cover, 'F'));
    assert.ok(coverHtml.includes('<br/>'), '空要素が自己終了になる');
    assert.doesNotMatch(coverHtml, /<br>/, '未終了の <br> が残らない');
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123">' +
      '<foreignObject x="0" y="0" width="794" height="1123">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="width:794px;height:1123px">' +
      coverHtml + '</div></foreignObject></svg>';
    const d = new JSDOM(svg, { contentType: 'image/svg+xml' });
    assert.equal(d.window.document.querySelector('parsererror'), null, 'XML パースエラーが無い');
  });
});
