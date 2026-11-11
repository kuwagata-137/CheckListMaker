'use strict';
// 操作マニュアル（マニュアル/。docs/spec-manual.md）のテスト。jsdom を使わない。
//   撮った画面（screenshots/manual/）は Git に入れないため、ここでは画像そのものは見ない。
//   版と Word の名前・原稿が使う画像を撮影の台本が撮っているか・文の決まりを確かめる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'マニュアル');
const TOOL = path.join(DIR, '作成ツール');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_VERSION = 'v' + PKG.version;
const content = require(path.join(TOOL, 'manual-content.js'))({ APP_VERSION, LAST_UPDATED: 'テスト' });
const captureSrc = fs.readFileSync(path.join(TOOL, 'capture.js'), 'utf8');

// 原稿が使う画像の名前（図・手順表・並べた図・ボタンの表・行内のボタン・表紙）
function usedImages() {
  const names = new Set([content.cover.img]);
  const walkParts = (parts) => (Array.isArray(parts) ? parts : [parts]).forEach((p) => {
    if (Array.isArray(p)) walkParts(p);
    else if (p && typeof p === 'object' && p.icon) names.add(p.icon);
  });
  for (const b of content.body) {
    if (b.img) names.add(b.img);
    if (b.t === 'steps') b.list.forEach((s) => { if (s.img) names.add(s.img); s.text.forEach(walkParts); });
    if (b.t === 'pair') b.list.forEach((s) => names.add(s.img));
    if (b.t === 'itab') b.rows.forEach((r) => { if (r[0]) names.add(r[0]); });
    if (b.parts) walkParts(b.parts);
    if (b.o && b.o.callouts) b.o.callouts.forEach((c) => walkParts(c.desc || ''));
  }
  return [...names];
}

test('Word の操作マニュアルが、今の版の名前である（版を上げたら npm run manual で作り直す）', () => {
  const docx = `CheckListMaker_操作マニュアル_${APP_VERSION}.docx`;
  assert.ok(fs.existsSync(path.join(DIR, docx)), `マニュアル/${docx} がない`);
  const others = fs.readdirSync(DIR).filter((f) => f.endsWith('.docx') && f !== docx);
  assert.deepEqual(others, [], '古い版の .docx が残っている');
});

test('原稿が使う画像は、すべて撮影の台本（capture.js）が撮っている', () => {
  // shot('名前' か、ボタンの一覧（['add-step-here', 'addstep'] → btn_addstep）で撮る
  const shotNames = new Set([...captureSrc.matchAll(/shot\('([a-z0-9_]+)'/g)].map((m) => m[1]));
  for (const m of captureSrc.matchAll(/\['[a-z-]+', '([a-z]+)'\]/g)) shotNames.add('btn_' + m[1]);
  const missing = usedImages().filter((n) => !shotNames.has(n));
  assert.deepEqual(missing, [], '撮っていない画像: ' + missing.join(' '));
});

test('原稿の文の決まり（丁寧語だけ・「本書」と書かない）', () => {
  const text = JSON.stringify(content);
  assert.doesNotMatch(text, /いたし|ございま|でござい|おります|ておりま|申し上げ|におきまし/);
  assert.doesNotMatch(text, /本書|本マニュアル/);
  assert.doesNotMatch(text, /書き出/); // 画面の言葉は「出力」
});

test('マニュアルの作り方を npm のコマンドで動かせ、撮った画面は Git に入れない', () => {
  assert.equal(PKG.scripts.manual, 'node マニュアル/作成ツール/create-manual.js');
  assert.equal(PKG.scripts['manual:shoot'], 'node マニュアル/作成ツール/capture.js');
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^screenshots\/manual\/$/m);
});

test('インストーラは マニュアル/ の .docx を resources/マニュアル に入れる（作成ツールは入れない）', () => {
  assert.deepEqual(PKG.build.extraResources, [{ from: 'マニュアル', to: 'マニュアル', filter: ['*.docx'] }]);
  assert.ok(!PKG.build.files.some((f) => /マニュアル|作成ツール/.test(f)), PKG.build.files.join(' '));
  assert.ok(PKG.build.files.includes('manualfile.js'));
});

test('ヘルプ > 操作マニュアル: メニュー → openManual → 一時フォルダに写して既定のアプリで開く', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /label: 'ヘルプ'/);
  assert.match(main, /\{ label: '操作マニュアル', click: \(\) => openManual\(\) \}/);
  assert.match(main, /prepareManual\(\{ dir, version: app\.getVersion\(\), tmpDir: app\.getPath\('temp'\) \}\)/);
  assert.match(main, /await shell\.openPath\(file\)/);
});

test('manualfile: 開くファイルの選び方と、一時フォルダへの写し', () => {
  const os = require('os');
  const { pickManualFile, manualDir, prepareManual } = require(path.join(ROOT, 'manualfile.js'));
  const a = 'CheckListMaker_操作マニュアル_v1.0.13.docx', b = 'CheckListMaker_操作マニュアル_v1.0.14.docx';
  assert.equal(pickManualFile([b, a, 'メモ.txt'], '1.0.13'), a); // アプリの版と同じもの
  assert.equal(pickManualFile([a, b], '2.0.0'), b);               // なければ名前の順で最後
  assert.equal(pickManualFile(['メモ.docx'], '1.0.13'), null);
  assert.equal(manualDir({ isPackaged: true, resourcesPath: '/r', appDir: '/a' }), path.join('/r', 'マニュアル'));
  assert.equal(manualDir({ isPackaged: false, resourcesPath: '/r', appDir: '/a' }), path.join('/a', 'マニュアル'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clm-manual-'));
  try {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, a), 'docx');
    const out = prepareManual({ dir: src, version: '1.0.13', tmpDir: path.join(tmp, 't') });
    assert.equal(out, path.join(tmp, 't', 'CheckListMaker', a));
    assert.equal(fs.readFileSync(out, 'utf8'), 'docx');
    assert.equal(prepareManual({ dir: path.join(tmp, 'ない'), version: '1.0.13', tmpDir: tmp }), null);
    // リポジトリのマニュアルも、今の版のものが選ばれる
    assert.equal(pickManualFile(fs.readdirSync(DIR), PKG.version), `CheckListMaker_操作マニュアル_${APP_VERSION}.docx`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
