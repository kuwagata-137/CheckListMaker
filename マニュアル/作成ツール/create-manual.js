// 操作マニュアル（.docx）の生成。写し元は MultipurposeDiagramMaker の マニュアル/作成ツール/create-manual.js。
// 原稿は manual-content.js（ブロックの並び）、画面は capture.js が
// リポジトリのルートの screenshots/manual/ に撮ったもの（寸法は _manifest.json）を使う。リポジトリのルートで:
//   node マニュアル/作成ツール/create-manual.js            … マニュアル/CheckListMaker_操作マニュアル_v<版>.docx を出力（リポジトリで管理）
//   node マニュアル/作成ツール/create-manual.js --preview  … あわせて screenshots/manual/_preview.html（同じ原稿を A4 の HTML にしたもの）を出力
//     ＝Word の無い環境でページの見た目（画像の大きさ・表の崩れ）を確かめる用。改ページの位置は Word と完全には一致しない
// docx はローカル（npm install 済みの devDependencies）を優先し、無ければグローバル導入ぶん・クラウドのセッションの共通の場所を探す。
const fs = require('fs');
const path = require('path');
function requireDocx() {
  try { return require('docx'); } catch (e) { }
  const cands = [path.join(process.env.APPDATA || '', 'npm/node_modules/docx'), '/opt/node22/lib/node_modules/docx', '/opt/node-tools/node_modules/docx'];
  for (const c of cands) { try { return require(c); } catch (e) { } }
  throw new Error('docx が見つかりません。リポジトリのルートで `npm install` を実行してください。');
}
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, Header, Footer, AlignmentType, LevelFormat,
  HeadingLevel, BorderStyle, WidthType, ShadingType, PageBreak,
  PageNumber, VerticalAlign, TableOfContents, TableLayoutType
} = requireDocx();

const shotDir = path.join(__dirname, '..', '..', 'screenshots', 'manual');   // リポジトリのルートの screenshots/manual/
// 版は package.json の version（例: 1.0.13 → v1.0.13）。原稿を直したら LAST_UPDATED も直す
const APP_VERSION = 'v' + require(path.join(__dirname, '..', '..', 'package.json')).version;
const LAST_UPDATED = '2026年11月11日';
const FONT = 'Meiryo UI';
const manifest = JSON.parse(fs.readFileSync(path.join(shotDir, '_manifest.json'), 'utf8'));
const content = require('./manual-content.js')({ APP_VERSION, LAST_UPDATED });
const usedShots = new Set();

// ===================================================================
//  画像の寸法（docx・HTML 共通）
// ===================================================================
// 画像の寸法（CSS px）は撮影時の manifest から。表示幅（文書上の px＝1/96 インチ）は呼び出し側が決める
function shotInfo(name) {
  const m = manifest[name];
  if (!m) throw new Error('画像がありません（capture.js で撮影してください）: ' + name);
  const fp = path.join(shotDir, m.file);
  if (!fs.existsSync(fp)) throw new Error('画像ファイルがありません: ' + fp);
  usedShots.add(name);
  return { ...m, fp, type: m.file.endsWith('.png') ? 'png' : 'jpg' };
}
const CROP_SCALE = 0.75;     // 切り抜きは画面の 1px＝文書の 0.75px（UI の 12px の文字が約 7pt）
const MAX_W = 640;           // 本文幅（約 680px）に収める上限
// 表示サイズ: width 指定＞scale 指定＞（全画面＝MAX_W／切り抜き＝CROP_SCALE）。maxW・maxH で上限
function dispSize(info, o = {}) {
  let w;
  if (o.width) w = o.width;
  else if (o.scale) w = info.w * o.scale;
  else w = info.file.endsWith('.jpg') ? MAX_W : info.w * CROP_SCALE;
  w = Math.min(w, o.maxW || MAX_W);
  let h = w * info.h / info.w;
  if (o.maxH && h > o.maxH) { h = o.maxH; w = h * info.w / info.h; }
  return { w: Math.round(w), h: Math.round(h) };
}
const ICON_SCALE = 0.8;     // 表の中のボタン画像
const INLINE_H = 20;       // 行内のボタン画像の高さ（文書の px）

// ===================================================================
//  docx への描画
// ===================================================================
const D = (() => {
  const FULL_W = 10200;   // 表の全幅（twips）
  const thin = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
  const allThin = { top: thin, bottom: thin, left: thin, right: thin };
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const allNone = { top: none, bottom: none, left: none, right: none };
  let fig = 0;

  function imgRun(name, o = {}) {
    const info = shotInfo(name);
    const { w, h } = dispSize(info, o);
    return new ImageRun({ type: info.type, data: fs.readFileSync(info.fp), transformation: { width: w, height: h }, altText: { title: name, description: o.alt || name, name } });
  }
  function runs(parts, size = 21) {
    if (!Array.isArray(parts)) parts = [parts];
    const out = [];
    for (const p of parts) {
      if (p == null) continue;
      if (typeof p === 'string') out.push(new TextRun({ text: p, font: FONT, size }));
      else if (p.b) out.push(new TextRun({ text: p.b, font: FONT, size, bold: true }));
      else if (p.k) out.push(new TextRun({ text: p.k, font: FONT, size, bold: true, color: '1F4E79' }));
      else if (p.red) out.push(new TextRun({ text: p.red, font: FONT, size, color: 'C00000' }));
      else if (p.gray) out.push(new TextRun({ text: p.gray, font: FONT, size, color: '555555' }));
      else if (p.icon) out.push(imgRun(p.icon, { scale: p.scale || ICON_SCALE, maxW: p.maxW || 200, maxH: p.maxH || INLINE_H }));
    }
    return out;
  }
  const paras = (txt, size) => (Array.isArray(txt) && Array.isArray(txt[0]) ? txt : [txt]).map((t, i, a) => new Paragraph({ spacing: { after: i < a.length - 1 ? 60 : 0 }, children: runs(t, size) }));
  function caption(text) {
    return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: '図' + (++fig) + ': ' + text, font: FONT, size: 18, italics: true, color: '666666' })] });
  }
  const cell = (w, children, o = {}) => new TableCell({
    width: { size: w, type: WidthType.DXA }, borders: o.borders || allThin, verticalAlign: o.va || VerticalAlign.CENTER,
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR } : undefined,
    margins: o.m || { top: 50, bottom: 50, left: 100, right: 100 }, children,
  });
  const table = (widths, rows, o = {}) => new Table({ width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, alignment: o.align, rows });
  const headRow = (heads, widths) => new TableRow({ tableHeader: true, cantSplit: true, children: heads.map((h, i) => cell(widths[i], [new Paragraph({ children: [new TextRun({ text: h, font: FONT, size: 19, bold: true, color: 'FFFFFF' })] })], { fill: '2E75B6' })) });
  function calloutTable(items) {
    const w = [560, 2400, FULL_W - 2960];
    return table(w, items.map((it, i) => new TableRow({
      cantSplit: true, children: [
        cell(w[0], [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(it.n || i + 1), font: 'Arial', size: 20, bold: true, color: 'FFFFFF' })] })], { fill: 'DC2626', m: { top: 40, bottom: 40, left: 60, right: 60 } }),
        cell(w[1], [new Paragraph({ children: runs([{ b: it.name }], 19) })], { fill: 'F3F6FA', m: { top: 40, bottom: 40, left: 100, right: 100 } }),
        cell(w[2], paras(it.desc || '', 19), { m: { top: 40, bottom: 40, left: 100, right: 100 } }),
      ]
    })));
  }
  function box(kind, parts) {
    const c = kind === 'warn' ? { line: 'C00000', fill: 'FDECEC', tag: '[注意] ' } : { line: '2E75B6', fill: 'EBF5FF', tag: '[ヒント] ' };
    return table([FULL_W], [new TableRow({
      cantSplit: true, children: [new TableCell({
        width: { size: FULL_W, type: WidthType.DXA },
        borders: { top: { style: BorderStyle.SINGLE, size: 1, color: c.line }, bottom: { style: BorderStyle.SINGLE, size: 1, color: c.line }, left: { style: BorderStyle.SINGLE, size: 12, color: c.line }, right: { style: BorderStyle.SINGLE, size: 1, color: c.line } },
        shading: { fill: c.fill, type: ShadingType.CLEAR }, margins: { top: 100, bottom: 100, left: 200, right: 200 },
        children: [new Paragraph({ children: [new TextRun({ text: c.tag, font: FONT, size: 20, bold: true, color: c.line }), ...runs(parts, 20)] })]
      })]
    })]);
  }
  const sp = (n = 160) => new Paragraph({ spacing: { before: n }, children: [] });

  function render(b) {
    switch (b.t) {
      case 'toc': return [new TableOfContents('目次', { hyperlink: true, headingStyleRange: '1-2' })];   // 3 段目まで入れると目次だけで 3 ページになる
      case 'br': return [new Paragraph({ children: [new PageBreak()] })];
      case 'sp': return [sp(b.n)];
      case 'h': {
        // 4 段目＝番号なしの小見出し（見出しスタイルを使わない＝目次・ナビゲーションに出さない）
        if (b.l === 4) return [new Paragraph({ keepNext: true, spacing: { before: 160, after: 60 }, children: [new TextRun({ text: '■ ' + b.text, font: FONT, size: 22, bold: true, color: '404040' })] })];
        const sizes = { 1: 32, 2: 28, 3: 24 }, colors = { 1: '1F4E79', 2: '2E75B6', 3: '404040' };
        const hl = b.l === 1 ? HeadingLevel.HEADING_1 : b.l === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
        return [new Paragraph({ heading: hl, keepNext: true, pageBreakBefore: !!b.o.newPage, spacing: { before: b.l === 1 ? 360 : 240, after: 120 }, children: [new TextRun({ text: b.text, font: FONT, size: sizes[b.l], bold: true, color: colors[b.l] })] })];
      }
      case 'p': return [new Paragraph({ spacing: { before: 80, after: 80 }, keepNext: !!b.o.keepNext, children: runs(b.parts) })];
      case 'note': return [new Paragraph({ spacing: { before: 60, after: 60 }, children: runs([{ gray: '※ ' }, ...b.parts.map(x => typeof x === 'string' ? { gray: x } : x)], 20) })];
      case 'bullet': return [new Paragraph({ numbering: { reference: 'bullets', level: b.level }, spacing: { before: 40, after: 40 }, children: runs(b.parts) })];
      case 'box': return [box(b.kind, b.parts), sp(60)];
      case 'fig': {
        const out = [new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 160, after: 60 }, children: [imgRun(b.img, b.o)] })];
        if (b.cap) out.push(caption(b.cap));
        if (b.o.callouts) { out.push(calloutTable(b.o.callouts)); out.push(sp(80)); }
        return out;
      }
      case 'steps': {
        const W3 = b.o.imgCol || 5600, W1 = 620, W2 = FULL_W - W1 - W3, imgMax = Math.floor(W3 / 15) - 16;
        const rows = b.list.map((s, i) => new TableRow({
          cantSplit: true, children: [
            cell(W1, [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(i + 1), font: 'Arial', size: 28, bold: true, color: 'FFFFFF' })] })], { fill: '2E75B6', m: { top: 40, bottom: 40, left: 40, right: 40 } }),
            cell(W2, paras(s.text, 20), { m: { top: 80, bottom: 80, left: 140, right: 120 } }),
            cell(W3, [new Paragraph({ alignment: AlignmentType.CENTER, children: s.img ? [imgRun(s.img, { maxW: imgMax, scale: s.scale, maxH: s.maxH || 330 })] : [] })], { m: { top: 60, bottom: 60, left: 60, right: 60 } }),
          ]
        }));
        return [table([W1, W2, W3], rows), ...(b.o.caption ? [caption(b.o.caption)] : [sp(40)]), sp(60)];
      }
      case 'pair': {
        const n = b.list.length, W = Math.floor(FULL_W / n), imgMax = Math.floor(W / 15) - 14;
        const row = new TableRow({
          cantSplit: true, children: b.list.map(it => cell(W, [
            new Paragraph({ alignment: AlignmentType.CENTER, children: [imgRun(it.img, { maxW: imgMax, scale: it.scale, maxH: b.o.maxH || 420 })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40 }, children: [new TextRun({ text: it.cap, font: FONT, size: 18, bold: true, color: '1F4E79' })] }),
          ], { borders: allNone, va: VerticalAlign.BOTTOM, m: { top: 40, bottom: 40, left: 60, right: 60 } }))
        });
        return [table(Array(n).fill(W), [row]), ...(b.cap ? [caption(b.cap)] : []), sp(60)];
      }
      case 'itab': {
        const W1 = b.o.w1 || 2200, W2 = b.o.w2 || 2300, W3 = FULL_W - W1 - W2, imgMax = Math.floor(W1 / 15) - 14;
        const rows = b.rows.map(([img, name, desc]) => new TableRow({
          cantSplit: true, children: [
            cell(W1, [new Paragraph({ alignment: AlignmentType.CENTER, children: img ? [imgRun(img, { scale: b.o.scale || ICON_SCALE, maxW: imgMax, maxH: b.o.maxH || 70 })] : [] })], { m: { top: 50, bottom: 50, left: 60, right: 60 } }),
            cell(W2, [new Paragraph({ children: runs([{ b: name }], 19) })]),
            cell(W3, paras(desc, 19)),
          ]
        }));
        return [table([W1, W2, W3], [headRow(b.head, [W1, W2, W3]), ...rows]), sp(100)];
      }
      case 'tab': {
        const w = b.o.w || [2800, 7400];
        const rows = b.rows.map(r => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(w[i], paras(i === 0 && typeof c === 'string' ? [{ b: c }] : c, 19))) }));
        return [table(w, [headRow(b.head, w), ...rows]), sp(100)];
      }
      default: throw new Error('未知のブロック: ' + b.t);
    }
  }

  function build(body) {
    const children = body.flatMap(render);
    const metaRow = (label, value) => new TableRow({ children: [
      cell(2000, [new Paragraph({ children: [new TextRun({ text: label, font: FONT, size: 20, bold: true })] })], { fill: 'D6E4F0', m: { top: 60, bottom: 60, left: 120, right: 120 } }),
      cell(3000, [new Paragraph({ children: [new TextRun({ text: value, font: FONT, size: 20 })] })], { m: { top: 60, bottom: 60, left: 120, right: 120 } }),
    ] });
    const pageProps = { page: { size: { width: 11906, height: 16838 }, margin: { top: 1418, right: 567, bottom: 1134, left: 1134 } } };
    const c = content.cover;
    const cover = {
      properties: { ...pageProps, titlePage: true },
      children: [
        new Paragraph({ spacing: { before: 1400 }, children: [] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: c.title, font: FONT, size: 56, bold: true, color: '1F4E79' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: c.app, font: FONT, size: 36, color: '2E75B6' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 500 }, children: [new TextRun({ text: c.sub, font: FONT, size: 28, color: '404040' })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 800 }, children: [imgRun(c.img, { width: 560 })] }),
        table([2000, 3000], c.meta.map(([a, b]) => metaRow(a, b)), { align: AlignmentType.CENTER }),
      ]
    };
    const hdr = new Header({ children: [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '2E75B6', space: 4 } }, children: [new TextRun({ text: 'CheckListMaker ' + APP_VERSION + ' 操作マニュアル', font: FONT, size: 18, color: '2E75B6' })] })] });
    const ftr = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC', space: 4 } }, children: [
      new TextRun({ text: 'Page ', font: FONT, size: 18, color: '808080' }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18, color: '808080' }),
      new TextRun({ text: ' / ', font: FONT, size: 18, color: '808080' }), new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 18, color: '808080' }),
    ] })] });
    return new Document({
      features: { updateFields: true },   // 開いたときに目次を更新（docx の目次はフィールド＝作成直後は空）
      styles: {
        default: { document: { run: { font: FONT, size: 21 } } },
        paragraphStyles: [
          { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, font: FONT, color: '1F4E79' }, paragraph: { spacing: { before: 360, after: 120 }, outlineLevel: 0 } },
          { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true, font: FONT, color: '2E75B6' }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
          { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, font: FONT, color: '404040' }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } },
        ]
      },
      numbering: { config: [{ reference: 'bullets', levels: [
        { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        { level: 1, format: LevelFormat.BULLET, text: '◦', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 360 } } } },
      ] }] },
      sections: [cover, { properties: { ...pageProps }, headers: { default: hdr }, footers: { default: ftr }, children }],
    });
  }
  return { build, figCount: () => fig };
})();

// ===================================================================
//  HTML プレビュー（Word の無い環境で見た目を確かめる用）
// ===================================================================
const Hh = (() => {
  let fig = 0;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const img = (name, o = {}) => { const info = shotInfo(name); const { w, h } = dispSize(info, o); return `<img src="${esc(info.file)}" style="width:${w}px;height:${h}px">`; };
  function runs(parts) {
    if (!Array.isArray(parts)) parts = [parts];
    return parts.map(p => {
      if (p == null) return '';
      if (typeof p === 'string') return esc(p);
      if (p.b) return '<b>' + esc(p.b) + '</b>';
      if (p.k) return '<b class="k">' + esc(p.k) + '</b>';
      if (p.red) return '<span class="red">' + esc(p.red) + '</span>';
      if (p.gray) return '<span class="gray">' + esc(p.gray) + '</span>';
      if (p.icon) return img(p.icon, { scale: p.scale || ICON_SCALE, maxW: p.maxW || 200, maxH: p.maxH || INLINE_H }).replace('<img', '<img class="ico"');
      return '';
    }).join('');
  }
  const paras = (txt) => (Array.isArray(txt) && Array.isArray(txt[0]) ? txt : [txt]).map(t => '<div>' + runs(t) + '</div>').join('');
  const cap = (t) => `<div class="cap">図${++fig}: ${esc(t)}</div>`;
  const tw = (t) => (t / 15).toFixed(0) + 'px';   // twips → px
  function render(b) {
    switch (b.t) {
      case 'toc': return '<h1 class="toc">目次</h1><div id="toc"></div>';
      case 'br': return '<div class="br"></div>';
      case 'sp': return `<div style="height:${(b.n || 160) / 15}px"></div>`;
      case 'h': return `<h${b.l}${b.o.newPage ? ' class="np"' : ''}>${esc(b.text)}</h${b.l}>`;
      case 'p': return '<p>' + runs(b.parts) + '</p>';
      case 'note': return '<p class="note">※ ' + runs(b.parts) + '</p>';
      case 'bullet': return `<p class="bl l${b.level}">` + runs(b.parts) + '</p>';
      case 'box': return `<div class="box ${b.kind}"><b>${b.kind === 'warn' ? '[注意] ' : '[ヒント] '}</b>${runs(b.parts)}</div>`;
      case 'fig': {
        let s = '<div class="fig">' + img(b.img, b.o) + '</div>' + (b.cap ? cap(b.cap) : '');
        if (b.o.callouts) s += '<table class="co">' + b.o.callouts.map((c, i) => `<tr><td class="n">${c.n || i + 1}</td><td class="nm">${esc(c.name)}</td><td>${paras(c.desc || '')}</td></tr>`).join('') + '</table>';
        return s;
      }
      case 'steps': {
        const W3 = b.o.imgCol || 5600, imgMax = Math.floor(W3 / 15) - 16;
        return '<table class="st">' + b.list.map((s, i) => `<tr><td class="n">${i + 1}</td><td class="tx">${paras(s.text)}</td><td class="im" style="width:${tw(W3)}">${s.img ? img(s.img, { maxW: imgMax, scale: s.scale, maxH: s.maxH || 330 }) : ''}</td></tr>`).join('') + '</table>' + (b.o.caption ? cap(b.o.caption) : '');
      }
      case 'pair': {
        const n = b.list.length, W = Math.floor(10200 / n), imgMax = Math.floor(W / 15) - 14;
        return '<table class="pair"><tr>' + b.list.map(it => `<td>${img(it.img, { maxW: imgMax, scale: it.scale, maxH: b.o.maxH || 420 })}<div class="pc">${esc(it.cap)}</div></td>`).join('') + '</tr></table>' + (b.cap ? cap(b.cap) : '');
      }
      case 'itab': {
        const W1 = b.o.w1 || 2200, W2 = b.o.w2 || 2300, imgMax = Math.floor(W1 / 15) - 14;
        return `<table class="it"><tr><th style="width:${tw(W1)}">${esc(b.head[0])}</th><th style="width:${tw(W2)}">${esc(b.head[1])}</th><th>${esc(b.head[2])}</th></tr>` +
          b.rows.map(([im, nm, d]) => `<tr><td class="c">${im ? img(im, { scale: b.o.scale || ICON_SCALE, maxW: imgMax, maxH: b.o.maxH || 70 }) : ''}</td><td><b>${esc(nm)}</b></td><td>${paras(d)}</td></tr>`).join('') + '</table>';
      }
      case 'tab': {
        const w = b.o.w || [2800, 7400];
        return '<table class="it"><tr>' + b.head.map((h, i) => `<th style="width:${tw(w[i])}">${esc(h)}</th>`).join('') + '</tr>' +
          b.rows.map(r => '<tr>' + r.map((c, i) => '<td>' + (i === 0 && typeof c === 'string' ? '<b>' + esc(c) + '</b>' : paras(c)) + '</td>').join('') + '</tr>').join('') + '</table>';
      }
    }
    return '';
  }
  function build(body) {
    const c = content.cover;
    const css = `
@page{size:A4;margin:25mm 10mm 20mm 20mm}
body{font-family:'Meiryo UI',sans-serif;font-size:10.5pt;color:#000;margin:0}
h1{font-size:16pt;color:#1F4E79;margin:18pt 0 6pt;break-after:avoid}
h1:not(.toc){break-before:auto}
h2{font-size:14pt;color:#2E75B6;margin:12pt 0 6pt;break-after:avoid}
h3{font-size:12pt;color:#404040;margin:10pt 0 4pt;break-after:avoid}
h4{font-size:11pt;color:#404040;margin:8pt 0 3pt;break-after:avoid}h4::before{content:'■ '}
.np{break-before:page}
p{margin:4pt 0}
.note{color:#555;font-size:10pt}
.bl{margin:2pt 0 2pt 18pt;text-indent:-9pt}.bl::before{content:'•  '}.bl.l1{margin-left:36pt}
.k{color:#1F4E79}.red{color:#C00000}.gray{color:#555}
.ico{vertical-align:middle}
.br{break-after:page}
.fig{text-align:center;margin:8pt 0 3pt;break-after:avoid}
.cap{text-align:center;font-size:9pt;font-style:italic;color:#666;margin-bottom:8pt}
table{border-collapse:collapse;width:680px;margin:2pt 0 8pt}
td,th{border:1px solid #ccc;padding:3px 6px;font-size:9.5pt;vertical-align:middle}
tr{break-inside:avoid}
th{background:#2E75B6;color:#fff;text-align:left}
.co td.n{background:#DC2626;color:#fff;font-weight:700;text-align:center;width:28px;font-family:Arial}
.co td.nm{background:#F3F6FA;font-weight:700;width:150px}
.st td.n{background:#2E75B6;color:#fff;font-size:14pt;font-weight:700;text-align:center;width:30px;font-family:Arial}
.st td.tx{font-size:10pt}.st td.tx div{margin-bottom:3pt}
.st td.im{text-align:center}
.pair td{border:none;text-align:center;vertical-align:bottom}.pc{font-size:9pt;font-weight:700;color:#1F4E79}
.it td.c{text-align:center}
.box{border:1px solid;border-left-width:5px;padding:6px 12px;margin:4pt 0 8pt;font-size:10pt;break-inside:avoid}
.box.tip{border-color:#2E75B6;background:#EBF5FF}.box.tip b:first-child{color:#2E75B6}
.box.warn{border-color:#C00000;background:#FDECEC}.box.warn b:first-child{color:#C00000}
.cover{text-align:center;break-after:page;padding-top:60px}
.cover .t{font-size:28pt;font-weight:700;color:#1F4E79;margin-bottom:14pt}
.cover .a{font-size:18pt;color:#2E75B6;margin-bottom:8pt}.cover .s{font-size:14pt;color:#404040;margin-bottom:24pt}
.cover table{width:340px;margin:30pt auto 0}.cover td{font-size:10pt;text-align:left}
#toc div{font-size:10pt;margin:1pt 0}#toc .l2{margin-left:14pt}#toc .l3{margin-left:28pt;color:#444}
`;
    const html = body.map(render).join('\n');
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>manual preview</title><style>${css}</style></head><body>
<div class="cover"><div class="t">${esc(c.title)}</div><div class="a">${esc(c.app)}</div><div class="s">${esc(c.sub)}</div>${img(c.img, { width: 560 })}
<table>${c.meta.map(([a, b]) => `<tr><td style="background:#D6E4F0;font-weight:700">${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</table></div>
${html}
<script>const t=document.getElementById('toc');if(t)document.querySelectorAll('h1:not(.toc),h2').forEach(h=>{const d=document.createElement('div');d.className='l'+h.tagName[1];d.textContent=h.textContent;t.appendChild(d);});</script>
</body></html>`;
  }
  return { build };
})();

// ===================================================================
//  出力
// ===================================================================
const doc = D.build(content.body);
Packer.toBuffer(doc).then(buffer => {
  const outDir = path.join(__dirname, '..');   // マニュアル/（このスクリプトは マニュアル/作成ツール/ にある）
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'CheckListMaker_操作マニュアル_' + APP_VERSION + '.docx');
  fs.writeFileSync(outPath, buffer);
  console.log('Manual created: ' + outPath);
  console.log('Size: ' + (buffer.length / 1024 / 1024).toFixed(1) + ' MB / 図 ' + D.figCount() + ' 点 / 画像 ' + usedShots.size + ' 枚');
  if (process.argv.includes('--preview')) {
    const pv = path.join(shotDir, '_preview.html');
    fs.writeFileSync(pv, Hh.build(content.body));
    console.log('Preview: ' + pv);
  }
  const unused = Object.keys(manifest).filter(k => !usedShots.has(k));
  if (unused.length) console.log('未使用の画像 ' + unused.length + ' 枚: ' + unused.join(' '));
});
