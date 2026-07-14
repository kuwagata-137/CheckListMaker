'use strict';
// Excel/CSV 出力（3-A）のレンダラー側純関数のテスト。
// 仕様は docs/spec-3-A-xlsx-csv.md 参照。ワークブック構築側（xlsx-export.js）は
// test/xlsxexport.test.js で exceljs の読み戻しにより検証する。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp } = require('./harness');

// 1x1 の透過 PNG（画像行の生成テスト用）
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('xlsxcsv — htmlToPlainText', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('ブロック要素と <br> が改行になる', () => {
    assert.equal(T.htmlToPlainText('<p>あ</p><p>い</p>'), 'あ\nい');
    assert.equal(T.htmlToPlainText('1行目<br>2行目'), '1行目\n2行目');
    assert.equal(T.htmlToPlainText('<ul><li>甲</li><li>乙</li></ul>'), '甲\n乙');
  });
  await t.test('装飾タグは落ちて文字だけ残る・エンティティ復号', () => {
    assert.equal(T.htmlToPlainText('<b>太字</b>と<span style="color:red">赤</span>'), '太字と赤');
    assert.equal(T.htmlToPlainText('a &amp; b &lt;tag&gt;'), 'a & b <tag>');
  });
  await t.test('表はセル間タブ・行ごと改行', () => {
    const out = T.htmlToPlainText('<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table>');
    assert.equal(out, 'A1\tB1\nA2\tB2');
  });
  await t.test('連続改行は2つに圧縮・null/空は空文字', () => {
    assert.equal(T.htmlToPlainText('<p>あ</p><p></p><p></p><p>い</p>'), 'あ\nい', '空段落は畳まれる');
    assert.equal(T.htmlToPlainText('<p>あ</p><p><br></p><p>い</p>'), 'あ\n\nい', '<p><br></p> は空行として残る');
    assert.equal(T.htmlToPlainText(''), '');
    assert.equal(T.htmlToPlainText(null), '');
  });
});

test('xlsxcsv — excelSheetName / capImageSize', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('シート名: 禁止記号の置換と31文字切り詰め', () => {
    assert.equal(T.excelSheetName('点検: 7/14 [本番]?*\\'), '点検_ 7_14 _本番____');
    assert.equal(T.excelSheetName('あ'.repeat(40)).length, 31);
    assert.equal(T.excelSheetName(''), 'チェックリスト');
    assert.equal(T.excelSheetName(null), 'チェックリスト');
  });
  await t.test('画像: 960px 以下は原寸のまま', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(T.capImageSize(800, 500))), { width: 800, height: 500 });
  });
  await t.test('画像: 幅超過は縦横比を保って幅960に', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(T.capImageSize(1600, 900))), { width: 960, height: 540 });
    assert.deepEqual(JSON.parse(JSON.stringify(T.capImageSize(1920, 400))), { width: 960, height: 200 });
  });
  await t.test('画像: 高さ540px超も縮小・0やnullは0x0', () => {
    const r = T.capImageSize(500, 1080);
    assert.equal(r.height, 540);
    assert.equal(r.width, 250);
    assert.deepEqual(JSON.parse(JSON.stringify(T.capImageSize(0, 100))), { width: 0, height: 0 });
  });
});

test('xlsxcsv — buildCsvText', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const { M } = T;

  function makeTemplate() {
    const c = M.createChecklist('template', '月次点検');
    c.sections[0].title = '事前準備';
    const s1 = c.sections[0].id;
    M.addItem(c, s1, '予告を投稿');
    M.addItem(c, s1, 'バックアップ確認');
    c.sections[0].items[0].done = true;
    c.sections[0].items[0].time = '2';
    c.sections[0].items[0].note = 'メモA';
    c.sections[0].items[0].body = '<p>1行目</p><p>2行目</p>';
    M.addSection(c, '点検作業');
    M.addItem(c, c.sections[1].id, 'ディスク使用率, "80%" 未満');
    return c;
  }

  await t.test('BOM で始まり CRLF 区切り・1行目は列見出し', () => {
    const csv = T.buildCsvText(makeTemplate());
    assert.equal(csv[0], '﻿');
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], 'セクション,No,項目,チェック,標準時間(分),メモ,詳細');
    assert.equal(lines[lines.length - 1], '', '末尾は CRLF で終わる');
  });
  await t.test('データ行のみ（タイトル・メタ・合計行なし）・✓/空欄・通し番号', () => {
    const csv = T.buildCsvText(makeTemplate());
    const lines = csv.slice(1).split('\r\n').filter(Boolean);
    assert.equal(lines.length, 1 + 3, '見出し1行＋データ3行だけ');
    assert.match(lines[1], /^事前準備,1,予告を投稿,✓,2,メモA,/);
    assert.match(lines[2], /^事前準備,2,バックアップ確認,,,,$/);
    assert.match(lines[3], /^点検作業,3,/, 'No はセクション横断の通し番号');
    assert.ok(!csv.includes('月次点検'), 'タイトル行は入らない');
    assert.ok(!csv.includes('合計'), '合計行は入らない');
  });
  await t.test('RFC 4180: カンマ・引用符・改行のエスケープ', () => {
    const csv = T.buildCsvText(makeTemplate());
    assert.ok(csv.includes('"ディスク使用率, ""80%"" 未満"'), 'カンマ＋引用符入りは囲んで二重化');
    const detail = csv.split('\r\n')[1];
    assert.ok(detail.includes('"1行目\n2行目"'), '本文のセル内改行は引用符内の LF');
  });
  await t.test('ToDo は時間・メモ・詳細が空欄', () => {
    const c = M.createChecklist('todo', '買い物');
    const sid = c.sections[0].id;
    M.addItem(c, sid, '牛乳');
    c.sections[0].items[0].time = '5'; // データ上残っていても出さない
    c.sections[0].items[0].note = '残骸';
    c.sections[0].items[0].body = '<p>残骸</p>';
    const csv = T.buildCsvText(c);
    const line = csv.slice(1).split('\r\n')[1];
    assert.match(line, /,牛乳,,,,$/);
  });
});

test('xlsxcsv — buildXlsxSheetData', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const { M } = T;

  function makeTemplate() {
    const c = M.createChecklist('template', 'サーバー点検');
    c.sections[0].title = '準備';
    const s1 = c.sections[0].id;
    M.addItem(c, s1, '手順1');
    M.addItem(c, s1, '手順2');
    c.sections[0].items[0].done = true;
    c.sections[0].items[0].time = '3';
    c.sections[0].items[1].images = [PNG_1PX, 'data:image/webp;base64,xxxx'];
    M.addSection(c, '本作業');
    M.addItem(c, c.sections[1].id, '手順3');
    return c;
  }

  await t.test('行の順序: title→meta→header→section→item(→images)→…→total', () => {
    const d = T.buildXlsxSheetData(makeTemplate());
    const kinds = d.rows.map((r) => r.kind);
    assert.deepEqual(
      JSON.parse(JSON.stringify(kinds)),
      ['title', 'meta', 'header', 'section', 'item', 'item', 'images', 'section', 'item', 'total']
    );
  });
  await t.test('画像行は画像を持つ手順の直下だけ・非対応形式(webp)は除外', () => {
    const d = T.buildXlsxSheetData(makeTemplate());
    const imgRow = d.rows.find((r) => r.kind === 'images');
    assert.equal(imgRow.images.length, 1, 'webp は除外され PNG だけ残る');
    assert.equal(imgRow.images[0].width, 0, '寸法は measure 前は 0');
  });
  await t.test('メタ行: 種別・進捗・時間合計・出力日', () => {
    const d = T.buildXlsxSheetData(makeTemplate());
    const meta = d.rows[1].text;
    assert.match(meta, /テンプレート/);
    assert.match(meta, /進捗 1 \/ 3 完了（33%）/);
    assert.match(meta, /標準時間合計 3分/);
    assert.match(meta, /出力日 /);
    assert.ok(!/文書番号/.test(meta), '表紙無効なら文書情報は載らない');
  });
  await t.test('チェック・時間・合計行の中身', () => {
    const d = T.buildXlsxSheetData(makeTemplate());
    const items = d.rows.filter((r) => r.kind === 'item');
    assert.equal(items[0].check, '✓');
    assert.equal(items[1].check, '');
    assert.deepEqual([items[0].no, items[1].no, items[2].no], [1, 2, 3], '通し番号');
    const total = d.rows[d.rows.length - 1];
    assert.equal(total.done, 1);
    assert.equal(total.total, 3);
    assert.equal(total.totalMin, 3);
  });
  await t.test('表紙: 有効なテンプレートのみ cover が付き、メタ行にも文書情報が載る', () => {
    const c = makeTemplate();
    c.coverPage = M.createCoverPage();
    c.coverPage.enabled = true;
    c.coverPage.docNumber = 'DOC-001';
    c.coverPage.version = '1.2';
    c.coverPage.author = '総務部';
    const d = T.buildXlsxSheetData(c);
    assert.ok(d.cover);
    assert.equal(d.cover.docNumber, 'DOC-001');
    assert.match(d.rows[1].text, /文書番号 DOC-001 ／ 版数 1\.2 ／ 作成者 総務部/);
    c.coverPage.enabled = false;
    assert.equal(T.buildXlsxSheetData(c).cover, null, '無効なら cover なし');
  });
  await t.test('ToDo: cover なし・時間/メモ/詳細は空・列構成は同じ', () => {
    const c = M.createChecklist('todo', 'やること');
    const sid = c.sections[0].id;
    M.addItem(c, sid, '項目A');
    c.sections[0].items[0].time = '9';
    const d = T.buildXlsxSheetData(c);
    assert.equal(d.cover, null);
    assert.equal(d.columns.length, 6, 'テンプレートと同じ6列');
    const item = d.rows.find((r) => r.kind === 'item');
    assert.equal(item.time, '');
    assert.match(d.rows[1].text, /^ToDo/);
    assert.ok(!/標準時間合計/.test(d.rows[1].text), 'ToDo に時間合計は出ない');
  });
  await t.test('シート名はタイトル由来', () => {
    const d = T.buildXlsxSheetData(makeTemplate());
    assert.equal(d.sheetName, 'サーバー点検');
  });
});
