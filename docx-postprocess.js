// docx-postprocess — Word(.docx)出力をモダンな手順書デザインに整える後処理。
//
// html-to-docx が生成した docx(zip Buffer) を受け取り、以下を書き換えて返す:
//   (a) styles.xml  : Heading2/Heading4 を「アクセント色の見出し＋細ハイライン」に差し替え。
//                     docDefaults の本文フォント(eastAsia)も游明朝に固定。
//   (b) document.xml: レンダラーのマーカー段落を「表題」「目次(TOCフィールド)」の OOXML に置換。
//                     所要時間の右詰め用マーカー @@DXTAB@@ を右タブ(w:tab)に変換。
//                     見出し段落に直接付く行間指定も除去。
//   (c) footer1.xml : 「ページ / 総ページ」(PAGE / NUMPAGES) の細罫線付き中央フッターに差し替え。
//   (d) settings.xml: 開いたときに目次等のフィールド更新を促す updateFields を挿入。
//
// 配色は表紙(カバー)の差し色に連動する（meta.accent）。表紙が無い場合も既定色でモダン様式にする。
// Electron に依存しない素の Node モジュール（検証スクリプトからも同じ実装を require できる）。
'use strict';

const EA = '游明朝'; // 和文フォント（本文・見出し共通）
const RIGHT_TAB = 9070; // twips ≒ 本文幅160mm。所要時間を行末に右詰めするタブ位置

// 差し色を 6桁HEX（#なし・大文字）に正規化。3桁は展開、8桁(alpha付き)は先頭6桁。
function normalizeHex(v, fallback) {
  let s = String(v || '').replace('#', '').trim();
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  if (/^[0-9a-fA-F]{6,8}$/.test(s)) return s.slice(0, 6).toUpperCase();
  return fallback;
}
// 差し色を白と混ぜて薄くする（tint=白の割合 0..1）。細罫線などに使う。
function lighten(hex, tint) {
  const n = parseInt(hex, 16);
  const mix = (c) => Math.round(c + (255 - c) * tint);
  return [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
    .map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ── 注入する OOXML 断片（accent 依存のため関数）─────────────────
// 注意: pPr の子要素は OOXML スキーマ順（keepNext → pBdr → shd → tabs → spacing →
// ind → jc → outlineLvl → rPr）を厳守すること。順序が崩れると Word が「修復」を要求する。

// 見出し1 → セクション見出し（h2 / Heading2）。
// アクセント色・太字13pt・下側にアクセント色の細ライン。右タブで所要時間を右詰め。
const STYLE_HEADING2 = (accent) =>
`<w:style w:type="paragraph" w:styleId="Heading2">
  <w:name w:val="heading 2" />
  <w:basedOn w:val="Normal" />
  <w:next w:val="Normal" />
  <w:uiPriority w:val="9" />
  <w:unhideWhenUsed />
  <w:qFormat />
  <w:pPr>
    <w:keepNext />
    <w:pBdr>
      <w:bottom w:val="single" w:sz="12" w:space="6" w:color="${accent}" />
    </w:pBdr>
    <w:tabs><w:tab w:val="right" w:pos="${RIGHT_TAB}" /></w:tabs>
    <w:spacing w:before="360" w:after="140" w:line="240" w:lineRule="auto" />
    <w:outlineLvl w:val="0" />
  </w:pPr>
  <w:rPr>
    <w:rFonts w:eastAsia="${EA}" />
    <w:b />
    <w:color w:val="${accent}" />
    <w:sz w:val="26" />
    <w:szCs w:val="26" />
  </w:rPr>
</w:style>`;

// 見出し4 → 手順名（h4 / Heading4）。アプリの編集画面の「手順カード」に寄せる:
// 薄い塗り(F3F6FA)＋左のアクセント太帯＋周囲の細罫のカード。太字11pt、右タブで所要時間を右詰め。
// 行頭の番号は @@DXNUM@@N@@DXNE@@ マーカーを後処理でアクセント色のバッジ run に変換する。
// pPr の子要素は OOXML スキーマ順（keepNext → pBdr → shd → tabs → spacing → ind → outlineLvl → rPr）。
const STYLE_HEADING4 = (accent) =>
`<w:style w:type="paragraph" w:styleId="Heading4">
  <w:name w:val="heading 4" />
  <w:basedOn w:val="Normal" />
  <w:next w:val="Normal" />
  <w:uiPriority w:val="9" />
  <w:unhideWhenUsed />
  <w:qFormat />
  <w:pPr>
    <w:keepNext />
    <w:pBdr>
      <w:top w:val="single" w:sz="4" w:space="6" w:color="E2E8F1" />
      <w:left w:val="single" w:sz="18" w:space="8" w:color="${accent}" />
      <w:bottom w:val="single" w:sz="4" w:space="6" w:color="E2E8F1" />
      <w:right w:val="single" w:sz="4" w:space="6" w:color="E2E8F1" />
    </w:pBdr>
    <w:shd w:val="clear" w:color="auto" w:fill="F3F6FA" />
    <w:tabs><w:tab w:val="right" w:pos="${RIGHT_TAB}" /></w:tabs>
    <w:spacing w:before="180" w:after="60" w:line="264" w:lineRule="auto" />
    <w:outlineLvl w:val="3" />
  </w:pPr>
  <w:rPr>
    <w:rFonts w:eastAsia="${EA}" />
    <w:b />
    <w:sz w:val="22" />
    <w:szCs w:val="22" />
  </w:rPr>
</w:style>`;

// 手順カード行頭の番号バッジ。@@DXNUM@@N@@DXNE@@ をアクセント色地・白抜き太字の run（数字）
// ＋区切りの小スペース run に変換する。直前の run の <w:t> を閉じ、末尾で手順名用の
// <w:t> を開いたままにして、続く手順名テキスト（＋@@DXTAB@@）が同段落に流れるようにする。
const numBadgeReplacement = (accent) =>
  `</w:t></w:r>` +
  `<w:r><w:rPr><w:rFonts w:eastAsia="${EA}" /><w:b /><w:color w:val="FFFFFF" />` +
  `<w:sz w:val="22" /><w:szCs w:val="22" />` +
  `<w:shd w:val="clear" w:color="auto" w:fill="${accent}" /></w:rPr>` +
  `<w:t xml:space="preserve"> $1 </w:t></w:r>` +
  `<w:r><w:rPr><w:rFonts w:eastAsia="${EA}" /><w:b /><w:sz w:val="22" /><w:szCs w:val="22" /></w:rPr>` +
  `<w:t xml:space="preserve">  </w:t></w:r>` +
  `<w:r><w:rPr><w:rFonts w:eastAsia="${EA}" /><w:b /><w:sz w:val="22" /><w:szCs w:val="22" /></w:rPr>` +
  `<w:t xml:space="preserve">`;

// 表題段落（表紙が無効なときのみ document.xml に出る）。箱・灰色地は廃し、
// 大きめ20pt・中央・下にアクセント色の細ライン。titleXml はXMLエスケープ済みで渡すこと。
const titleParagraphXml = (accent, titleXml) =>
`<w:p>
  <w:pPr>
    <w:pBdr>
      <w:bottom w:val="single" w:sz="12" w:space="10" w:color="${accent}" />
    </w:pBdr>
    <w:spacing w:before="360" w:after="360" w:line="520" w:lineRule="auto" />
    <w:jc w:val="center" />
    <w:rPr><w:rFonts w:eastAsia="${EA}" /><w:b /><w:sz w:val="40" /><w:szCs w:val="40" /></w:rPr>
  </w:pPr>
  <w:r>
    <w:rPr><w:rFonts w:eastAsia="${EA}" /><w:b /><w:sz w:val="40" /><w:szCs w:val="40" /></w:rPr>
    <w:t xml:space="preserve">${titleXml}</w:t>
  </w:r>
</w:p>`;

// 「目次」ラベル（アクセント色＋細ライン）＋TOC複合フィールド。w:dirty と settings.xml の
// updateFields の二段構えで、Word で開いたときにフィールド更新（ページ番号付き目次）を促す。
const TOC_XML = (accent) =>
`<w:p>
  <w:pPr>
    <w:pBdr><w:bottom w:val="single" w:sz="8" w:space="6" w:color="${accent}" /></w:pBdr>
    <w:spacing w:before="120" w:after="160" />
    <w:rPr><w:rFonts w:eastAsia="${EA}" /><w:b /><w:color w:val="${accent}" /><w:sz w:val="26" /><w:szCs w:val="26" /></w:rPr>
  </w:pPr>
  <w:r>
    <w:rPr><w:rFonts w:eastAsia="${EA}" /><w:b /><w:color w:val="${accent}" /><w:sz w:val="26" /><w:szCs w:val="26" /></w:rPr>
    <w:t>目次</w:t>
  </w:r>
</w:p>
<w:p>
  <w:r><w:fldChar w:fldCharType="begin" w:dirty="true" /></w:r>
  <w:r><w:instrText xml:space="preserve"> TOC \\o "1-4" \\h \\z \\u </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="separate" /></w:r>
  <w:r><w:t>（目次はここに表示されます。Word で開き、フィールドの更新を許可するか F9 で生成されます）</w:t></w:r>
  <w:r><w:fldChar w:fldCharType="end" /></w:r>
</w:p>`;

// フッター全体（「ページ / 総ページ」中央寄せ・9pt灰色・上にアクセント淡色の細罫）。
// html-to-docx の footer1.xml は変則的な名前空間かつ PAGE のみのため丸ごと置換する。
const FOOTER_XML = (accent) => {
  const rpr = `<w:rPr><w:rFonts w:eastAsia="${EA}" /><w:color w:val="808080" /><w:sz w:val="18" /><w:szCs w:val="18" /></w:rPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>
    <w:pPr>
      <w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="${lighten(accent, 0.55)}" /></w:pBdr>
      <w:jc w:val="center" />
      ${rpr}
    </w:pPr>
    <w:r>${rpr}<w:fldChar w:fldCharType="begin" /></w:r>
    <w:r>${rpr}<w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
    <w:r>${rpr}<w:fldChar w:fldCharType="end" /></w:r>
    <w:r>${rpr}<w:t xml:space="preserve"> / </w:t></w:r>
    <w:r>${rpr}<w:fldChar w:fldCharType="begin" /></w:r>
    <w:r>${rpr}<w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>
    <w:r>${rpr}<w:fldChar w:fldCharType="end" /></w:r>
  </w:p>
</w:ftr>`;
};

// docDefaults（本文既定）の和文フォントを游明朝に固定する。html-to-docx は font 指定を
// ascii/hAnsi 中心に置くため、CJK 用の eastAsia を明示して文書全体を游明朝に統一する。
function setDocDefaultEastAsia(styles, font) {
  const re = /(<w:docDefaults>[\s\S]*?<w:rPrDefault>\s*<w:rPr>[\s\S]*?)<w:rFonts([^>]*?)\/>/;
  if (re.test(styles)) {
    return styles.replace(re, (all, pre, attrs) => {
      const a = attrs.replace(/\s*w:eastAsia="[^"]*"/g, '');
      return pre + '<w:rFonts' + a + ' w:eastAsia="' + font + '"/>';
    });
  }
  // rPrDefault に rFonts が無い場合は差し込む
  return styles.replace(
    /(<w:rPrDefault>\s*<w:rPr>)/,
    '$1<w:rFonts w:eastAsia="' + font + '"/>'
  );
}

// ── 後処理本体 ───────────────────────────────────────────────
// meta = { isTemplate, markerTitle, markerToc, accent }（レンダラー renderDocxView が生成。
// マーカーは「@@DX…@@」形式の英数字トークンで、正規表現エスケープ不要な文字種に限る）。
// meta 無し（旧レンダラー等）でも styles/footer/settings の共通処理だけは行う。
async function postProcessDocx(buffer, meta) {
  const JSZip = require('jszip');
  const m = meta || {};
  const accent = normalizeHex(m.accent, '3B6EA5');
  const zip = await JSZip.loadAsync(buffer);

  // (a) styles.xml: 見出しをモダン様式に、本文フォントを游明朝に
  let styles = await zip.file('word/styles.xml').async('string');
  const replaceStyle = (xml, styleId, replacement) => {
    const re = new RegExp('<w:style w:type="paragraph" w:styleId="' + styleId + '">[\\s\\S]*?</w:style>');
    if (!re.test(xml)) throw new Error('docx後処理: スタイル定義が見つかりません: ' + styleId);
    return xml.replace(re, replacement);
  };
  styles = replaceStyle(styles, 'Heading2', STYLE_HEADING2(accent));
  styles = replaceStyle(styles, 'Heading4', STYLE_HEADING4(accent));
  styles = setDocDefaultEastAsia(styles, EA);
  zip.file('word/styles.xml', styles);

  // (b) document.xml
  let doc = await zip.file('word/document.xml').async('string');
  // html-to-docx は見出し段落の pPr に <w:spacing w:lineRule="auto"/> を直接付けるため、
  // スタイル側の行間・段前後が効くようこれを除去する。
  doc = doc.replace(
    /(<w:pStyle w:val="Heading[1-6]"\s*\/>)\s*<w:spacing w:lineRule="auto"\s*\/>/g,
    '$1'
  );
  // マーカー段落 → OOXML 置換。見つからない場合はトークン文字列だけ除去（フェイルソフト）。
  const paragraphWithMarker = (marker) =>
    new RegExp('<w:p>(?:(?!<w:p>)[\\s\\S])*?' + marker + '[\\s\\S]*?</w:p>');
  if (m.markerTitle) {
    const pM = doc.match(paragraphWithMarker(m.markerTitle));
    if (pM) {
      const tM = pM[0].match(new RegExp('<w:t[^>]*>' + m.markerTitle + '([\\s\\S]*?)</w:t>'));
      doc = doc.replace(pM[0], titleParagraphXml(accent, tM ? tM[1] : ''));
    } else {
      doc = doc.split(m.markerTitle).join('');
    }
  }
  if (m.markerToc) {
    const pM = doc.match(paragraphWithMarker(m.markerToc));
    if (pM) doc = doc.replace(pM[0], TOC_XML(accent));
    else doc = doc.split(m.markerToc).join('');
  }
  // 手順番号のバッジ化: @@DXNUM@@N@@DXNE@@ をアクセント色のバッジ run に変換（@@DXTAB@@ より先）。
  doc = doc.replace(/@@DXNUM@@(\d+)@@DXNE@@/g, numBadgeReplacement(accent));
  // 所要時間の右詰め: @@DXTAB@@ を右タブに変換。見出し run を閉じ、灰色の別 run で
  // タブ＋時間を出す（時間は見出しの太字を継がず、控えめな灰色にしてモダンに見せる）。
  const timeRunPr = `<w:rPr><w:rFonts w:eastAsia="${EA}" /><w:color w:val="808080" /></w:rPr>`;
  doc = doc.split('@@DXTAB@@').join(`</w:t></w:r><w:r>${timeRunPr}<w:tab/><w:t xml:space="preserve">`);
  zip.file('word/document.xml', doc);

  // (c) footer1.xml
  if (zip.file('word/footer1.xml')) zip.file('word/footer1.xml', FOOTER_XML(accent));

  // (d) settings.xml: 開時のフィールド更新（目次生成）を促す
  let settings = await zip.file('word/settings.xml').async('string');
  if (!settings.includes('w:updateFields')) {
    settings = settings.replace(
      '<w:zoom w:percent="100"/>',
      '<w:zoom w:percent="100"/><w:updateFields w:val="true"/>'
    );
  }
  zip.file('word/settings.xml', settings);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { postProcessDocx };
