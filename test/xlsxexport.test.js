'use strict';
// xlsx-export.js（ワークブック構築）のテスト。exceljs で構築 → writeBuffer →
// 別の Workbook で読み戻し、シート構成・固定枠・結合・値・行高を検証する。
// jsdom もアプリ本体も使わない（main.js 側の IPC は Electron 依存のため対象外）。

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildXlsxWorkbook } = require('../xlsx-export');

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const COLUMNS = [
  { header: 'No', width: 6 },
  { header: '項目', width: 40 },
  { header: 'チェック', width: 9 },
  { header: '標準時間(分)', width: 13 },
  { header: 'メモ', width: 25 },
  { header: '詳細', width: 50 },
];

function sampleData({ cover = null } = {}) {
  return {
    sheetName: 'サーバー点検',
    cover,
    columns: COLUMNS,
    rows: [
      { kind: 'title', text: 'サーバー点検' },
      { kind: 'meta', text: 'テンプレート ／ 進捗 1 / 2 完了（50%） ／ 標準時間合計 5分 ／ 出力日 2026-07-14' },
      { kind: 'header' },
      { kind: 'section', text: '1. 準備', meta: '⏱5分' },
      { kind: 'item', no: 1, text: '手順1', check: '✓', time: '5', note: 'メモ', detail: '詳細1\n詳細2' },
      { kind: 'images', images: [{ dataUrl: PNG_1PX, width: 100, height: 80 }, { dataUrl: PNG_1PX, width: 60, height: 120 }] },
      { kind: 'item', no: 2, text: '手順2', check: '', time: '', note: '', detail: '' },
      { kind: 'total', done: 1, total: 2, totalMin: 5 },
    ],
  };
}

async function roundtrip(data) {
  const wb = buildXlsxWorkbook(ExcelJS, data);
  const buf = await wb.xlsx.writeBuffer();
  const rb = new ExcelJS.Workbook();
  await rb.xlsx.load(buf);
  return rb;
}

test('xlsxexport — 表紙なし: 1シート構成と本体の中身', async (t) => {
  const rb = await roundtrip(sampleData());

  await t.test('シートは1枚でタイトル由来の名前', () => {
    assert.equal(rb.worksheets.length, 1);
    assert.equal(rb.worksheets[0].name, 'サーバー点検');
  });
  const ws = rb.worksheets[0];
  await t.test('3行目までの固定表示（frozen / ySplit=3）', () => {
    assert.equal(ws.views[0].state, 'frozen');
    assert.equal(ws.views[0].ySplit, 3);
  });
  await t.test('1行目タイトル（結合・太字）・2行目メタ・3行目見出し', () => {
    assert.equal(ws.getCell('A1').value, 'サーバー点検');
    assert.equal(ws.getCell('A1').font.bold, true);
    assert.match(String(ws.getCell('A2').value), /進捗 1 \/ 2 完了/);
    assert.equal(ws.getCell('A3').value, 'No');
    assert.equal(ws.getCell('B3').value, '項目');
    assert.equal(ws.getCell('F3').value, '詳細');
    assert.ok(ws.getCell('C3').fill && ws.getCell('C3').fill.fgColor, '見出し行に塗りがある');
  });
  await t.test('セクション行は結合・塗り・時間つき', () => {
    assert.equal(ws.getCell('A4').value, '1. 準備　⏱5分');
    assert.equal(ws.getCell('A4').font.bold, true);
  });
  await t.test('項目行: 値・チェック・セル内改行の詳細', () => {
    assert.equal(ws.getCell('A5').value, 1);
    assert.equal(ws.getCell('B5').value, '手順1');
    assert.equal(ws.getCell('C5').value, '✓');
    assert.equal(ws.getCell('F5').value, '詳細1\n詳細2');
    assert.equal(ws.getCell('F5').alignment.wrapText, true);
    assert.equal(ws.getCell('C7').value, null, '未チェックは空セル');
  });
  await t.test('画像行: 行高が最大画像（120px→90pt）に合い、画像が2枚登録される', () => {
    assert.ok(ws.getRow(6).height >= 90, `行高 ${ws.getRow(6).height} >= 90pt`);
    assert.equal(ws.getImages().length, 2);
  });
  await t.test('合計行: 完了数と時間合計', () => {
    assert.equal(ws.getCell('A8').value, '合計');
    assert.equal(ws.getCell('C8').value, '1 / 2');
    assert.equal(ws.getCell('D8').value, 5);
    assert.equal(ws.getCell('A8').font.bold, true);
  });
  await t.test('列幅が設定されている', () => {
    assert.equal(ws.getColumn(2).width, 40);
    assert.equal(ws.getColumn(6).width, 50);
  });
});

test('xlsxexport — 表紙あり: 2シート構成と表紙の中身', async (t) => {
  const cover = {
    title: 'サーバー点検手順書',
    subtitle: '情報システム部標準',
    author: '総務部',
    date: '2026-07-14',
    version: '1.2',
    docNumber: 'DOC-001',
    logo: PNG_1PX,
    revisions: [
      { version: '1.0', date: '2026-06-01', author: '総務部', note: '初版' },
      { version: '1.2', date: '2026-07-14', author: '総務部', note: '点検項目を追加' },
    ],
  };
  const rb = await roundtrip(sampleData({ cover }));

  await t.test('シート1=表紙・シート2=本体', () => {
    assert.equal(rb.worksheets.length, 2);
    assert.equal(rb.worksheets[0].name, '表紙');
    assert.equal(rb.worksheets[1].name, 'サーバー点検');
  });
  const ws = rb.worksheets[0];
  await t.test('タイトル・メタ項目・ロゴ', () => {
    assert.equal(ws.getCell('A2').value, 'サーバー点検手順書');
    assert.equal(ws.getCell('A3').value, '情報システム部標準');
    const flat = [];
    ws.eachRow((row) => row.eachCell((cell) => flat.push(String(cell.value))));
    for (const v of ['文書番号', 'DOC-001', '版数', '1.2', '作成者', '総務部', '日付', '2026-07-14']) {
      assert.ok(flat.includes(v), `${v} が表紙にある`);
    }
    assert.equal(ws.getImages().length, 1, 'ロゴ画像が埋め込まれる');
  });
  await t.test('改訂履歴の表', () => {
    const flat = [];
    ws.eachRow((row) => row.eachCell((cell) => flat.push(String(cell.value))));
    assert.ok(flat.includes('改訂履歴'));
    assert.ok(flat.includes('初版'));
    assert.ok(flat.includes('点検項目を追加'));
  });
});

test('xlsxexport — 境界: 未設定項目・寸法0の画像・空リスト', async (t) => {
  await t.test('未設定の表紙項目とロゴなしは行ごと省略される', async () => {
    const cover = { title: 'T', subtitle: null, author: null, date: null, version: null, docNumber: 'D-1', logo: null, revisions: [] };
    const rb = await roundtrip(sampleData({ cover }));
    const ws = rb.worksheets[0];
    const flat = [];
    ws.eachRow((row) => row.eachCell((cell) => flat.push(String(cell.value))));
    assert.ok(flat.includes('文書番号'));
    assert.ok(!flat.includes('作成者'), '未設定ラベルは出ない');
    assert.ok(!flat.includes('改訂履歴'), '履歴0件なら表なし');
    assert.equal(ws.getImages().length, 0);
  });
  await t.test('寸法0の画像（読めなかった画像）はスキップされる', async () => {
    const data = sampleData();
    data.rows[5] = { kind: 'images', images: [{ dataUrl: PNG_1PX, width: 0, height: 0 }] };
    const rb = await roundtrip(data);
    assert.equal(rb.worksheets[0].getImages().length, 0);
  });
  await t.test('項目ゼロでも壊れない（title/meta/header/totalのみ）', async () => {
    const data = {
      sheetName: '空', cover: null, columns: COLUMNS,
      rows: [
        { kind: 'title', text: '空' }, { kind: 'meta', text: 'ToDo ／ 進捗 0 / 0 完了(0%) ／ 出力日 x' },
        { kind: 'header' }, { kind: 'total', done: 0, total: 0, totalMin: 0 },
      ],
    };
    const rb = await roundtrip(data);
    assert.equal(rb.worksheets[0].getCell('C4').value, '0 / 0');
  });
});
