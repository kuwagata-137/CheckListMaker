'use strict';
// 3-C: 現状 Word(.docx) 出力の OOXML 回帰テスト（＝ゴールデンを自動テストで固定）。
//
// html-to-docx で docx を生成 → docx-postprocess.js で後処理 → JSZip で OOXML を検査し、
// 後処理が担保する「見た目の骨格」を固定する。html-to-docx→docx パッケージへ移行する場合、
// このテストが「移行前後で見た目が変わっていないか」を機械検出する回帰基準になる
//（現状ゴールデンも自動テストも無い＝3-C の調査対象。docs/spec-3-C-docx-migration.md）。
//
// Electron/jsdom 不要の素の Node テスト（html-to-docx・jszip は Node で動く）。
// main.js saveDocx と同じ options で生成し、renderDocxView の出力形状を模した入力を使う。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTMLtoDOCX = require(path.join(ROOT, 'node_modules', 'html-to-docx'));
const JSZip = require(path.join(ROOT, 'node_modules', 'jszip'));
const { postProcessDocx } = require(path.join(ROOT, 'docx-postprocess'));

const MM = 56.6929; // twip / mm（main.js saveDocx と同一）

// main.js saveDocx と同じ options で html-to-docx を呼び、後処理を通して zip を返す。
async function buildDocx(html, meta) {
  const buffer = await HTMLtoDOCX(html, null, {
    orientation: 'portrait',
    pageSize: { width: Math.round(210 * MM), height: Math.round(297 * MM) },
    margins: {
      top: Math.round(25 * MM), right: Math.round(25 * MM),
      bottom: Math.round(25 * MM), left: Math.round(25 * MM),
      header: 720, footer: 720, gutter: 0,
    },
    table: { row: { cantSplit: true } },
    footer: true, pageNumber: true, font: '游ゴシック', fontSize: 21, complexScriptFontSize: 21, lang: 'ja-JP',
  });
  const processed = await postProcessDocx(buffer, meta || {});
  const zip = await JSZip.loadAsync(processed);
  const part = (name) => zip.file('word/' + name).async('string');
  return {
    document: await part('document.xml'),
    styles: await part('styles.xml'),
    footer: await part('footer1.xml'),
    settings: await part('settings.xml'),
  };
}

// renderDocxView（テンプレート型・表紙なし）の出力形状を模した代表入力。
// マーカーは固定（renderDocxView は乱数トークンだが、後処理はトークン文字列で照合するだけ）。
const META = { isTemplate: true, markerTitle: '@@DXTITLEt@@', markerToc: '@@DXTOCt@@', accent: '#3b6ea5' };
const HTML = [
  '<!DOCTYPE html><html><head></head><body>',
  '<p>@@DXTITLEt@@サンプル手順書</p>',            // 表題マーカー段落
  '<p>@@DXTOCt@@</p>',                            // 目次マーカー段落
  '<h2>準備@@DXTAB@@⏱5分</h2>',                  // セクション見出し＋所要時間（右詰め）
  '<h4>@@DXNUM@@1@@DXNE@@電源を入れる@@DXTAB@@⏱2分</h4>', // 手順カード（番号バッジ＋手順名＋所要時間）
  '<p>本文テキスト</p>',
  '</body></html>',
].join('');

test('3-C docx 回帰 — 後処理が生成する OOXML 骨格を固定する', async (t) => {
  const out = await buildDocx(HTML, META);

  await t.test('document.xml — 表題・目次フィールド・マーカー除去・右タブ', () => {
    // 表題段落（20pt=sz40）に置換される
    assert.match(out.document, /<w:sz w:val="40"\s*\/>/, '表題段落 sz40 が注入される');
    // 目次は TOC 複合フィールドに置換される
    assert.ok(out.document.includes('TOC \\o "1-4" \\h \\z \\u'), 'TOC フィールドが注入される');
    assert.ok(out.document.includes('fldCharType="begin" w:dirty="true"'), 'TOC フィールドが dirty で更新を促す');
    assert.ok(out.document.includes('目次'), '目次ラベルが入る');
    // @@ マーカーは一切残らない
    assert.ok(!out.document.includes('@@'), 'マーカートークンが残らない');
    // 所要時間の @@DXTAB@@ は右タブ run に変換される
    assert.ok(out.document.includes('<w:tab/>'), '@@DXTAB@@ が右タブ run になる');
    // 手順番号 @@DXNUM@@N@@DXNE@@ はアクセント色地・白抜きのバッジ run になる
    assert.match(
      out.document,
      /<w:color w:val="FFFFFF"[\s\S]*?<w:shd w:val="clear" w:color="auto" w:fill="3B6EA5"[\s\S]*?<w:t xml:space="preserve"> 1 <\/w:t>/,
      '手順番号がアクセント色のバッジ run になる'
    );
    // 見出しは Heading2/Heading4 スタイル参照になる
    assert.ok(out.document.includes('<w:pStyle w:val="Heading2"'), 'Heading2 参照');
    assert.ok(out.document.includes('<w:pStyle w:val="Heading4"'), 'Heading4 参照');
    // html-to-docx が見出しに直付けする lineRule は除去される（スタイル側の行間を効かせる）
    assert.doesNotMatch(
      out.document,
      /<w:pStyle w:val="Heading[1-6]"\s*\/>\s*<w:spacing w:lineRule="auto"/,
      '見出しへの直付け spacing が除去される'
    );
  });

  await t.test('styles.xml — 見出し様式と和文フォント', () => {
    assert.match(out.styles, /Heading2[\s\S]*?w:color w:val="3B6EA5"/, 'Heading2 がアクセント色');
    assert.match(out.styles, /Heading2[\s\S]*?<w:bottom w:val="single"/, 'Heading2 に下罫線');
    assert.match(out.styles, /Heading4[\s\S]*?<w:bottom w:val="single"/, 'Heading4 に下罫線');
    // Heading4（手順カード）は薄い塗り＋左アクセント太帯のカード様式
    assert.match(out.styles, /Heading4[\s\S]*?<w:left w:val="single" w:sz="18" w:space="8" w:color="3B6EA5"/, 'Heading4 に左アクセント帯');
    assert.match(out.styles, /Heading4[\s\S]*?<w:shd w:val="clear" w:color="auto" w:fill="F3F6FA"/, 'Heading4 がカード塗り');
    assert.match(out.styles, /<w:docDefaults>[\s\S]*?w:eastAsia="游ゴシック"/, 'docDefaults の和文フォントが游ゴシック');
  });

  await t.test('footer1.xml — PAGE / SECTIONPAGES 中央フッター（本文のみの通し番号）', () => {
    assert.ok(out.footer.includes('PAGE'), 'PAGE フィールド');
    assert.ok(out.footer.includes('SECTIONPAGES'), 'SECTIONPAGES フィールド（本文セクションのページ数）');
    assert.ok(!out.footer.includes('NUMPAGES'), 'NUMPAGES は使わない（表紙・目次を数えない）');
    assert.match(out.footer, /<w:jc w:val="center"\s*\/>/, '中央寄せ');
  });

  await t.test('settings.xml — 開時のフィールド更新', () => {
    assert.ok(out.settings.includes('w:updateFields w:val="true"'), 'updateFields が挿入される');
  });
});

test('3-C docx 回帰 — accent 差し色が見出し・フッターに反映される', async (t) => {
  const out = await buildDocx('<!DOCTYPE html><html><body><h2>章</h2></body></html>',
    { isTemplate: true, accent: '#C0392B' });
  await t.test('アクセント色が styles に流れる', () => {
    assert.match(out.styles, /Heading2[\s\S]*?w:color w:val="C0392B"/, '指定 accent が Heading2 に反映');
  });
});

test('docx セクション分け — 表紙・目次を除外して本文のみ 1..N のページ番号', async (t) => {
  // 表紙（画像）＋目次＋区切りマーカー＋本文。markerSecBrk があると本文をセクション2に分ける。
  const meta = { isTemplate: true, markerTitle: '', markerToc: '@@DXTOCs@@', markerSecBrk: '@@DXSECBRK@@', accent: '#3b6ea5' };
  const html = [
    '<!DOCTYPE html><html><body>',
    '<p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" width="605" height="856" /></p>',
    '<div class="page-break" style="page-break-after: always;"></div>',
    '<p>@@DXTOCs@@</p>',
    '<p>@@DXSECBRK@@</p>',
    '<h2>本文セクション</h2><h4>@@DXNUM@@1@@DXNE@@手順</h4><p>本文</p>',
    '</body></html>',
  ].join('');
  const out = await buildDocx(html, meta);
  const sects = out.document.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g) || [];

  await t.test('セクションが2つに分かれる（表紙・目次／本文）', () => {
    assert.equal(sects.length, 2, 'sectPr が2つ');
    assert.ok(!out.document.includes('@@'), 'マーカーが残らない');
  });
  await t.test('セクション1（表紙・目次）は次ページ開始・フッター無し（番号なし）', () => {
    const sec1 = sects.find((s) => s.includes('w:type w:val="nextPage"'));
    assert.ok(sec1, 'nextPage のセクション区切りがある');
    assert.ok(!sec1.includes('footerReference'), 'セクション1にフッター参照が無い＝ページ番号を出さない');
  });
  await t.test('本文セクションは1ページ目から採番（pgNumType）＋フッター参照あり', () => {
    const body = sects.find((s) => s.includes('pgNumType'));
    assert.ok(body, 'pgNumType を持つ本文セクションがある');
    assert.match(body, /<w:pgNumType w:start="1"\s*\/>/, '1 ページ目から採番');
    assert.ok(body.includes('footerReference'), '本文セクションにフッター参照あり');
  });
  await t.test('区切りは本文（h2/pgNumType）より前に位置する', () => {
    assert.ok(out.document.indexOf('nextPage') < out.document.indexOf('本文セクション'), 'セクション区切りが本文見出しより前');
    assert.ok(out.document.indexOf('本文セクション') < out.document.indexOf('pgNumType'), '本文 sectPr は本文の後（末尾）');
  });
});

test('3-C docx 回帰 — フェイルソフト（マーカー不在でも壊れない）', async (t) => {
  // markerTitle を meta に指定しても HTML に無い場合、トークン除去のみで例外を出さない。
  const out = await buildDocx('<!DOCTYPE html><html><body><h2>章</h2><p>本文</p></body></html>',
    { isTemplate: true, markerTitle: '@@DXTITLEx@@', markerToc: '@@DXTOCx@@', accent: '#3b6ea5' });
  await t.test('マーカー無しでも後処理が完走する', () => {
    assert.ok(!out.document.includes('@@'), '残存マーカーなし');
    assert.match(out.styles, /Heading2[\s\S]*?w:color w:val="3B6EA5"/, '共通の見出し様式は適用される');
    assert.ok(out.footer.includes('PAGE'), 'フッターは差し替わる');
  });
});
