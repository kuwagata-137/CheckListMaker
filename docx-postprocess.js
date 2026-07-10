// docx-postprocess — Word(.docx)出力を社内様式「操作説明書様式」のデザインに寄せる後処理。
//
// html-to-docx が生成した docx(zip Buffer) を受け取り、以下を書き換えて返す:
//   (a) styles.xml  : Heading2/Heading4 の定義を様式の「見出し1」「見出し4」相当に差し替え
//   (b) document.xml: レンダラーが埋めたマーカー段落を「表題」「目次(TOCフィールド)」の
//                     OOXML に置換。見出し段落に直接付く行間指定も除去
//   (c) footer1.xml : 「ページ / 総ページ」(PAGE / NUMPAGES) の中央寄せフッターに丸ごと差し替え
//                     （html-to-docx の pageNumber は PAGE のみで NUMPAGES 非対応のため）
//   (d) settings.xml: 開いたときに目次等のフィールド更新を促す updateFields を挿入
//
// Electron に依存しない素の Node モジュールにしてある（検証スクリプトからも同じ実装を
// require して、検証と本番の乖離をなくすため）。
'use strict';

// ── 注入する OOXML 断片 ──────────────────────────────────────
// 注意: pPr の子要素は OOXML スキーマ順（keepNext → pBdr → shd → spacing → ind →
// jc → outlineLvl → rPr）を厳守すること。順序が崩れると Word が「修復」を要求する。

// 様式「見出し1」→ セクション見出し（h2 / Heading2）に流用。
// 14pt太字・ＭＳ Ｐゴシック・灰色地・左太罫線＋上下右罫線。outlineLvl 0 で目次レベル1。
const STYLE_HEADING2 =
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
      <w:top w:val="single" w:sz="8" w:space="1" w:color="262626" />
      <w:left w:val="single" w:sz="48" w:space="4" w:color="262626" />
      <w:bottom w:val="single" w:sz="8" w:space="1" w:color="262626" />
      <w:right w:val="single" w:sz="8" w:space="4" w:color="262626" />
    </w:pBdr>
    <w:shd w:val="clear" w:color="auto" w:fill="D9D9D9" />
    <w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="atLeast" />
    <w:outlineLvl w:val="0" />
  </w:pPr>
  <w:rPr>
    <w:rFonts w:eastAsia="ＭＳ Ｐゴシック" />
    <w:b />
    <w:sz w:val="28" />
    <w:szCs w:val="28" />
  </w:rPr>
</w:style>`;

// 様式「見出し4」→ 手順名（h4 / Heading4）に流用。
// 太字（文字サイズは既定10.5ptを継承）・点線の下罫線。outlineLvl 3 で目次レベル4。
const STYLE_HEADING4 =
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
      <w:bottom w:val="dotted" w:sz="6" w:space="1" w:color="1F3864" />
    </w:pBdr>
    <w:spacing w:before="50" w:after="50" w:line="260" w:lineRule="atLeast" />
    <w:outlineLvl w:val="3" />
  </w:pPr>
  <w:rPr>
    <w:rFonts w:eastAsia="ＭＳ Ｐゴシック" />
    <w:b />
  </w:rPr>
</w:style>`;

// 表題段落（様式の「表題」装飾を16ptで再現。ユーザー要件によりアウトラインレベルは
// 付けない＝目次・ナビゲーションに載せない）。titleXml はXMLエスケープ済みで渡すこと。
const titleParagraphXml = (titleXml) =>
`<w:p>
  <w:pPr>
    <w:pBdr>
      <w:top w:val="single" w:sz="12" w:space="0" w:color="000000" />
      <w:left w:val="single" w:sz="12" w:space="0" w:color="000000" />
      <w:bottom w:val="single" w:sz="12" w:space="0" w:color="000000" />
      <w:right w:val="single" w:sz="12" w:space="0" w:color="000000" />
    </w:pBdr>
    <w:shd w:val="clear" w:color="auto" w:fill="D9D9D9" />
    <w:spacing w:before="240" w:after="240" w:line="560" w:lineRule="atLeast" />
    <w:ind w:left="400" w:leftChars="400" w:right="400" w:rightChars="400" />
    <w:jc w:val="center" />
    <w:rPr><w:rFonts w:eastAsia="ＭＳ Ｐゴシック" /><w:b /><w:sz w:val="32" /><w:szCs w:val="32" /></w:rPr>
  </w:pPr>
  <w:r>
    <w:rPr><w:rFonts w:eastAsia="ＭＳ Ｐゴシック" /><w:b /><w:sz w:val="32" /><w:szCs w:val="32" /></w:rPr>
    <w:t xml:space="preserve">${titleXml}</w:t>
  </w:r>
</w:p>`;

// 「目次」ラベル＋TOC複合フィールド。w:dirty と settings.xml の updateFields の
// 二段構えで、Word で開いたときにフィールド更新（＝ページ番号付き目次の生成）を促す。
const TOC_XML =
`<w:p>
  <w:pPr>
    <w:spacing w:before="240" w:after="120" />
    <w:rPr><w:rFonts w:eastAsia="ＭＳ Ｐゴシック" /><w:b /><w:sz w:val="28" /><w:szCs w:val="28" /></w:rPr>
  </w:pPr>
  <w:r>
    <w:rPr><w:rFonts w:eastAsia="ＭＳ Ｐゴシック" /><w:b /><w:sz w:val="28" /><w:szCs w:val="28" /></w:rPr>
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

// フッター全体（様式と同じ「ページ / 総ページ」中央寄せ）。
// html-to-docx が生成する footer1.xml は変則的な名前空間かつ PAGE のみのため丸ごと置換する。
const FOOTER_XML =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>
    <w:pPr>
      <w:jc w:val="center" />
      <w:rPr><w:rFonts w:eastAsia="ＭＳ Ｐゴシック" /><w:sz w:val="20" /><w:szCs w:val="20" /></w:rPr>
    </w:pPr>
    <w:r><w:fldChar w:fldCharType="begin" /></w:r>
    <w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="end" /></w:r>
    <w:r><w:t xml:space="preserve"> / </w:t></w:r>
    <w:r><w:fldChar w:fldCharType="begin" /></w:r>
    <w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="end" /></w:r>
  </w:p>
</w:ftr>`;

// ── 後処理本体 ───────────────────────────────────────────────
// meta = { isTemplate, markerTitle, markerToc }（レンダラー renderDocxView が生成。
// マーカーは「@@DX…@@」形式の英数字トークンで、正規表現エスケープ不要な文字種に限る）。
// meta 無し（旧レンダラー等）でも styles/footer/settings の共通処理だけは行う。
async function postProcessDocx(buffer, meta) {
  const JSZip = require('jszip');
  const m = meta || {};
  const zip = await JSZip.loadAsync(buffer);

  // (a) styles.xml: Heading2/Heading4 のブロックを様式定義に差し替え
  let styles = await zip.file('word/styles.xml').async('string');
  const replaceStyle = (xml, styleId, replacement) => {
    const re = new RegExp('<w:style w:type="paragraph" w:styleId="' + styleId + '">[\\s\\S]*?</w:style>');
    if (!re.test(xml)) throw new Error('docx後処理: スタイル定義が見つかりません: ' + styleId);
    return xml.replace(re, replacement);
  };
  styles = replaceStyle(styles, 'Heading2', STYLE_HEADING2);
  styles = replaceStyle(styles, 'Heading4', STYLE_HEADING4);
  zip.file('word/styles.xml', styles);

  // (b) document.xml
  let doc = await zip.file('word/document.xml').async('string');
  // html-to-docx は見出し段落の pPr に <w:spacing w:lineRule="auto"/> を直接付けるため、
  // スタイル側の行間・段前後（様式の帯の高さ）が効くようこれを除去する。
  doc = doc.replace(
    /(<w:pStyle w:val="Heading[1-6]"\s*\/>)\s*<w:spacing w:lineRule="auto"\s*\/>/g,
    '$1'
  );
  // マーカー段落 → OOXML 置換。マーカーが見つからない場合はトークン文字列だけ除去して
  // 文書を壊さない（フェイルソフト）。
  const paragraphWithMarker = (marker) =>
    new RegExp('<w:p>(?:(?!<w:p>)[\\s\\S])*?' + marker + '[\\s\\S]*?</w:p>');
  if (m.markerTitle) {
    const pM = doc.match(paragraphWithMarker(m.markerTitle));
    if (pM) {
      // タイトル文字列は同じ段落の w:t から XMLエスケープ済みのまま回収する
      const tM = pM[0].match(new RegExp('<w:t[^>]*>' + m.markerTitle + '([\\s\\S]*?)</w:t>'));
      doc = doc.replace(pM[0], titleParagraphXml(tM ? tM[1] : ''));
    } else {
      doc = doc.split(m.markerTitle).join('');
    }
  }
  if (m.markerToc) {
    const pM = doc.match(paragraphWithMarker(m.markerToc));
    if (pM) doc = doc.replace(pM[0], TOC_XML);
    else doc = doc.split(m.markerToc).join('');
  }
  zip.file('word/document.xml', doc);

  // (c) footer1.xml: 「PAGE / NUMPAGES」中央寄せに丸ごと差し替え
  if (zip.file('word/footer1.xml')) zip.file('word/footer1.xml', FOOTER_XML);

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
