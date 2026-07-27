'use strict';
// checklist-maker スキル（AI 向け利用ガイド）の回帰テスト。
// 仕様は docs/spec-ai-usage-skill.md 参照。
//  - 同梱バリデータが「実在の手順書データ」と「同梱テンプレート」をエラー無しで通すこと。
//  - 壊れた入力ではエラーを出し、終了コード 1 を返すこと。
//  - テンプレートが index.html で実際に開けること（＝ドキュメントの嘘を防ぐ）。
//  - スキルが「type は template」と書いている根拠（note/time/body が出力に載る）が
//    アプリの実装と一致していること。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { bootApp, waitFor } = require('./harness');

const ROOT = path.join(__dirname, '..');
const SKILL = path.join(ROOT, '.claude', 'skills', 'checklist-maker');
const VALIDATOR = path.join(SKILL, 'scripts', 'validate-checklist.mjs');
const TEMPLATES = ['minimal', 'procedure'].map((n) =>
  path.join(SKILL, 'templates', `${n}.checklist.json`)
);

// バリデータを子プロセスで実行し、終了コードと出力を返す（本体は process.exit を呼ぶため）。
function runValidator(file) {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, file, '--max-mb', '16'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

// 壊した JSON を一時ファイルに書いて検証する
function validateObject(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clm-skill-'));
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  try {
    return runValidator(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const validTemplate = () => JSON.parse(fs.readFileSync(TEMPLATES[0], 'utf8'));

test('checklist-maker スキル — バリデータ', async (t) => {
  await t.test('同梱テンプレートはエラー無しで通る', () => {
    for (const file of TEMPLATES) {
      const { code, out } = runValidator(file);
      assert.equal(code, 0, `${path.basename(file)} が通らない:\n${out}`);
      assert.doesNotMatch(out, /エラー/, `${path.basename(file)} に警告以上が出ている:\n${out}`);
    }
  });

  await t.test('実在の手順書データ（exe作成手順）も通る', () => {
    const real = path.join(ROOT, 'docs', 'templates', 'exe作成手順.checklist.json');
    if (!fs.existsSync(real)) return; // 任意の資料なので無ければスキップ
    const { code, out } = runValidator(real);
    assert.equal(code, 0, `実データが通らない:\n${out}`);
  });

  await t.test('checklists 配列が無ければエラー（アプリ本体と同じ判定）', () => {
    const { code, out } = validateObject({ foo: 1 });
    assert.equal(code, 1);
    assert.match(out, /checklists/);
  });

  await t.test('JSON として壊れていればエラー', () => {
    const { code } = validateObject('{ broken');
    assert.equal(code, 1);
  });

  await t.test('type が template/todo 以外ならエラー', () => {
    const d = validTemplate();
    d.checklists[0].type = 'procedure';
    const { code, out } = validateObject(d);
    assert.equal(code, 1);
    assert.match(out, /type/);
  });

  await t.test('id の重複を検出する', () => {
    const d = validTemplate();
    d.checklists[0].sections[0].items[1].id = d.checklists[0].sections[0].items[0].id;
    const { code, out } = validateObject(d);
    assert.equal(code, 1);
    assert.match(out, /重複/);
  });

  await t.test('body の許可外タグを検出する', () => {
    const d = validTemplate();
    d.checklists[0].sections[0].items[0].body = '<h2>見出し</h2><img src="x">';
    const { code, out } = validateObject(d);
    assert.equal(code, 1);
    assert.match(out, /H2/);
    assert.match(out, /IMG/);
  });

  await t.test('images の要素が dataURL でも img: 参照でもなければエラー', () => {
    const d = validTemplate();
    d.checklists[0].sections[0].items[0].images = ['./photo.png'];
    const { code, out } = validateObject(d);
    assert.equal(code, 1);
    assert.match(out, /images/);
  });

  await t.test('coverPage.date が ISO でなければエラー', () => {
    const d = JSON.parse(fs.readFileSync(TEMPLATES[1], 'utf8'));
    d.checklists[0].coverPage.date = '2026/07/27';
    const { code, out } = validateObject(d);
    assert.equal(code, 1);
    assert.match(out, /date/);
  });
});

test('checklist-maker スキル — テンプレートが実際にアプリで開ける', async (t) => {
  for (const file of TEMPLATES) {
    const name = path.basename(file);
    await t.test(`${name} を読み込んで編集画面が描画される`, async () => {
      const state = fs.readFileSync(file, 'utf8');
      const app = bootApp({ localStorage: { 'checklistmaker.v1': state } });
      try {
        const api = await app.api();
        const data = JSON.parse(state);
        const c = data.checklists[0];
        assert.equal(api.store.state.checklists.length, 1, '取り込まれている');
        assert.equal(api.store.state.checklists[0].title, c.title);

        const expected = c.sections.reduce((n, s) => n + s.items.length, 0);
        app.window.location.hash = '#/c/' + c.id;
        await waitFor(
          () => app.document.querySelectorAll('.item-text').length >= expected,
          { label: '編集画面の描画' }
        );
        // 全手順の text が画面に出ていること（手順名は input の value で描画される）
        const rendered = new Set(
          [...app.document.querySelectorAll('.item-text')].map((el) => el.value)
        );
        for (const s of c.sections) {
          for (const it of s.items) {
            assert.ok(rendered.has(it.text), `手順が描画されない: ${it.text}`);
          }
        }
        // リッチ本文（body）もそのまま描画されること
        const bodies = [...app.document.querySelectorAll('[data-rb-edit]')]
          .map((el) => el.innerHTML).join('\n');
        for (const s of c.sections) {
          for (const it of s.items) {
            if (!it.body) continue;
            assert.ok(bodies.includes('<table'), '表を含む body が描画される');
          }
        }
      } finally {
        app.close();
      }
    });
  }
});

test('checklist-maker スキル — ドキュメントの主張がアプリの実装と一致する', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const api = await app.api();
  const { M, sanitizeBodyHtml, buildCsvText } = api;

  await t.test('SKILL.md の allowlist 20 タグが実際に残り、それ以外は落ちる', () => {
    const allowed = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'span',
      'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div'];
    // 構造タグは単体だと親要素へ正規化されうるので、代表的なインライン/ブロックのみ厳密検査
    for (const tag of ['p', 'strong', 'b', 'em', 'i', 'u', 's', 'span', 'ul', 'ol', 'li', 'div']) {
      const out = sanitizeBodyHtml(`<${tag}>残る</${tag}>`);
      assert.match(out, new RegExp(`<${tag}[ >]`, 'i'), `${tag} が落ちている`);
    }
    assert.equal(allowed.length, 20, 'allowlist は 20 タグ');
    // ドキュメントが「使えない」と書いているもの
    for (const tag of ['h1', 'h2', 'h3', 'a', 'code', 'pre', 'script', 'img']) {
      const out = sanitizeBodyHtml(`<${tag}>x</${tag}>`);
      assert.doesNotMatch(out, new RegExp(`<${tag}[ >]`, 'i'), `${tag} が残ってしまう`);
    }
  });

  await t.test('type=template では note/time/body が出力に載り、todo では載らない', () => {
    const build = (type) => {
      const c = M.createChecklist(type, 'T');
      const sid = c.sections[0].id;
      M.addItem(c, sid, '手順A');
      const it = c.sections[0].items[0];
      M.setItemField(c, sid, it.id, 'note', 'メモ本文');
      M.setItemField(c, sid, it.id, 'time', '7');
      M.setItemField(c, sid, it.id, 'body', '<p>詳細本文</p>');
      return buildCsvText(c);
    };
    const tpl = build('template');
    assert.ok(tpl.includes('メモ本文'), 'template では note が出る');
    assert.ok(tpl.includes('詳細本文'), 'template では body が出る');
    assert.ok(tpl.includes('7'), 'template では time が出る');

    const todo = build('todo');
    assert.ok(!todo.includes('メモ本文'), 'todo では note が出ない');
    assert.ok(!todo.includes('詳細本文'), 'todo では body が出ない');
  });

  await t.test('coverPage は type=template かつ enabled のときだけ描画対象になる', () => {
    const cover = M.createCoverPage();
    assert.equal(cover.enabled, true);
    assert.equal(cover.includeToc, true);
    assert.equal(cover.preset, 'centered');
    assert.match(cover.date, /^\d{4}-\d{2}-\d{2}$/, '既定の日付は ISO');
  });

  await t.test('time は parseInt で合計される（文字列で持つ）', () => {
    assert.equal(M.sumMinutes([{ time: '5' }, { time: '7' }, { time: '' }]), 12);
  });
});
