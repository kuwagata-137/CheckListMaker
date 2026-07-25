'use strict';
// サムネイルサイドバー / 取り込みの挿入位置指定のテスト。
// 仕様は docs/spec-thumbnail-sidebar-and-import-insert.md 参照。

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootApp, waitFor, PX_JPEG } = require('./harness');

// jsdom（別 Realm）で作られた配列は deepStrictEqual がプロトタイプ不一致で落ちるため、
// JSON 経由でプレーンな値に正規化してから比較する（既存テストと同じ作法）。
const plain = (v) => JSON.parse(JSON.stringify(v));

const STORAGE_KEY = 'checklistmaker.v1';

// フェーズ2つ・手順4つ（1つは画像あり・1つは文が空）のテンプレートを1件持つ状態
const seedState = () => ({
  checklists: [{
    id: 'c1', title: 'サーバー点検', type: 'template', createdAt: 1, updatedAt: 1,
    sections: [
      {
        id: 's1', title: '準備', items: [
          { id: 'i1', text: '共有フォルダを開く', done: false, note: '', time: '', body: '', images: [PX_JPEG] },
          { id: 'i2', text: '設定ダイアログを開く', done: false, note: '', time: '', body: '', images: [] },
        ],
      },
      {
        id: 's2', title: '', items: [
          { id: 'i3', text: '疎通を確認する', done: false, note: '', time: '', body: '', images: [] },
          { id: 'i4', text: '', done: false, note: '', time: '', body: '', images: [] },
        ],
      },
    ],
  }],
  settings: { theme: 'auto' },
});

const todoState = () => ({
  checklists: [{
    id: 't1', title: '買い物', type: 'todo', createdAt: 1, updatedAt: 1,
    sections: [{ id: 'ts1', title: '', items: [{ id: 'ti1', text: '牛乳', done: false, images: [] }] }],
  }],
  settings: { theme: 'auto' },
});

test('thumbsidebar — 表示モデル（純関数）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();

  await t.test('通し番号はフェーズをまたいで 1..N', () => {
    const model = T.thumbStepModel(seedState().checklists[0]);
    assert.deepEqual(plain(model).map((p) => p.items.map((i) => i.no)), [[1, 2], [3, 4]]);
  });

  await t.test('フェーズ名が空なら連番で補う（区切りが読めなくなるため）', () => {
    const model = T.thumbStepModel(seedState().checklists[0]);
    assert.equal(model[0].title, '準備');
    assert.equal(model[1].title, 'フェーズ 2', '空タイトルは連番で補完');
    assert.deepEqual(plain(model).map((p) => p.count), [2, 2]);
  });

  await t.test('サムネは images[0]。無い手順は null（カード自体は出す）', () => {
    const model = T.thumbStepModel(seedState().checklists[0]);
    assert.equal(model[0].items[0].image, PX_JPEG);
    assert.equal(model[0].items[1].image, null);
    assert.equal(model[1].items.length, 2, '画像が無くても手順ぶんのカードは作る');
  });

  await t.test('チェックリストが無くても落ちない', () => {
    assert.deepEqual(plain(T.thumbStepModel(null)), []);
    assert.deepEqual(plain(T.thumbStepModel({ sections: [] })), []);
  });
});

test('thumbsidebar — 画面への出方', async (t) => {
  await t.test('テンプレート型の編集画面では出て、フェーズごとにカードが並ぶ', async () => {
    const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
    try {
      await app.api();
      const doc = app.document;
      app.window.location.hash = '#/c/c1';
      const sidebar = await waitFor(() => doc.querySelector('#thumbs .tsb-scroll'), { label: 'サイドバー' });

      assert.ok(doc.body.classList.contains('has-thumbs'), '本文を右へ寄せる class が付く');
      assert.equal(sidebar.querySelectorAll('.tsb-phase').length, 2, 'フェーズ2つ');
      assert.equal(sidebar.querySelectorAll('.tsb-card').length, 4, '手順4つぶんのカード');
      assert.deepEqual(
        [...sidebar.querySelectorAll('.tsb-no')].map((n) => n.textContent),
        ['1', '2', '3', '4'],
        '通し番号が本文と揃う'
      );
      // ドラッグの掴み手と削除ボタンがカードごとに付く
      assert.equal(sidebar.querySelectorAll('.tsb-grip').length, 4);
      assert.equal(sidebar.querySelectorAll('[data-action="delete-item"]').length, 4);
      // 画像なしの手順はプレースホルダ、ある手順は img
      assert.equal(sidebar.querySelectorAll('.tsb-noimg').length, 3);
      assert.equal(sidebar.querySelectorAll('img.tsb-shot').length, 1);
      // 文が空の手順は「（未入力）」で潰れない
      assert.ok([...sidebar.querySelectorAll('.tsb-cap')].some((e) => e.textContent === '（未入力）'));
    } finally {
      app.close();
    }
  });

  await t.test('ToDo型では出さない', async () => {
    const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(todoState()) } });
    try {
      await app.api();
      app.window.location.hash = '#/c/t1';
      await waitFor(() => app.document.querySelector('.editor'), { label: 'エディタ' });
      assert.equal(app.document.body.classList.contains('has-thumbs'), false);
      const el = app.document.querySelector('#thumbs');
      assert.ok(!el || !el.querySelector('.tsb-card'), 'カードは描かれない');
    } finally {
      app.close();
    }
  });

  await t.test('ホーム（一覧）でも出さない', async () => {
    const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
    try {
      await app.api();
      app.window.location.hash = '#/c/c1';
      await waitFor(() => app.document.querySelector('#thumbs .tsb-card'), { label: 'サイドバー' });
      app.window.location.hash = '#/';
      await waitFor(() => !app.document.body.classList.contains('has-thumbs'), { label: 'ホームで非表示' });
    } finally {
      app.close();
    }
  });

  await t.test('カードの ✕ で手順が消え、Undo で戻る', async () => {
    const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
    try {
      const T = await app.api();
      app.window.location.hash = '#/c/c1';
      await waitFor(() => app.document.querySelector('#thumbs .tsb-card'), { label: 'サイドバー' });

      const del = app.document.querySelector('#thumbs .tsb-card[data-item="i2"] [data-action="delete-item"]');
      del.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
      const ids = () => plain(T.store.state.checklists[0].sections[0].items).map((i) => i.id);
      assert.deepEqual(ids(), ['i1'], '対象の手順だけが消える');
      T.store.undo();
      assert.deepEqual(ids(), ['i1', 'i2'], 'Undo 1回で戻る');
    } finally {
      app.close();
    }
  });

  await t.test('折りたたみは設定に残り、Undo 履歴を汚さない', async () => {
    const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
    try {
      const T = await app.api();
      app.window.location.hash = '#/c/c1';
      await waitFor(() => app.document.querySelector('#thumbs .tsb-card'), { label: 'サイドバー' });
      assert.equal(T.thumbsCollapsed(), false, '既定は展開');

      const before = T.store.canUndo();
      app.document.querySelector('[data-action="toggle-thumbs"]')
        .dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));

      assert.equal(T.thumbsCollapsed(), true);
      assert.equal(T.store.state.settings.thumbsCollapsed, true, '設定に保存される');
      assert.equal(T.store.canUndo(), before, '見た目の設定は Undo 履歴に積まない');
      assert.ok(app.document.querySelector('#thumbs').classList.contains('is-collapsed'));
    } finally {
      app.close();
    }
  });
});

// 画像は読み込ませない（jsdom に canvas が無く compressImage が通らないため）。
// readImage が null を返すと本体は「文だけ取り込む」経路に入る。
function stubRecorderAPI(shots = 2) {
  return {
    listSessions: () => Promise.resolve([]),
    loadSession: () => Promise.resolve({
      info: { name: 'ログイン手順の撮り直し', startedAt: '2026-07-25T00:14:00.000Z', endedAt: '2026-07-25T00:16:00.000Z', shots, importedAt: null },
      steps: Array.from({ length: shots }, (_, i) => ({
        seq: i + 1, kind: 'click', image: `00${i + 1}.png`, zoomImage: null, zoomSource: null,
        text: `撮り直した手順${i + 1}`, uia: null, click: null, time: null,
      })),
    }),
    readImage: () => Promise.resolve(null),
    markImported: () => Promise.resolve({ ok: true }),
    openShotsDir: () => {},
  };
}

test('thumbsidebar — 取り込みウィザードの挿入先指定（画面）', async (t) => {
  const app = bootApp({ localStorage: { [STORAGE_KEY]: JSON.stringify(seedState()) } });
  t.after(() => app.close());
  const T = await app.api();
  const win = app.window;
  const doc = app.document;
  win.recorderAPI = stubRecorderAPI();
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const row = (k) => doc.querySelector(`[data-iw-row="${k}"]`);

  win.location.hash = '#/c/c1';
  await waitFor(() => doc.querySelector('#thumbs .tsb-card'), { label: 'エディタ' });
  T.openImportWizard('D:/shots/session');
  await waitFor(() => doc.querySelector('.modal.import-wiz'), { label: 'ウィザード' });

  await t.test('既定は「新しいフェーズとして追加」（現行の動きを変えない）', () => {
    assert.equal(doc.querySelector('[data-iw-mode="new"]').classList.contains('active'), true);
    assert.equal(row('title').hidden, false, 'セクション名の欄が出る');
    assert.equal(row('phase').hidden, true, 'フェーズ選択は隠れている');
    assert.equal(row('pos').hidden, true, '挿入位置も隠れている');
    assert.equal(doc.querySelector('[data-iw-import]').textContent, '取り込む');
  });

  await t.test('「既存のフェーズに挿入」でフェーズ一覧と挿入位置が出る', () => {
    click(doc.querySelector('[data-iw-mode="insert"]'));
    assert.equal(row('title').hidden, true, 'セクション名は引っ込む');
    assert.equal(row('phase').hidden, false);
    assert.equal(row('pos').hidden, false);

    const opts = [...doc.querySelectorAll('.iw-phase-select option')].map((o) => o.textContent);
    assert.deepEqual(opts, ['準備（2件）', 'フェーズ 2（2件）'], '空タイトルは連番で補う');

    // 手順2つ → すき間は3箇所（先頭・あいだ・末尾）
    assert.equal(doc.querySelectorAll('.ip-slot').length, 3);
    assert.equal(doc.querySelectorAll('.ip-shot').length, 2);
    const active = doc.querySelector('.ip-slot.active');
    assert.equal(active.dataset.ipAt, '2', '既定は末尾');
    assert.equal(doc.querySelector('[data-iw-import]').textContent, '末尾に2件を挿入');
  });

  await t.test('すき間を選ぶとボタンが結果を言う', () => {
    click(doc.querySelector('.ip-slot[data-ip-at="1"]'));
    assert.equal(doc.querySelector('.ip-slot.active').dataset.ipAt, '1');
    assert.equal(doc.querySelector('[data-iw-import]').textContent, '手順1の後に2件を挿入');
    click(doc.querySelector('.ip-slot[data-ip-at="0"]'));
    assert.equal(doc.querySelector('[data-iw-import]').textContent, '先頭に2件を挿入');
  });

  await t.test('取り込むと選んだ位置へ割り込み、Undo 1回で戻る', async () => {
    click(doc.querySelector('.ip-slot[data-ip-at="1"]')); // 手順1の後
    click(doc.querySelector('[data-iw-import]'));
    await waitFor(() => !doc.querySelector('.modal.import-wiz'), { label: '取り込み完了' });

    const texts = () => plain(T.store.state.checklists[0].sections[0].items).map((i) => i.text);
    assert.deepEqual(texts(), ['共有フォルダを開く', '撮り直した手順1', '撮り直した手順2', '設定ダイアログを開く']);
    assert.equal(T.store.state.checklists[0].sections.length, 2, '新しいフェーズは増えない');

    T.store.undo();
    assert.deepEqual(texts(), ['共有フォルダを開く', '設定ダイアログを開く'], '1コミット＝Undo1回');
  });
});

test('thumbsidebar — 取り込みの挿入位置（純関数）', async (t) => {
  const app = bootApp();
  t.after(() => app.close());
  const T = await app.api();
  const plain = (v) => JSON.parse(JSON.stringify(v));

  await t.test('clampInsertIndex — 負値は先頭・超過と非数は末尾', () => {
    assert.equal(T.clampInsertIndex(3, 0), 0);
    assert.equal(T.clampInsertIndex(3, 2), 2);
    assert.equal(T.clampInsertIndex(3, -5), 0);
    assert.equal(T.clampInsertIndex(3, 99), 3);
    assert.equal(T.clampInsertIndex(3, NaN), 3);
    assert.equal(T.clampInsertIndex(3, undefined), 3);
    assert.equal(T.clampInsertIndex(0, 0), 0, '空フェーズは 0 のみ');
  });

  await t.test('buildImportItems — 文はトリム・画像は thumb/full の2段で入る', () => {
    const steps = T.wizardStepsFrom({
      steps: [
        { seq: 1, image: '001.png', zoomImage: null, zoomSource: null, text: '  押す  ' },
        { seq: 2, image: '002.png', zoomImage: null, zoomSource: null, text: null },
      ],
    });
    const items = T.buildImportItems(steps, [[{ thumb: 'img:a.jpg', full: 'img:a-full.jpg' }], []]);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, '押す');
    assert.deepEqual(plain(items[0].images), ['img:a.jpg']);
    assert.deepEqual(plain(items[0].imagesFull), ['img:a-full.jpg']);
    assert.deepEqual(plain(items[1].images), []);
    assert.ok(items[0].id && items[1].id && items[0].id !== items[1].id, 'id が振られる');
  });

  await t.test('buildImportSection は buildImportItems と同じ結果を包む', () => {
    const steps = T.wizardStepsFrom({
      steps: [{ seq: 1, image: '001.png', zoomImage: null, zoomSource: null, text: '押す' }],
    });
    const sec = T.buildImportSection('録画 2026/07/25 09:14', steps, [[]]);
    assert.equal(sec.title, '録画 2026/07/25 09:14');
    assert.deepEqual(plain(sec.items).map((i) => i.text), ['押す']);
  });

  await t.test('insertItemsAt — 既存の手順を消さずに割り込む', () => {
    const mk = () => ({ id: 's', title: '', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const item = (id) => ({ id });

    let sec = mk();
    T.insertItemsAt(sec, 1, [item('x'), item('y')]);
    assert.deepEqual(plain(sec.items).map((i) => i.id), ['a', 'x', 'y', 'b', 'c'], '手順1の後へ');

    sec = mk();
    T.insertItemsAt(sec, 0, [item('x')]);
    assert.deepEqual(plain(sec.items).map((i) => i.id), ['x', 'a', 'b', 'c'], '先頭へ');

    sec = mk();
    T.insertItemsAt(sec, 3, [item('x')]);
    assert.deepEqual(plain(sec.items).map((i) => i.id), ['a', 'b', 'c', 'x'], '末尾へ');

    sec = mk();
    T.insertItemsAt(sec, 99, [item('x')]);
    assert.deepEqual(plain(sec.items).map((i) => i.id), ['a', 'b', 'c', 'x'], '超過は末尾へ丸める');

    sec = mk();
    T.insertItemsAt(sec, 1, []);
    assert.deepEqual(plain(sec.items).map((i) => i.id), ['a', 'b', 'c'], '空なら何もしない');

    assert.doesNotThrow(() => T.insertItemsAt(null, 0, [item('x')]), 'セクションが無くても落ちない');

    // 項目を持たないセクション（items 未定義）でも動く
    const bare = { id: 's', title: '' };
    T.insertItemsAt(bare, 0, [item('x')]);
    assert.deepEqual(plain(bare.items).map((i) => i.id), ['x']);
  });
});
