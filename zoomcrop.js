// zoomcrop.js — 要素矩形ベースの自動ズーム＋枠ハイライトの計画（ロードマップ 2-R3）
// UIA の要素矩形（画面物理px）を撮影画像の座標系へ変換し、
//  - ハイライト枠として採用してよいか（採用基準）
//  - 枠として描く矩形（FRAME_PAD 込み）
//  - 拡大画像の切り出し範囲（要素基準／クリック中心フォールバック）
// を決める。純関数のみ（fs・Electron 非依存）。基準は docs/spec-2-R3-zoom-highlight.md 参照。
'use strict';

const { CONTAINER_TYPES } = require('./steptext');

// 定数はすべて物理px（scaleFactor 比例前）。初期値であり実機運用で調整してよい。
const ZOOM_MARGIN = 48; // 要素矩形の四方に足す余白
const ZOOM_MIN_W = 480; // 拡大画像の最小幅（フォールバック時の固定幅を兼ねる）
const ZOOM_MIN_H = 320; // 同・最小高さ
const FRAME_PAD = 6; // 枠を要素矩形より外側に描く量
const MAX_ELEMENT_FRACTION = 0.9; // 幅・高さの両方がこの割合以上なら「画面ほぼ全体」で不採用
const CLICK_TOLERANCE = 4; // クリック点が矩形内にあるとみなす許容誤差

// 矩形 [x,y,w,h] を画像 (imgW×imgH) の内側へクランプする。
// はみ出しは内側へシフトし、それでも収まらなければ切り詰める。結果は整数。
function clampRect(x, y, w, h, imgW, imgH) {
  let nx = Math.round(x);
  let ny = Math.round(y);
  let nw = Math.round(w);
  let nh = Math.round(h);
  if (nw >= imgW) { nx = 0; nw = imgW; }
  else if (nx < 0) nx = 0;
  else if (nx + nw > imgW) nx = imgW - nw;
  if (nh >= imgH) { ny = 0; nh = imgH; }
  else if (ny < 0) ny = 0;
  else if (ny + nh > imgH) ny = imgH - nh;
  return [nx, ny, nw, nh];
}

// UIA の要素矩形をハイライトに採用してよいか判定し、採用なら画像座標へ
// 変換・クランプした [x,y,w,h] を返す。不採用は null（→ クリック中心フォールバック）。
// uia: steptext.normalizeUia 済み / click: 画像座標の物理px / displayOrigin: 撮影
// ディスプレイ左上の画面物理px座標（disp.bounds × scaleFactor）。
function adoptElementRect(uia, click, imageSize, displayOrigin) {
  if (!uia || !uia.resolved || !Array.isArray(uia.rect) || uia.rect.length < 4) return null;
  const [l, t, w, h] = uia.rect;
  if (!(w > 0 && h > 0)) return null;
  if (CONTAINER_TYPES.has(uia.controlType || '')) return null;

  // 画面座標 → 画像座標
  const ex = l - displayOrigin.x;
  const ey = t - displayOrigin.y;

  // クリック点が矩形の内側にあること（ElementFromPoint の異常値を弾く）
  if (
    click.x < ex - CLICK_TOLERANCE || click.x > ex + w + CLICK_TOLERANCE ||
    click.y < ey - CLICK_TOLERANCE || click.y > ey + h + CLICK_TOLERANCE
  ) return null;

  // 画像と重なっている部分だけを採用（別ディスプレイへはみ出す要素など）
  const ix = Math.max(0, ex);
  const iy = Math.max(0, ey);
  const ix2 = Math.min(imageSize.w, ex + w);
  const iy2 = Math.min(imageSize.h, ey + h);
  if (ix2 - ix < 1 || iy2 - iy < 1) return null;
  const el = [Math.round(ix), Math.round(iy), Math.round(ix2 - ix), Math.round(iy2 - iy)];

  // 幅・高さの両方が画面ほぼ全体なら枠にもズームにもならないので不採用。
  // 片方だけ大きい要素（横いっぱいのツールバー等）は正当なので採用する。
  if (el[2] >= imageSize.w * MAX_ELEMENT_FRACTION && el[3] >= imageSize.h * MAX_ELEMENT_FRACTION) {
    return null;
  }
  return el;
}

// 要素矩形の周囲を切り出す拡大範囲（余白＋最小サイズ保証＋クランプ）。
function cropForElement(el, imageSize, scale) {
  const margin = ZOOM_MARGIN * scale;
  let x = el[0] - margin;
  let y = el[1] - margin;
  let w = el[2] + margin * 2;
  let h = el[3] + margin * 2;
  const minW = ZOOM_MIN_W * scale;
  const minH = ZOOM_MIN_H * scale;
  if (w < minW) { x -= (minW - w) / 2; w = minW; }
  if (h < minH) { y -= (minH - h) / 2; h = minH; }
  return clampRect(x, y, w, h, imageSize.w, imageSize.h);
}

// クリック座標中心の固定サイズ切り出し（矩形が採用できないときのフォールバック）。
function cropForClick(click, imageSize, scale) {
  const w = ZOOM_MIN_W * scale;
  const h = ZOOM_MIN_H * scale;
  return clampRect(click.x - w / 2, click.y - h / 2, w, h, imageSize.w, imageSize.h);
}

// 要素矩形を FRAME_PAD だけ外側に広げた「描く枠」の矩形。
function frameRect(el, imageSize, scale) {
  const pad = FRAME_PAD * scale;
  return clampRect(el[0] - pad, el[1] - pad, el[2] + pad * 2, el[3] + pad * 2, imageSize.w, imageSize.h);
}

// 1枚分のハイライト・ズーム計画を立てる。
//   planShot({ uia, click:{x,y}, imageSize:{w,h}, displayOrigin:{x,y}, scale })
// 返り値: { element, frame, zoom }
//   element: 採用した要素矩形（画像座標・クランプ済み）| null
//   frame  : 全景に描く枠の矩形（FRAME_PAD 込み）| null（→ 赤丸フォールバック）
//   zoom   : { rect:[x,y,w,h], source:'element'|'click' } | null（画像サイズ不明時のみ）
function planShot({ uia, click, imageSize, displayOrigin, scale = 1 }) {
  if (!click || !imageSize || !(imageSize.w > 0) || !(imageSize.h > 0)) {
    return { element: null, frame: null, zoom: null };
  }
  const origin = displayOrigin || { x: 0, y: 0 };
  const el = adoptElementRect(uia, click, imageSize, origin);
  if (el) {
    return {
      element: el,
      frame: frameRect(el, imageSize, scale),
      zoom: { rect: cropForElement(el, imageSize, scale), source: 'element' },
    };
  }
  return { element: null, frame: null, zoom: { rect: cropForClick(click, imageSize, scale), source: 'click' } };
}

module.exports = { planShot, ZOOM_MARGIN, ZOOM_MIN_W, ZOOM_MIN_H, FRAME_PAD };
