'use strict';
// ── .xlsx ワークブック構築（3-A） ─────────────────────────────
// レンダラー(index.html の buildXlsxSheetData)が組んだ宣言的な出力仕様
// { sheetName, cover, columns, rows } から exceljs のワークブックを作る。
// 仕様は docs/spec-3-A-xlsx-csv.md 参照。
//
// ExcelJS はコンストラクタ注入にしている: require は呼び出し側（main.js）が
// 行い「exceljs が無い」失敗をそこで返せるようにしつつ、このモジュールは
// Electron 無しの node:test で丸ごと検証できるようにするため
//（docx-postprocess.js と同じ位置づけの独立モジュール）。

// 色（index.html のモダンUIトークンに合わせた控えめな配色）
const COLOR_LINE = 'FFCFD3DA'; // 罫線
const COLOR_HEAD = 'FFF2F4F7'; // 見出し行の塗り
const COLOR_SECTION = 'FFDCEBE2'; // セクション見出し行の塗り
const COLOR_META = 'FF5B6472'; // メタ行の文字色

const THIN = { style: 'thin', color: { argb: COLOR_LINE } };
const BORDER_ALL = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const COL_COUNT = 6; // No / 項目 / チェック / 標準時間(分) / メモ / 詳細

// dataURL から exceljs 用の { base64, extension } を作る。非対応形式は null。
function imageFromDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpe?g|gif);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'png' ? 'png' : m[1].toLowerCase() === 'gif' ? 'gif' : 'jpeg';
  return { base64: m[2], extension: ext };
}

// 列番号（1始まり）と累積px幅から、exceljs の小数 col アンカーを近似する。
// Excel の列 px 幅は「文字数幅×7+5」で近似（既定フォント Calibri 11 相当）。
// 数 px の誤差は許容（仕様の補足既定）。
function colAtPx(px, columns) {
  let x = 0;
  for (let i = 0; i < columns.length; i++) {
    const w = (columns[i].width || 10) * 7 + 5;
    if (px < x + w) return i + (px - x) / w;
    x += w;
  }
  const last = (columns[columns.length - 1].width || 10) * 7 + 5;
  return columns.length - 1 + Math.min(1, (px - (x - last)) / last);
}

function addCoverSheet(wb, cover) {
  const ws = wb.addWorksheet('表紙', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 14 }, { width: 24 }, { width: 16 }, { width: 40 }];
  let r = 2;
  // ロゴ（あれば右上に原寸で置く。位置は D 列相当・行はタイトルの上）
  const logo = imageFromDataUrl(cover.logo);
  if (logo) {
    const id = wb.addImage(logo);
    ws.addImage(id, { tl: { col: 3, row: r - 1 }, ext: { width: 120, height: 120 }, editAs: 'oneCell' });
  }
  // タイトル・サブタイトル
  ws.mergeCells(r, 1, r, 3);
  ws.getCell(r, 1).value = cover.title || '';
  ws.getCell(r, 1).font = { bold: true, size: 22 };
  r += 1;
  if (cover.subtitle) {
    ws.mergeCells(r, 1, r, 3);
    ws.getCell(r, 1).value = cover.subtitle;
    ws.getCell(r, 1).font = { size: 12, color: { argb: COLOR_META } };
    r += 1;
  }
  r += 1;
  // 設定済みのメタ項目だけをラベル＋値で並べる
  const fields = [
    ['文書番号', cover.docNumber],
    ['版数', cover.version],
    ['作成者', cover.author],
    ['日付', cover.date],
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    ws.getCell(r, 1).value = label;
    ws.getCell(r, 1).font = { bold: true };
    ws.getCell(r, 2).value = value;
    r += 1;
  }
  // 改訂履歴（1件以上あるときだけ表を出す）
  const revisions = Array.isArray(cover.revisions) ? cover.revisions : [];
  if (revisions.length) {
    r += 1;
    ws.getCell(r, 1).value = '改訂履歴';
    ws.getCell(r, 1).font = { bold: true };
    r += 1;
    const heads = ['版', '日付', '作成者', '内容'];
    heads.forEach((h, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = h;
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEAD } };
      cell.border = BORDER_ALL;
    });
    r += 1;
    for (const rev of revisions) {
      [rev.version, rev.date, rev.author, rev.note].forEach((v, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = v || '';
        cell.border = BORDER_ALL;
        cell.alignment = { wrapText: true, vertical: 'top' };
      });
      r += 1;
    }
  }
  return ws;
}

function buildXlsxWorkbook(ExcelJS, data) {
  const wb = new ExcelJS.Workbook();
  if (data.cover) addCoverSheet(wb, data.cover);

  // チェックリスト本体（3行目=列見出しまでを固定表示）
  const ws = wb.addWorksheet(data.sheetName || 'チェックリスト', {
    views: [{ state: 'frozen', ySplit: 3 }],
  });
  // ws.columns に header を渡すと1行目が見出しになってしまうため width のみ設定
  data.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
  });

  let r = 0;
  for (const row of data.rows) {
    r += 1;
    switch (row.kind) {
      case 'title': {
        ws.mergeCells(r, 1, r, COL_COUNT);
        const cell = ws.getCell(r, 1);
        cell.value = row.text;
        cell.font = { bold: true, size: 14 };
        ws.getRow(r).height = 24;
        break;
      }
      case 'meta': {
        ws.mergeCells(r, 1, r, COL_COUNT);
        const cell = ws.getCell(r, 1);
        cell.value = row.text;
        cell.font = { size: 9, color: { argb: COLOR_META } };
        break;
      }
      case 'header': {
        data.columns.forEach((c, i) => {
          const cell = ws.getCell(r, i + 1);
          cell.value = c.header;
          cell.font = { bold: true, size: 10 };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEAD } };
          cell.border = BORDER_ALL;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });
        break;
      }
      case 'section': {
        ws.mergeCells(r, 1, r, COL_COUNT);
        const cell = ws.getCell(r, 1);
        cell.value = row.meta ? `${row.text}　${row.meta}` : row.text;
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_SECTION } };
        cell.border = BORDER_ALL;
        break;
      }
      case 'item': {
        const values = [row.no, row.text, row.check, row.time, row.note, row.detail];
        values.forEach((v, i) => {
          const cell = ws.getCell(r, i + 1);
          cell.value = v === '' ? null : v;
          cell.border = BORDER_ALL;
          cell.alignment =
            i === 0 || i === 2 || i === 3
              ? { horizontal: 'center', vertical: 'top' }
              : { wrapText: true, vertical: 'top' };
        });
        // 詳細のセル内改行ぶん行高を確保（1行約12pt。exceljs は自動計算しない）
        const lines = String(row.detail || '').split('\n').length;
        if (lines > 1) ws.getRow(r).height = Math.min(200, 14 * lines);
        break;
      }
      case 'images': {
        // その手順の全画像を横並び。行高は最大の1枚（px→pt は 0.75 倍）。
        const imgs = (row.images || []).filter((im) => im.width > 0 && im.height > 0);
        const maxH = imgs.reduce((a, im) => Math.max(a, im.height), 0);
        if (!maxH) break; // 全滅（読めない画像だけ）なら空行のまま
        ws.getRow(r).height = Math.ceil(maxH * 0.75) + 4;
        let x = 8; // 左端の余白(px)。項目列の頭に揃えるため No 列ぶん進める
        const noColPx = (data.columns[0].width || 6) * 7 + 5;
        x += noColPx;
        for (const im of imgs) {
          const image = imageFromDataUrl(im.dataUrl);
          if (!image) continue;
          const id = wb.addImage(image);
          ws.addImage(id, {
            tl: { col: colAtPx(x, data.columns), row: r - 1 + 0.05 },
            ext: { width: im.width, height: im.height },
            editAs: 'oneCell',
          });
          x += im.width + 8; // 画像間ギャップ 8px
        }
        break;
      }
      case 'total': {
        ws.mergeCells(r, 1, r, 2);
        const label = ws.getCell(r, 1);
        label.value = '合計';
        const check = ws.getCell(r, 3);
        check.value = `${row.done} / ${row.total}`;
        check.alignment = { horizontal: 'center' };
        const time = ws.getCell(r, 4);
        time.value = row.totalMin || null;
        time.alignment = { horizontal: 'center' };
        for (let i = 1; i <= COL_COUNT; i++) {
          const cell = ws.getCell(r, i);
          cell.font = { bold: true };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEAD } };
          cell.border = { ...BORDER_ALL, top: { style: 'double', color: { argb: COLOR_LINE } } };
        }
        break;
      }
      default:
        break; // 未知の kind は無視（前方互換）
    }
  }
  return wb;
}

module.exports = { buildXlsxWorkbook };
