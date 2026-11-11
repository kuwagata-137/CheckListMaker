// 操作マニュアル用のスクリーンショット撮影。
// 写し元は MultipurposeDiagramMaker の マニュアル/作成ツール/capture-puppeteer.js（注釈の描き方・切り抜き・_manifest.json）。
//
// 使い方（リポジトリのルートで）:
//   node マニュアル/作成ツール/capture.js            … 全部撮る（ルートの screenshots/manual/ へ出力）
//   node マニュアル/作成ツール/capture.js m03 m04    … 章を絞って撮る（撮影一覧 _manifest.json は今あるものに足す）
//   その後 node マニュアル/作成ツール/create-manual.js で .docx を作る
//
// ブラウザ: puppeteer があればそれを、無ければ playwright の Chromium を使う
//   （クラウドのセッションでは NODE_PATH=/opt/node22/lib/node_modules で playwright を使う）。
// Linux で撮るときは日本語が中国語の字体に落ちるので、IPA P ゴシックを先にする fonts.conf を一時ファイルに書いて
//   FONTCONFIG_FILE で渡す（Windows では何もしない）。
//
// 方針（MDM と同じ）: 操作はなるべく実際の UI（ボタンのクリック・マウスのドラッグ・ホバー）を通す。
//   内部の状態を直接書き換えるのは、見本のデータを用意するときだけ。
//   アプリはデスクトップ版（Electron）の窓口（storageAPI・recorderAPI など）がある前提で画面を出すので、
//   読み込む前にダミーの窓口を差し込む（ファイルの保存・画面全体の撮影は行わない）。
// 注釈（赤い枠・番号・カーソルの絵・破線の矢印・白い札）は、撮る直前にページの最前面へ重ねる SVG で描き、撮ったら外す。
//   注釈の先が見つからないときは例外で止める（画面が変わって注釈が黙ってずれるのを防ぐ）。
// 見本は架空の手順書「交通費を精算する手順」と、架空の「経費精算システム」の画面だけを使う。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'screenshots', 'manual'); // .gitignore 対象
const MANIFEST = path.join(OUT, '_manifest.json');
const APP_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
// 窓の大きさ。メニューバーのボタンが横スクロールなしで全部見える幅。画像は 2 倍の細かさで撮る
const VW = 1280, VH = 800, DSF = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// ============================================================
//  ブラウザ（puppeteer と playwright の差をそろえる）
// ============================================================
function setupLinuxFonts() {
  if (process.platform !== 'linux' || process.env.FONTCONFIG_FILE) return;
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <match target="pattern">
    <test name="lang" compare="contains"><string>ja</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>IPAPGothic</string></edit>
  </match>
  <alias binding="strong"><family>sans-serif</family><prefer><family>DejaVu Sans</family><family>IPAPGothic</family><family>Noto Color Emoji</family></prefer></alias>
  <selectfont><rejectfont><glob>/usr/share/fonts/truetype/wqy/*</glob><glob>/usr/share/fonts/opentype/unifont/*</glob></rejectfont></selectfont>
</fontconfig>
`;
  const p = path.join(os.tmpdir(), 'clm-manual-fonts.conf');
  fs.writeFileSync(p, conf);
  process.env.FONTCONFIG_FILE = p;
}

let B = null;    // ブラウザ
let page = null; // 今のページ
async function launch() {
  setupLinuxFonts();
  let pp = null;
  try { pp = require('puppeteer'); } catch (e) { /* playwright を使う */ }
  if (pp) {
    const browser = await pp.launch({ headless: true, args: ['--no-sandbox'] });
    return {
      browser, kind: 'puppeteer',
      newPage: async (w, h) => { const p = await browser.newPage(); await p.setViewport({ width: w, height: h, deviceScaleFactor: DSF }); return p; },
      initScript: (p, fn, arg) => p.evaluateOnNewDocument(fn, arg),
      size: () => page.viewport(),
    };
  }
  const { chromium } = require('playwright');
  // 日付の欄の形は Chromium が環境変数 LANG で決める（locale の指定だけでは 11/02/2026 のまま）
  const browser = await chromium.launch({ env: { ...process.env, LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8', LANGUAGE: 'ja' } });
  return {
    browser, kind: 'playwright',
    newPage: async (w, h) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: DSF, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', forcedColors: 'none', colorScheme: 'light' });
      return ctx.newPage();
    },
    initScript: (p, fn, arg) => p.addInitScript(fn, arg),
    size: () => page.viewportSize(),
  };
}

// ============================================================
//  ページの中で動かす: 注釈と場所の求め方（ページを開くたびに入れ直す）
// ============================================================
function pageHelpers() {
  const NSV = 'http://www.w3.org/2000/svg';
  const RED = '#dc2626';
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  // 先 → 画面の上の四角 {x,y,w,h}。先は 'セレクタ' ／ {sel, text, i, pad} ／ {c:[x,y,w,h]}（画面の座標）／ 配列（全部を囲む）
  const box = (t) => {
    if (Array.isArray(t)) {
      const bs = t.map(box);
      const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
      const x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    if (typeof t === 'string') t = { sel: t };
    let b;
    if (t.sel) {
      let els = [...document.querySelectorAll(t.sel)].filter(vis);
      if (t.text) els = els.filter((el) => el.textContent.includes(t.text));
      if (t.i != null) els = els[t.i] ? [els[t.i]] : [];
      if (!els.length) throw new Error('注釈の先が見つかりません: ' + t.sel + (t.text ? ' / ' + t.text : ''));
      const rs = els.map((el) => el.getBoundingClientRect());
      const x0 = Math.min(...rs.map((r) => r.left)), y0 = Math.min(...rs.map((r) => r.top));
      const x1 = Math.max(...rs.map((r) => r.right)), y1 = Math.max(...rs.map((r) => r.bottom));
      b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else if (t.c) {
      b = { x: t.c[0], y: t.c[1], w: t.c[2], h: t.c[3] };
    } else throw new Error('注釈の先の書き方が違います: ' + JSON.stringify(t));
    const pad = t.pad || 0;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  };
  // 点: [x,y]（画面の座標）／ {...先, at:'c|t|b|l|r|tl|tr|bl|br', dx, dy}
  const pt = (p) => {
    if (Array.isArray(p)) return p;
    if (typeof p === 'string') p = { sel: p };
    const b = box(p), at = p.at || 'c';
    let x = b.x + b.w / 2, y = b.y + b.h / 2;
    if (at.includes('l')) x = b.x;
    if (at.includes('r')) x = b.x + b.w;
    if (at.includes('t')) y = b.y;
    if (at.includes('b')) y = b.y + b.h;
    return [x + (p.dx || 0), y + (p.dy || 0)];
  };
  const mk = (tag, attrs, parent) => {
    const el = document.createElementNS(NSV, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  };
  // 注釈を描く。返すのは描いたものを囲む四角（切り抜きに含めるため）
  const draw = (items) => {
    clear();
    const W = innerWidth, H = innerHeight;
    const host = document.createElement('div');
    host.id = '__mnl_anno';
    host.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;pointer-events:none;z-index:2147483647`;
    const svg = mk('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    host.appendChild(svg);
    document.body.appendChild(host);
    const defs = mk('defs', {}, svg);
    const mar = mk('marker', { id: '__mnl_ah', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
    mk('path', { d: 'M0,0 L10,5 L0,10 z', fill: RED }, mar);
    const ext = [];
    const grow = (x0, y0, x1, y1) => ext.push([x0, y0, x1, y1]);
    const badge = (x, y, num, r) => {
      r = r || 12;
      mk('circle', { cx: x, cy: y, r: r + 1.5, fill: '#fff' }, svg);
      mk('circle', { cx: x, cy: y, r, fill: RED }, svg);
      const t = mk('text', { x, y: y + r * 0.38, 'text-anchor': 'middle', 'font-size': r * 1.15, 'font-weight': 700, fill: '#fff', 'font-family': 'Arial,sans-serif' }, svg);
      t.textContent = String(num);
      grow(x - r - 2, y - r - 2, x + r + 2, y + r + 2);
    };
    const label = (x, y, text, side, fs) => { // side: 'r'＝(x,y) の右に／'l'＝左に／'b'＝下に／'t'＝上に
      fs = fs || 13;
      const t = mk('text', { 'font-size': fs, 'font-weight': 700, fill: '#991b1b', 'font-family': 'sans-serif' }, svg);
      t.textContent = text;
      const tw = t.getComputedTextLength(), ph = fs + 10, pw = tw + 16;
      let bx = x, by = y - ph / 2;
      if (side === 'l') bx = x - pw;
      if (side === 'b') { bx = x - pw / 2; by = y; }
      if (side === 't') { bx = x - pw / 2; by = y - ph; }
      bx = Math.max(2, Math.min(W - pw - 2, bx)); by = Math.max(2, Math.min(H - ph - 2, by));
      const r = mk('rect', { x: bx, y: by, width: pw, height: ph, rx: 5, fill: '#fff', stroke: RED, 'stroke-width': 1.8 }, svg);
      svg.insertBefore(r, t);
      t.setAttribute('x', bx + 8); t.setAttribute('y', by + ph / 2 + fs * 0.36);
      grow(bx, by, bx + pw, by + ph);
    };
    const cursor = (x, y) => { // 矢印のカーソル（先が (x,y)）
      const g = mk('g', { transform: `translate(${x},${y}) scale(1.35)` }, svg);
      mk('path', { d: 'M0,0 L0,17 L4.2,13 L7.3,20 L10,18.8 L7,12 L12.5,12 Z', fill: '#fff', stroke: '#111', 'stroke-width': 1.3, 'stroke-linejoin': 'round' }, g);
      grow(x - 2, y - 2, x + 19, y + 29);
    };
    for (const it of items) {
      if (it.box) {
        const b = box(it.box);
        const p = it.pad != null ? it.pad : 4;
        const x = b.x - p, y = b.y - p, w = b.w + p * 2, h = b.h + p * 2;
        mk('rect', { x, y, width: w, height: h, rx: it.rx != null ? it.rx : 6, fill: 'none', stroke: RED, 'stroke-width': it.sw || 3, 'stroke-dasharray': it.dash ? '8,5' : 'none' }, svg);
        grow(x - 2, y - 2, x + w + 2, y + h + 2);
        if (it.n != null) {
          const at = it.at || 'tl', r = it.r || 12;
          let bx = x, by = y;
          if (at.includes('r')) bx = x + w;
          if (at.includes('b')) by = y + h;
          if (at === 't' || at === 'b') bx = x + w / 2;
          if (at === 'l' || at === 'r') by = y + h / 2;
          bx += it.bdx || 0; by += it.bdy || 0;
          badge(bx, by, it.n, r);
          if (it.label) label(bx + (it.labelSide === 'l' ? -r - 4 : r + 4), by, it.label, it.labelSide || 'r', it.fs);
        }
      }
      if (it.badge != null) { const [x, y] = pt(it.at); badge(x, y, it.badge, it.r); }
      if (it.arrow) {
        const [x0, y0] = pt(it.arrow[0]), [x1, y1] = pt(it.arrow[1]);
        mk('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: RED, 'stroke-width': it.sw || 3, 'stroke-dasharray': it.solid ? 'none' : '7,5', 'marker-end': 'url(#__mnl_ah)' }, svg);
        grow(Math.min(x0, x1) - 6, Math.min(y0, y1) - 6, Math.max(x0, x1) + 6, Math.max(y0, y1) + 6);
      }
      if (it.cursor) { const [x, y] = pt(it.cursor); cursor(x, y); }
      if (it.text) { const [x, y] = pt(it.at); label(x, y, it.text, it.side || 'r', it.fs); }
    }
    if (!ext.length) return null;
    const x0 = Math.min(...ext.map((e) => e[0])), y0 = Math.min(...ext.map((e) => e[1]));
    const x1 = Math.max(...ext.map((e) => e[2])), y1 = Math.max(...ext.map((e) => e[3]));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const clear = () => { const el = document.getElementById('__mnl_anno'); if (el) el.remove(); };
  window.__mnl = { box, pt, draw, clear };
}

// ============================================================
//  撮影の共通の処理
// ============================================================
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const ev = (fn, arg) => page.evaluate(fn, arg);
const pt = (p) => ev((q) => window.__mnl.pt(q), p);
const box = (t) => ev((q) => window.__mnl.box(q), t);

// 押す先が窓の外にあれば、窓の中へ送ってから動かす
async function move(p) {
  if (!Array.isArray(p)) {
    await ev((q) => {
      if (typeof q === 'string') q = { sel: q };
      if (!q.sel) return;
      let els = [...document.querySelectorAll(q.sel)];
      if (q.text) els = els.filter((el) => el.textContent.includes(q.text));
      const el = q.i != null ? els[q.i] : els[0];
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, p);
  }
  const [x, y] = await pt(p);
  await page.mouse.move(x, y, { steps: 6 });
  return [x, y];
}
async function click(p) { const [x, y] = await move(p); await page.mouse.down(); await page.mouse.up(); await sleep(250); return [x, y]; }
async function drag(from, to, o = {}) {
  const [x0, y0] = await move(from);
  await page.mouse.down();
  const [x1, y1] = Array.isArray(to) ? to : await pt(to);
  await page.mouse.move(x1, y1, { steps: o.steps || 12 });
  if (!o.hold) await page.mouse.up();
  await sleep(200);
  return [x0, y0, x1, y1];
}
async function type(text) { await page.keyboard.type(text, { delay: 5 }); await sleep(120); }

// 撮る。opts:
//   clip … 省略＝画面の全体（JPEG）／先（box と同じ書き方）＝その範囲を切り抜く（PNG）
//   pad  … 切り抜きの余白（CSS の px・既定 16）
//   anno … 注釈の並び（pageHelpers の draw）
async function shot(name, opts = {}) {
  let annoBox = null;
  if (opts.anno && opts.anno.length) annoBox = await ev((a) => window.__mnl.draw(a), opts.anno);
  await sleep(80);
  const { width: vw, height: vh } = B.size();
  let clip = null;
  if (opts.clip) {
    let b = await box(opts.clip);
    if (annoBox && opts.withAnno !== false) {
      const x0 = Math.min(b.x, annoBox.x), y0 = Math.min(b.y, annoBox.y);
      const x1 = Math.max(b.x + b.w, annoBox.x + annoBox.w), y1 = Math.max(b.y + b.h, annoBox.y + annoBox.h);
      b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    const p = opts.pad != null ? opts.pad : 16;
    const x0 = Math.max(0, Math.floor(b.x - p)), y0 = Math.max(0, Math.floor(b.y - p));
    const x1 = Math.min(vw, Math.ceil(b.x + b.w + p)), y1 = Math.min(vh, Math.ceil(b.y + b.h + p));
    clip = { x: x0, y: y0, width: x1 - x0, height: Math.min(y1 - y0, opts.maxH || 1e9) };
  }
  const fmt = opts.fmt || (clip ? 'png' : 'jpeg');
  const file = name + (fmt === 'png' ? '.png' : '.jpg');
  const so = { path: path.join(OUT, file), type: fmt };
  if (fmt === 'jpeg') so.quality = 85;
  if (clip) so.clip = clip;
  if (clip && B.kind === 'puppeteer') so.captureBeyondViewport = false;
  await page.screenshot(so);
  await ev(() => window.__mnl && window.__mnl.clear());
  manifest[name] = { file, w: clip ? clip.width : vw, h: clip ? clip.height : vh, dsf: DSF };
  console.log(`  ${file}  ${manifest[name].w}×${manifest[name].h}`);
}

// ============================================================
//  見本の素材: 架空の「経費精算システム」の画面（HTML で描いて撮り、手順に貼る画像にする）
// ============================================================
function fakeScreen(kind) {
  const head = (title) => `<div class="bar"><b>経費精算システム</b><span>総務 花子 さん</span></div><div class="crumb">${title}</div>`;
  const body = {
    login: `<div class="bar"><b>経費精算システム</b></div>
      <div class="login"><h2>ログイン</h2>
        <label>社員番号</label><div class="in">A01234</div>
        <label>パスワード</label><div class="in">●●●●●●●●</div>
        <div class="btn wide">ログイン</div></div>`,
    menu: `${head('メニュー')}
      <div class="tiles"><div class="tile hot"><span>🚃</span>交通費精算</div><div class="tile"><span>🧳</span>出張旅費</div>
        <div class="tile"><span>🧾</span>立替経費</div><div class="tile"><span>📋</span>申請の一覧</div></div>`,
    form: `${head('メニュー ＞ 交通費精算 ＞ 入力')}
      <div class="form"><h2>交通費の入力</h2>
        <div class="row"><label>利用日</label><div class="in">2026/11/05</div></div>
        <div class="row"><label>区間</label><div class="in">足利</div><span>→</span><div class="in">宇都宮</div><span class="chk">☑ 往復</span></div>
        <div class="row"><label>金額（円）</label><div class="in num">2,640</div></div>
        <div class="row"><label>目的</label><div class="in long">取引先との打ち合わせ</div></div>
        <div class="acts"><div class="btn ghost">一時保存</div><div class="btn">確認へ進む</div></div></div>`,
    confirm: `${head('メニュー ＞ 交通費精算 ＞ 確認')}
      <div class="form"><h2>入力内容の確認</h2>
        <table><tr><th>利用日</th><td>2026/11/05</td></tr><tr><th>区間</th><td>足利 → 宇都宮（往復）</td></tr>
        <tr><th>金額</th><td>2,640 円</td></tr><tr><th>目的</th><td>取引先との打ち合わせ</td></tr><tr><th>承認者</th><td>総務課長</td></tr></table>
        <div class="acts"><div class="btn ghost">戻る</div><div class="btn">申請する</div></div></div>`,
    done: `${head('メニュー ＞ 交通費精算 ＞ 完了')}
      <div class="form done"><div class="ok">✓</div><h2>申請を受け付けました</h2>
        <p>申請番号 <b>K-2026-1105-0042</b></p><p class="sub">承認されると、メールでお知らせします。</p>
        <div class="acts"><div class="btn">メニューへ戻る</div></div></div>`,
  }[kind];
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
    body{margin:0;font-family:sans-serif;background:#f4f6f8;color:#1f2937;width:960px;height:600px;overflow:hidden}
    .bar{height:52px;background:#0f766e;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 24px;font-size:20px}
    .bar span{font-size:14px;opacity:.9}
    .crumb{padding:10px 24px;font-size:13px;color:#64748b;background:#fff;border-bottom:1px solid #e5e7eb}
    h2{font-size:22px;margin:0 0 18px}
    .login{width:360px;margin:60px auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:28px 32px}
    label{display:block;font-size:13px;color:#475569;margin:10px 0 4px}
    .in{border:1px solid #cbd5e1;border-radius:6px;padding:8px 10px;font-size:15px;background:#fff;min-width:120px}
    .btn{display:inline-block;background:#0f766e;color:#fff;border-radius:6px;padding:10px 22px;font-size:15px;font-weight:700}
    .btn.wide{display:block;text-align:center;margin-top:22px}.btn.ghost{background:#fff;color:#0f766e;border:1px solid #0f766e}
    .tiles{display:grid;grid-template-columns:repeat(2,260px);gap:22px;justify-content:center;margin-top:48px}
    .tile{background:#fff;border:1px solid #e5e7eb;border-radius:12px;height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:19px;font-weight:700;gap:10px}
    .tile span{font-size:38px}.tile.hot{border:2px solid #0f766e}
    .form{background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin:22px 60px;padding:24px 32px}
    .row{display:flex;align-items:center;gap:12px;margin:12px 0}.row label{width:100px;margin:0}.num{text-align:right;width:120px}.long{width:360px}
    .chk{font-size:14px}
    .acts{display:flex;gap:12px;justify-content:flex-end;margin-top:22px}
    table{border-collapse:collapse;width:100%}th,td{border:1px solid #e5e7eb;padding:9px 12px;text-align:left;font-size:15px}th{background:#f1f5f9;width:120px}
    .done{text-align:center}.ok{width:64px;height:64px;border-radius:50%;background:#0f766e;color:#fff;font-size:38px;line-height:64px;margin:6px auto 14px}
    .done .acts{justify-content:center}.sub{color:#64748b;font-size:14px}
  </style></head><body>${body}</body></html>`;
}
async function makeFakeImages() {
  const p = await B.newPage(960, 600);
  const out = {};
  for (const k of ['login', 'menu', 'form', 'confirm', 'done']) {
    await p.setContent(fakeScreen(k));
    // 手順に貼る画像は、アプリが貼り付けるときと同じく圧縮済みの JPEG（等倍）にする
    const buf = await p.screenshot({ type: 'jpeg', quality: 82, clip: { x: 0, y: 0, width: 960, height: 600 } });
    out[k] = 'data:image/jpeg;base64,' + buf.toString('base64');
  }
  await p.close();
  return out;
}

// ============================================================
//  見本のデータ（架空）
// ============================================================
let IMG = null; // makeFakeImages() の結果
const it = (id, text, o = {}) => ({ id, text, done: !!o.done, note: o.note || '', time: o.time || '', images: o.images || [], body: o.body || '' });
function sampleState() {
  const travel = {
    id: 'm-travel', title: '交通費を精算する手順', type: 'template', createdAt: 1762819200000, updatedAt: 1762819200000,
    coverPage: {
      enabled: true, includeToc: true, preset: 'doc-header', accent: '#0f766e',
      title: '交通費を精算する手順', subtitle: '経費精算システムでの申請のしかた', author: '総務課',
      date: '2026-11-11', version: '1.0', docNumber: 'SM-001', logo: '',
      revisions: [{ id: 'm-rev1', version: '1.0', date: '2026-11-11', author: '総務課', note: '初版' }],
    },
    sections: [
      { id: 'm-s1', title: '① 準備：申請に要るものをそろえる', items: [
        it('m-i1', '領収書と利用した経路を確かめる', { time: '5', note: '交通系 IC カードの利用履歴でも代わりになる。',
          body: '<p>申請の前に、次の3つを手元にそろえる。</p><table><thead><tr><th>要るもの</th><th>どこで確かめるか</th></tr></thead><tbody><tr><td>利用日</td><td>手帳・予定表</td></tr><tr><td>区間と金額</td><td>領収書・乗換案内</td></tr><tr><td>目的</td><td>打ち合わせの予定</td></tr></tbody></table>' }),
        it('m-i2', '経費精算システムにログインする', { time: '2', images: [IMG.login], note: 'パスワードを忘れたときは、情報システム課に問い合わせる。' }),
      ] },
      { id: 'm-s2', title: '② 入力：交通費を入力する', items: [
        it('m-i3', 'メニューの「交通費精算」を押す', { time: '1', images: [IMG.menu] }),
        it('m-i4', '利用日・区間・金額・目的を入力して「確認へ進む」を押す', { time: '5', images: [IMG.form],
          body: '<ul><li>往復のときは「往復」にチェックを付ける</li><li>金額は片道ではなく、実際に払った合計を入れる</li></ul>' }),
      ] },
      { id: 'm-s3', title: '③ 申請：内容を確かめて送る', items: [
        it('m-i5', '入力した内容を確かめて「申請する」を押す', { time: '2', images: [IMG.confirm], note: '承認者が自分の上長になっているかも確かめる。' }),
        it('m-i6', '表示された申請番号を控える', { time: '1', images: [IMG.done] }),
      ] },
    ],
  };
  const pc = {
    id: 'm-pc', title: '新しいパソコンの初期設定', type: 'template', createdAt: 1762732800000, updatedAt: 1762732800000,
    sections: [
      { id: 'm-p1', title: '初期設定', items: [
        it('m-p1a', 'Windows Update を済ませる', { done: true, time: '30' }),
        it('m-p1b', 'プリンタを追加する', { done: true, time: '10' }),
        it('m-p1c', 'メールの設定をする', { time: '15' }),
        it('m-p1d', '共有フォルダを割り当てる', { time: '10' }),
      ] },
    ],
  };
  const todo = {
    id: 'm-todo', title: '月末の締め作業', type: 'todo', createdAt: 1762646400000, updatedAt: 1762646400000,
    sections: [
      { id: 'm-t1', title: '経理', items: [
        it('m-t1a', '交通費の申請を出す', { done: true }),
        it('m-t1b', '立替経費の領収書をまとめる', { done: true }),
        it('m-t1c', '請求書の受け取りを確かめる'),
      ] },
      { id: 'm-t2', title: '総務', items: [
        it('m-t2a', '会議室の予約を来月分まで入れる'),
        it('m-t2b', '備品の在庫を数える', { done: true }),
      ] },
    ],
  };
  return { checklists: [travel, pc, todo], settings: { theme: 'light' } };
}

// ページの中で動かす（読み込む前に置く）: デスクトップ版の窓口の身代わりを置き、保存の中身を見本にする
function seedPage(o) {
  window.__test__ = {};
  try { localStorage.clear(); } catch (_) { /* file:// で使えないときは何もしない */ }
  let saved = o.state;
  const imgs = {};
  let n = 0;
  window.storageAPI = {
    load: async () => ({ ok: true, json: saved }),
    save: async (j) => { saved = j; return { ok: true }; },
    imageSave: async (d) => { const k = 'img:00000000-0000-0000-0000-' + String(++n).padStart(12, '0') + '.jpg'; imgs[k] = d; return { ok: true, ref: k }; },
    imageGet: async (r) => (imgs[r] ? { ok: true, dataUrl: imgs[r] } : { ok: false, error: 'なし' }),
    imageDelete: async () => ({ ok: true }),
  };
  const ok = async () => ({ ok: true });
  window.recorderAPI = {
    onState() {}, onDone() {}, listSessions: async () => o.sessions || [],
    startRecording: ok, stopRecording: ok, beginCapture: ok, pauseRecording: ok, snap: ok, finishSession: ok,
    setMarker: ok, setDrag: ok, openShotsDir: ok, loadSession: async () => null, readImage: async () => null, markImported: ok,
  };
  window.guideAPI = { available: true, open: ok, update: ok, close: ok, onAction() {}, onClosed() {} };
  window.docxAPI = { save: ok };
  window.xlsxAPI = { save: ok };
  window.csvAPI = { save: ok };
  window.printAPI = { savePdf: ok };
  window.appLogAPI = { error: ok };
  window.fileAPI = {
    saveHtml: ok, pickImage: async () => null,
    pickImages: async () => ({ files: o.files || [] }),
    readPickedImage: async (p) => (o.fileData || {})[p] || null,
  };
}

// 新しいページでアプリを開き直す（章ごとに開き直し、前の章の操作が残らないようにする）
async function open(opts = {}) {
  if (page) await page.close();
  page = await B.newPage(opts.size ? opts.size[0] : VW, opts.size ? opts.size[1] : VH);
  page.on('pageerror', (e) => { console.error('ページの失敗:', e.message); });
  page.on('dialog', (d) => d.accept()); // 確認の窓（confirm）は「OK」で進める
  const state = JSON.stringify(opts.state || sampleState());
  await B.initScript(page, seedPage, { state, sessions: opts.sessions, files: opts.files, fileData: opts.fileData });
  await page.goto(APP_URL + (opts.hash || ''), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__test__ && window.__test__.store && document.querySelector('#app *'));
  await ev(pageHelpers);
  await sleep(400);
}
// 単独のページ（gadget.html・guide.html）を開く
async function openFile(file, w, h, init) {
  if (page) await page.close();
  page = await B.newPage(w, h);
  page.on('pageerror', (e) => { console.error('ページの失敗:', e.message); });
  if (init) await B.initScript(page, init.fn, init.arg);
  await page.goto(pathToFileURL(path.join(ROOT, file)).href, { waitUntil: 'load' });
  await ev(pageHelpers);
  await sleep(300);
}
const openList = async (title) => { await click({ sel: '.card-open', text: title }); await sleep(600); };
const scrollTo = async (sel, o = {}) => {
  await ev((a) => {
    const el = [...document.querySelectorAll(a.sel)].filter((e) => !a.text || e.textContent.includes(a.text))[a.i || 0];
    if (!el) throw new Error('見つかりません: ' + a.sel);
    el.scrollIntoView({ block: a.block || 'start' });
    if (a.dy) window.scrollBy(0, a.dy);
  }, { sel, ...o });
  await sleep(300);
};

// ============================================================
//  章ごとの撮影
// ============================================================
const CH = {};

// 要素の上端が窓の y の位置に来るように、ページを送る（編集画面の上の見出しは画面に貼り付いて動かないため、その下に出す）
async function scrollEl(sel, y = 150, o = {}) {
  await ev((a) => {
    const els = [...document.querySelectorAll(a.sel)].filter((e) => !a.text || e.textContent.includes(a.text));
    const el = els[a.i || 0];
    if (!el) throw new Error('見つかりません: ' + a.sel + (a.text ? ' / ' + a.text : ''));
    window.scrollBy(0, el.getBoundingClientRect().top - a.y);
  }, { sel, y, ...o });
  await sleep(300);
}
const step = (id) => `li.step[data-item="${id}"]`;
const tb = (action) => `#topbar [data-action="${action}"]`;
// 見出しを編集して戻す（「元に戻す」「やり直す」を押せる見た目にするため）
async function touchUndo() {
  await ev(() => { const T = window.__test__; T.store.commit((st) => { st.checklists[0].sections[0].items[0].done = true; }); T.store.undo(); });
  await sleep(300);
}

// ---- 表紙・第1章 概要 ----
CH.m01 = async () => {
  await open();
  await openList('交通費を精算する手順');
  await scrollEl(step('m-i3'), 140);
  await shot('m00_cover');
  // 記号の凡例（このマニュアルの見方）
  await open();
  await shot('m01_legend', {
    clip: { c: [200, 96, 880, 150] }, pad: 0,
    anno: [
      { box: '.home-actions [data-action="new"]', n: 1 },
      { cursor: { sel: '.home-actions [data-action="import"]', at: 'c', dx: -4 } },
      { arrow: [{ sel: '.card-open', text: '交通費を精算する手順', at: 'r', dx: -40 }, { sel: '.card-open', text: '新しいパソコンの初期設定', at: 'l', dx: 30 }] },
      { text: '補足の札', at: { sel: '.home-head h1', at: 'r', dx: 18 } },
    ],
  });
  // 2つの型（テンプレート型・ToDo型）
  await open();
  await openList('交通費を精算する手順');
  await scrollEl('.section', 140);
  await shot('m01_type_template', { clip: [{ sel: '.section-head', i: 0 }, step('m-i1')], pad: 10 });
  await open();
  await openList('月末の締め作業');
  await scrollEl('.section', 140);
  await shot('m01_type_todo', { clip: { sel: '.section', i: 0 }, pad: 10 });
};

// ---- 第2章 はじめに（画面の構成・メニューバー） ----
CH.m02 = async () => {
  await open();
  await shot('m02_home', {
    anno: [
      { box: '#topbar', n: 1, pad: -2, at: 'bl', bdx: 16 },
      { box: '.home-actions [data-action="new"]', n: 2, at: 'b' },
      { box: '.home-actions [data-action="import"]', n: 3, at: 'b' },
      { box: '.home-actions [data-action="export"]', n: 4, at: 'b' },
      { box: { sel: '.card', i: 0 }, n: 5 },
    ],
  });
  await shot('m02_card', { clip: { sel: '.card', i: 0 }, pad: 12,
    anno: [
      { box: { sel: '.card .badge', i: 0 }, n: 1, at: 'r', pad: 2 },
      { box: { sel: '.card .progress', i: 0 }, n: 2, at: 'r', pad: 3 },
      { box: { sel: '.card [data-action="duplicate"]', i: 0 }, n: 3, at: 'b', pad: 2 },
      { box: { sel: '.card [data-action="rename"]', i: 0 }, n: 4, at: 'b', pad: 2 },
      { box: { sel: '.card [data-action="delete"]', i: 0 }, n: 5, at: 'b', pad: 2 },
    ] });
  await openList('交通費を精算する手順');
  await shot('m02_editor', {
    anno: [
      { box: '#topbar', n: 1, pad: -2, at: 'bl', bdx: 16 },
      { box: '#thumbs', n: 2, pad: -3, at: 'tr', bdx: -16, bdy: 70 },
      { box: '.editor-head', n: 3, pad: -2 },
      { box: '.editor-progress', n: 4, pad: 0 },
      { box: '.cover-card', n: 5, pad: -2, at: 'tr' },
    ],
  });
  await scrollEl('.section', 140);
  await shot('m02_editor2', {
    anno: [
      { box: { sel: '.section-head', i: 0 }, n: 1, pad: 2 },
      { box: step('m-i1'), n: 2, pad: 2, at: 'l' },
    ],
  });
  // メニューバー
  await scrollEl('.editor-head', 0);
  await touchUndo();
  await shot('m02_menubar', { clip: '#topbar', pad: 0,
    anno: [
      { box: '#topbar .tb-editor-main', n: 1, pad: 1, at: 'b' },
      { box: '#topbar .tb-editor-add', n: 2, pad: 1, at: 'b' },
      { box: [tb('undo'), tb('redo')], n: 3, pad: 1, at: 'b' },
      { box: [tb('record'), tb('import-rec')], n: 4, pad: 1, at: 'b' },
    ] });
  for (const [a, n] of [['menu-export', 'export'], ['print', 'print'], ['menu-run', 'run'], ['reset', 'reset'], ['cover', 'cover'],
    ['add-step-here', 'addstep'], ['add-section-here', 'addsection'], ['undo', 'undo'], ['redo', 'redo'], ['record', 'record'], ['import-rec', 'importrec']]) {
    await shot('btn_' + n, { clip: tb(a), pad: 3 });
  }
  // ボタンにマウスを置くと出る説明
  await move(tb('print'));
  await sleep(900);
  await shot('m02_tip', { clip: [tb('menu-export'), tb('cover'), '#tip-host'], pad: 8 });
  // ToDo型のメニューバー
  await open();
  await openList('月末の締め作業');
  await shot('btn_clear', { clip: tb('clear-completed'), pad: 3 });
  await shot('btn_additem', { clip: tb('add-step-here'), pad: 3 });
  await shot('btn_addsec', { clip: tb('add-section-here'), pad: 3 });
};

// ---- 第3章 手順書を作る ----
CH.m03 = async () => {
  // 新規作成
  await open();
  await shot('m03_new_1', { clip: [{ sel: '.home-head' }, { sel: '.card', i: 0 }], pad: 10,
    anno: [{ box: '.home-actions [data-action="new"]', n: 1 }, { cursor: { sel: '.home-actions [data-action="new"]', at: 'c', dx: 10, dy: 4 } }] });
  await click('.home-actions [data-action="new"]');
  await click('.new-title');
  await type('備品を発注する手順');
  await move({ sel: '.mode-card', i: 0 });
  await sleep(200);
  await shot('m03_new_2', { clip: '.modal', pad: 10,
    anno: [{ box: '.new-title', n: 1, pad: 3, at: 'l' }, { box: { sel: '.mode-card', i: 0 }, n: 2, pad: 3, at: 'l' }, { box: { sel: '.mode-card', i: 1 }, n: 3, pad: 3, at: 'r' },
      { cursor: { sel: '.mode-card', i: 0, at: 'c', dx: 30, dy: 4 } }] });
  await click({ sel: '.mode-card', i: 0 });
  await page.mouse.move(700, 780);
  await sleep(500);
  await shot('m03_new_3');

  // 手順の各部
  await open();
  await openList('交通費を精算する手順');
  await scrollEl(step('m-i4'), 140);
  await click(`${step('m-i4')} .rb-body`);
  await page.mouse.move(5, 790);
  await sleep(200);
  await shot('m03_step', { clip: step('m-i4'), pad: 10, maxH: 520,
    anno: [
      { box: `${step('m-i4')} .step-badge`, n: 1, pad: 3, at: 'b' },
      { box: `${step('m-i4')} input[type=checkbox]`, n: 2, pad: 3, at: 'b' },
      { box: `${step('m-i4')} .step-text`, n: 3, pad: 2, at: 'tl' },
      { box: `${step('m-i4')} .step-time`, n: 4, pad: 2, at: 't' },
      { box: [`${step('m-i4')} [data-action="move-item-up"]`, `${step('m-i4')} [data-action="delete-item"]`], n: 5, pad: 2, at: 'tr' },
      { box: `${step('m-i4')} .rb`, n: 6, pad: 2, at: 'l' },
      { box: `${step('m-i4')} .step-note-input`, n: 7, pad: 2, at: 'l' },
      { box: `${step('m-i4')} .item-images`, n: 8, pad: 2, at: 'l' },
    ] });
  // 手順のあいだの「＋」
  await scrollEl(step('m-i5'), 300);
  await move({ sel: `.section[data-section="m-s3"] .item-gap`, i: 0 });
  await sleep(400);
  await shot('m03_gap_item', { clip: [{ sel: `.section[data-section="m-s3"] .item-gap`, i: 0, pad: 40 }], pad: 0,
    anno: [{ cursor: { sel: `.section[data-section="m-s3"] .item-add`, i: 0, at: 'c', dx: 2, dy: 2 } }] });
  // フェーズのあいだの「＋」
  await scrollEl('.sec-gap', 400, { i: 1 });
  await move({ sel: '.sec-gap', i: 1 });
  await sleep(400);
  await shot('m03_gap_sec', { clip: { sel: '.sec-gap', i: 1, pad: 36 }, pad: 0,
    anno: [{ cursor: { sel: '.sec-add', i: 1, at: 'c', dx: 2, dy: 2 } }] });
  // フェーズの見出し
  await scrollEl('.section', 160);
  await shot('m03_phase', { clip: { sel: '.section-head', i: 0 }, pad: 10,
    anno: [
      { box: { sel: '.section-head .grip', i: 0 }, n: 1, pad: 3, at: 't' },
      { box: { sel: '.section-head .section-title', i: 0 }, n: 2, pad: 2, at: 't' },
      { box: { sel: '.section-head .section-progress', i: 0 }, n: 3, pad: 2, at: 't' },
      { box: { sel: '.section-head [data-action="play-section"]', i: 0 }, n: 4, pad: 2, at: 't' },
      { box: { sel: '.section-head [data-action="add-item-btn"]', i: 0 }, n: 5, pad: 2, at: 't' },
      { box: { sel: '.section-head [data-action="delete-section"]', i: 0 }, n: 6, pad: 2, at: 't' },
    ] });
  // 本文の書式（ツールバー）と表
  await scrollEl(step('m-i1'), 140);
  await click(`${step('m-i1')} .rb-body p`);
  await page.mouse.move(5, 790);
  await sleep(250);
  await shot('m03_rb', { clip: `${step('m-i1')} .rb`, pad: 10,
    anno: [
      { box: [`${step('m-i1')} [data-rb-cmd="bold"]`, `${step('m-i1')} [data-rb-cmd="strikeThrough"]`], n: 1, pad: 2, at: 't' },
      { box: { sel: `${step('m-i1')} .rb-sizebox` }, n: 2, pad: 2, at: 't' },
      { box: { sel: `${step('m-i1')} .rb-toolbar [title="文字色"]` }, n: 3, pad: 2, at: 't' },
      { box: { sel: `${step('m-i1')} .rb-toolbar [title="箇条書き"]` }, n: 4, pad: 2, at: 't' },
      { box: { sel: `${step('m-i1')} .rb-toolbar [title="表を挿入"]` }, n: 5, pad: 2, at: 't' },
      { box: `${step('m-i1')} .rb-body table`, n: 6, pad: 2, at: 'r' },
    ] });
  // 並べ替え（↑↓・統合）と、サムネイル
  await scrollEl(step('m-i3'), 160);
  await shot('m03_move', { clip: `${step('m-i3')} .step-main`, pad: 8,
    anno: [
      { box: `${step('m-i3')} [data-action="move-item-up"]`, n: 1, pad: 2, at: 't' },
      { box: `${step('m-i3')} [data-action="move-item-down"]`, n: 2, pad: 2, at: 't' },
      { box: `${step('m-i3')} [data-action="merge-item-up"]`, n: 3, pad: 2, at: 't' },
      { box: `${step('m-i3')} [data-action="delete-item"]`, n: 4, pad: 2, at: 't' },
    ] });
  await scrollEl('.editor-head', 0);
  await shot('m03_thumbs', { clip: { c: [0, 0, 345, 800] }, pad: 0,
    anno: [
      { box: '#thumbs .tsb-head', n: 1, pad: -2, at: 'r', bdx: -40 },
      { box: { sel: '#thumbs .tsb-phase-head', i: 0 }, n: 2, pad: -1, at: 'r', bdx: -14 },
      { box: { sel: '#thumbs .tsb-card', i: 1 }, n: 3, pad: -1, at: 'r', bdx: -14 },
      { box: '#thumbs .tsb-resizer', n: 4, pad: 0, at: 'b', bdy: -380 },
    ] });
  // サムネイルの複数選択（Ctrl＋クリック）
  await click({ sel: '#thumbs .tsb-card', i: 1 });
  await page.keyboard.down('Control');
  await click({ sel: '#thumbs .tsb-card', i: 2 });
  await page.keyboard.up('Control');
  await sleep(300);
  await shot('m03_thumbs_multi', { clip: { c: [0, 0, 345, 560] }, pad: 0,
    anno: [{ box: '#thumbs .tsb-selbar', n: 1, pad: -1, at: 'r', bdx: -14 }] });
};

// ---- 第4章 画像を貼って描き込む ----
CH.m04 = async () => {
  await open();
  await openList('交通費を精算する手順');
  await scrollEl(step('m-i3'), 140);
  await move(`${step('m-i3')} img.thumb`);
  await sleep(300);
  await shot('m04_images', { clip: `${step('m-i3')} .item-images`, pad: 10, maxH: 260,
    anno: [
      { box: `${step('m-i3')} img.thumb`, n: 1, pad: 2, at: 'l', sw: 3 },
      { box: `${step('m-i3')} .thumb-del`, n: 2, pad: 2, at: 'l' },
    ] });
  await shot('btn_image', { clip: `${step('m-i1')} .add-image`, pad: 6 }).catch(async () => {
    await scrollEl(step('m-i1'), 140);
    await shot('btn_image', { clip: `${step('m-i1')} .add-image`, pad: 6 });
  });
  // 画像編集を開いて、四角・矢印・テキストを描く
  await scrollEl(step('m-i4'), 140);
  await click(`${step('m-i4')} img.thumb`);
  await sleep(800);
  const c = await box('.ie-canvas-wrap canvas');
  const at = (fx, fy) => [c.x + c.w * fx, c.y + c.h * fy];
  // 架空の画面の「確認へ進む」ボタンを四角で囲み、矢印と文字を添える（位置は画像の幅と高さに対する割合）
  await click('.ie-tool[data-tool="rect"]');
  await drag(at(0.765, 0.585), at(0.915, 0.68));
  await click('.ie-tool[data-tool="arrow"]');
  await drag(at(0.83, 0.47), at(0.84, 0.575));
  await click('.ie-tool[data-tool="text"]');
  await drag(at(0.73, 0.40), at(0.93, 0.46));
  await type('ここを押す');
  await page.keyboard.press('Enter');
  await sleep(200);
  await click('.ie-tool[data-tool="select"]');
  await page.mouse.click(...at(0.2, 0.9));
  await sleep(300);
  await shot('m04_ie', {
    anno: [
      { box: '.ie-tools', n: 1, pad: 2, at: 'b' },
      { box: '.ie-help', n: 2, pad: 2, at: 'l' },
      { box: ['.ie-color', '.ie-fill'], n: 3, pad: 2, at: 'b' },
      { box: '.ie-size', n: 4, pad: 2, at: 'b' },
      { box: '.ie-zoom', n: 5, pad: 2, at: 'b' },
      { box: ['.ie-undo', '.ie-redo'], n: 6, pad: 2, at: 'b' },
      { box: '.ie-canvas-wrap', n: 7, pad: -3, at: 'tl', bdx: 20, bdy: 20 },
      { box: ['.ie-save', '.ie-cancel'], n: 8, pad: 2, at: 'r' },
    ] });
  await shot('m04_ie_tools', { clip: '.ie-tools', pad: 6 });
  await click('.ie-help-btn');
  await sleep(400);
  await shot('m04_ie_help', { clip: '.modal.ie-help-doc', pad: 0, maxH: 640 });
  await page.keyboard.press('Escape');
  await click({ sel: '.ie-help-doc [data-close]' }).catch(() => {});
  await sleep(300);
  await click('.ie-save');
  await sleep(600);
  await scrollEl(step('m-i4'), 140);
  await shot('m04_after', { clip: `${step('m-i4')} .item-images`, pad: 6, maxH: 420 });
};

// ---- 第5章 画面を撮る（キャプチャ撮影） ----
function gadgetStub() {
  const cb = {};
  const ok = async () => ({ ok: true });
  window.recorderAPI = {
    onGadgetInit: (f) => { cb.init = f; }, onGadgetState: (f) => { cb.state = f; }, onGadgetUpdate: (f) => { cb.update = f; }, onGadgetWarn: (f) => { cb.warn = f; },
    beginCapture: async () => ({ ok: true, startTime: Date.now(), elapsedMs: 0 }), pauseRecording: async () => ({ ok: true, elapsedMs: 0 }),
    snap: ok, finishSession: ok, openShotsDir: ok, setMarker: ok, setDrag: ok,
  };
  window.__g = cb;
}
CH.m05 = async () => {
  await open();
  await openList('交通費を精算する手順');
  await shot('m05_button', { clip: [tb('record'), tb('import-rec')], pad: 8,
    anno: [{ box: tb('record'), n: 1, pad: 1, at: 'b' }, { box: tb('import-rec'), n: 2, pad: 1, at: 'b' }] });
  await openFile('gadget.html', 320, 362, { fn: gadgetStub });
  await ev(() => window.__g.init({ mode: 'ready', elapsedMs: 0, count: 0, name: '交通費を精算する手順', snapKey: 'F9', markerOn: true, dragOn: false }));
  await sleep(300);
  await shot('m05_gadget_ready');
  await ev((imgs) => {
    window.__g.state({ mode: 'recording', elapsedMs: 0, startTime: Date.now() - 83000 });
    imgs.forEach((im, i) => window.__g.update({ count: i + 1, preview: im }));
  }, [IMG.login, IMG.menu, IMG.form, IMG.confirm]);
  await sleep(600);
  await shot('m05_gadget_rec');
};

// ---- 第6章 画像をまとめて取り込む（画像インポート） ----
CH.m06 = async () => {
  const now = Date.parse('2026-11-11T10:15:00+09:00');
  const iso = (ms) => new Date(ms).toISOString();
  const sessions = [
    { name: '交通費を精算する手順', startedAt: iso(now), endedAt: iso(now + 300000), shots: 6, dir: 'S1' },
    { name: '新しいパソコンの初期設定', startedAt: iso(now - 86400000), endedAt: iso(now - 86000000), shots: 12, dir: 'S2', importedAt: iso(now - 85000000) },
  ];
  const files = [
    { path: 'C:/画像/01_ログイン.jpg', name: '01_ログイン.jpg' },
    { path: 'C:/画像/02_メニュー.jpg', name: '02_メニュー.jpg' },
    { path: 'C:/画像/03_入力.jpg', name: '03_入力.jpg' },
  ];
  const fileData = { 'C:/画像/01_ログイン.jpg': IMG.login, 'C:/画像/02_メニュー.jpg': IMG.menu, 'C:/画像/03_入力.jpg': IMG.form };
  await open({ sessions, files, fileData });
  await openList('交通費を精算する手順');
  await click(tb('import-rec'));
  await sleep(500);
  await shot('m06_picker', { clip: '.modal', pad: 0,
    anno: [
      { box: '.modal [data-iw-pick-files]', n: 1, pad: 2, at: 'l' },
      { box: { sel: '.modal .iw-session', i: 0 }, n: 2, pad: 2, at: 'l' },
    ] });
  await click('.modal [data-iw-pick-files]');
  await sleep(1200);
  const texts = ['経費精算システムにログインする', 'メニューの「交通費精算」を押す', '利用日・区間・金額・目的を入力する'];
  for (let i = 0; i < texts.length; i++) {
    await click({ sel: '.iw-text', i });
    await type(texts[i]);
  }
  await page.mouse.move(5, 5);
  await scrollEl('.modal.import-wiz', 20).catch(() => {});
  await shot('m06_wizard', { clip: '.modal.import-wiz', pad: 0, maxH: 760,
    anno: [
      { box: '.iw-bulk', n: 1, pad: 2, at: 'l' },
      { box: { sel: '.iw-row', i: 0 }, n: 2, pad: 1, at: 'l' },
      { box: { sel: '.iw-tools', i: 1 }, n: 3, pad: 2, at: 't' },
      { box: '.iw-dest', n: 4, pad: 1, at: 'l' },
      { box: '[data-iw-import]', n: 5, pad: 2, at: 'l' },
    ] });
  await click('[data-iw-mode="insert"]');
  await sleep(400);
  await ev(() => { const s = document.querySelector('.iw-phase-select'); s.selectedIndex = 1; s.dispatchEvent(new Event('change')); });
  await sleep(300);
  await click({ sel: '.ip-slot', i: 1 });
  await sleep(300);
  await shot('m06_insert', { clip: '.iw-dest', pad: 8,
    anno: [
      { box: '[data-iw-mode="insert"]', n: 1, pad: 2, at: 'r' },
      { box: '.iw-phase-select', n: 2, pad: 2, at: 'r' },
      { box: { sel: '.ip-slot.active' }, n: 3, pad: 2, at: 't' },
    ] });
};

// ---- 第7章 表紙を付ける ----
CH.m07 = async () => {
  await open();
  await openList('交通費を精算する手順');
  await click(tb('cover'));
  await sleep(600);
  await shot('m07_cover', {
    anno: [
      { box: '.ce-enable', n: 1, pad: 2, at: 'l' },
      { box: '.ce-preset-grid', n: 2, pad: 2, at: 'l' },
      { box: '.ce-preview', n: 3, pad: 2, at: 'tr' },
    ] });
  await ev(() => { const b = document.querySelector('.cover-editor .ce-body, .cover-editor .ce-form'); if (b) b.scrollTop = 10000; });
  await ev(() => { const el = document.querySelector('.ce-fields'); if (el) el.scrollIntoView({ block: 'start' }); });
  await sleep(300);
  await shot('m07_cover_fields', {
    anno: [
      { box: '.ce-swatches', n: 1, pad: 2, at: 'l' },
      { box: '.ce-logo-row', n: 2, pad: 2, at: 'l' },
      { box: '.ce-fields', n: 3, pad: 2, at: 'l' },
      { box: '.ce-rev', n: 4, pad: 2, at: 'l' },
    ] }).catch(async (e) => { console.log('  m07_cover_fields: ' + e.message); await shot('m07_cover_fields'); });
};

// ---- 第8章 印刷とファイルの出力 ----
CH.m08 = async () => {
  await open();
  await openList('交通費を精算する手順');
  await click(tb('menu-export'));
  await sleep(300);
  await shot('m08_export', { clip: [tb('menu-export'), '.tb-menu'], pad: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 700);
  await sleep(300);
  await click(tb('print'));
  await sleep(1200);
  await shot('m08_print', {
    anno: [
      { box: '.print-preview-bar', n: 1, pad: 2, at: 'r' },
      { box: '.print-preview-stage', n: 2, pad: -6, at: 'tl', bdx: 24, bdy: 24 },
    ] });
  await shot('m08_print_bar', { clip: ['.print-preview-bar', '.pp-out'], pad: 8,
    anno: [
      { box: ['.pp-grid-rows', '.pp-grid-cols'], n: 1, pad: 3, at: 'b' },
      { box: '.pp-scale', n: 2, pad: 3, at: 'b' },
      { box: ['.pp-from', '.pp-to'], n: 3, pad: 3, at: 'b' },
      { box: ['.pp-paper', '.pp-orient'], n: 4, pad: 3, at: 'b' },
      { box: { sel: '.print-preview button', text: '印刷' }, n: 5, pad: 2, at: 'b' },
      { box: { sel: '.print-preview button', text: 'PDF' }, n: 6, pad: 2, at: 'b' },
      { box: { sel: '.print-preview button', text: '閉じる' }, n: 7, pad: 2, at: 'b' },
    ] });
  // 縦2×横2 にしたとき
  await ev(() => { const r = document.querySelector('.pp-grid-rows'); r.value = '2'; r.dispatchEvent(new Event('change', { bubbles: true })); const c = document.querySelector('.pp-grid-cols'); c.value = '2'; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(1200);
  await ev(() => { const st = document.querySelector('.print-preview-stage'); const sh = st.querySelectorAll('.pp-sheet, .sheet, .print-sheet'); if (sh[2]) sh[2].scrollIntoView({ block: 'start' }); else st.scrollTop = st.scrollHeight / 2; });
  await sleep(500);
  await shot('m08_print_2x2', { clip: '.print-preview-stage', pad: 0 });
  // 共有リンクの窓はリンクの文字にパソコンの中の場所が出るので撮らない（文で説明する）
};

// ---- 第9章 手順書を見ながら作業する ----
function guideStub() {
  const cb = {};
  window.guideAPI = { onStep: (f) => { cb.step = f; }, sendAction() {}, resize() {} };
  window.__g = cb;
}
CH.m09 = async () => {
  await open();
  await openList('交通費を精算する手順');
  await click(tb('menu-run'));
  await sleep(300);
  await shot('m09_runmenu', { clip: [tb('menu-run'), '.tb-menu'], pad: 8 });
  await click({ sel: '.tb-menu button', text: '全画面で実行' });
  await sleep(500);
  await click({ sel: '.player-overlay button', text: '完了して次へ' });
  await click({ sel: '.player-overlay button', text: '完了して次へ' });
  await click({ sel: '.player-overlay button', text: '完了して次へ' });
  await sleep(500);
  await shot('m09_player', {
    anno: [
      { box: '.pl-top', n: 1, pad: -2, at: 'bl', bdx: 20 },
      { box: '.pl-progress', n: 2, pad: 2, at: 'r' },
      { box: '.pl-shot, .pl-img', n: 3, pad: 2, at: 'tl' },
      { box: '.pl-times', n: 4, pad: 2, at: 'tl' },
      { box: '.pl-bottom', n: 5, pad: -2, at: 'tl', bdx: 20 },
    ] }).catch(async (e) => { console.log('  m09_player: ' + e.message); await shot('m09_player'); });
  // 最後まで進めたときのまとめ
  for (let i = 0; i < 3; i++) await click({ sel: '.player-overlay button', text: '完了して次へ' });
  await sleep(600);
  await shot('m09_summary');
  // 小窓（guide.html）
  await openFile('guide.html', 320, 430, { fn: guideStub });
  await ev((im) => window.__g.step({ title: '交通費を精算する手順', sectionTitle: '② 入力：交通費を入力する', index: 4, total: 6,
    text: '利用日・区間・金額・目的を入力して「確認へ進む」を押す', note: '', stdMin: 5, seconds: 75, image: im }), IMG.form);
  await sleep(400);
  await shot('m09_guide');
};

// ---- 第10章 ToDo型のリスト ----
CH.m10 = async () => {
  await open();
  await openList('月末の締め作業');
  await page.mouse.move(700, 790);
  await shot('m10_todo', {
    anno: [
      { box: tb('clear-completed'), n: 1, pad: 1, at: 'b' },
      { box: [tb('add-step-here'), tb('add-section-here')], n: 2, pad: 1, at: 'b' },
      { box: { sel: 'li.item.done', i: 0 }, n: 3, pad: 2, at: 'l' },
      { box: { sel: '.section-head', i: 1 }, n: 4, pad: 2, at: 'l' },
    ] });
};

// ---- 第11章 データの保存と受け渡し ----
CH.m11 = async () => {
  await open();
  await ev(() => { window.__test__.askJsonImportMode(3); });
  await sleep(400);
  await shot('m11_jsonmode', { clip: '.modal', pad: 0 });
};

// ============================================================
//  起動
// ============================================================
async function main() {
  const want = process.argv.slice(2);
  B = await launch();
  try {
    IMG = await makeFakeImages();
    for (const [k, fn] of Object.entries(CH)) {
      if (want.length && !want.includes(k)) continue;
      console.log('== ' + k);
      await fn();
    }
  } finally {
    fs.writeFileSync(MANIFEST, JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 1));
    await B.browser.close();
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
