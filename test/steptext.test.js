'use strict';
// steptext.js（UIA 解決結果 → 手順文のテンプレート生成 2-R2）の単体テスト。
// 純関数のため入出力の表を網羅的に検証する。文面は docs/spec-2-R2-uia-steptext.md の表。

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUia, stepText, cleanLabel } = require('../steptext');

// uia-host.js の返信を模した解決結果を作る
function raw(over = {}) {
  return {
    ok: true,
    name: '保存',
    controlType: 50000,
    controlTypeName: 'Button',
    localizedType: 'ボタン',
    className: 'NetUIRibbonButton',
    frameworkId: 'Win32',
    rect: [100, 200, 96, 32],
    windowTitle: '文書 1 - Word',
    appName: 'WINWORD.EXE',
    elapsedMs: 24,
    error: '',
    ...over,
  };
}
function textOf(over, opts = { button: 'left' }) {
  return stepText(normalizeUia(raw(over)), opts);
}

test('normalizeUia — 解決結果のサイドカー形式への正規化', async (t) => {
  await t.test('null（タイムアウト・子プロセス不在）は resolved:false の雛形', () => {
    const u = normalizeUia(null);
    assert.equal(u.resolved, false);
    assert.equal(u.name, null);
    assert.equal(u.controlType, null);
    assert.equal(u.rect, null);
    assert.equal(u.windowTitle, null);
    assert.equal(u.appName, null);
  });

  await t.test('ok:false でも Win32 系統のウィンドウ情報は保持する', () => {
    const u = normalizeUia({ ok: false, windowTitle: '業務システム', appName: 'mstsc.exe', elapsedMs: 5 });
    assert.equal(u.resolved, false);
    assert.equal(u.windowTitle, '業務システム');
    assert.equal(u.appName, 'mstsc.exe');
    assert.equal(u.elapsedMs, 5);
  });

  await t.test('ok:true は全項目をマップし controlType は名前文字列になる', () => {
    const u = normalizeUia(raw());
    assert.equal(u.resolved, true);
    assert.equal(u.name, '保存');
    assert.equal(u.controlType, 'Button');
    assert.equal(u.localizedType, 'ボタン');
    assert.equal(u.className, 'NetUIRibbonButton');
    assert.equal(u.frameworkId, 'Win32');
    assert.deepEqual(u.rect, [100, 200, 96, 32]);
    assert.equal(u.windowTitle, '文書 1 - Word');
    assert.equal(u.appName, 'WINWORD.EXE');
    assert.equal(u.elapsedMs, 24);
  });
});

test('stepText — 種類ごとのテンプレート文', async (t) => {
  await t.test('主要な ControlType の文面（ロードマップの表＋2-R0 の追加分）', () => {
    const cases = [
      ['Button', '「保存」ボタンをクリック'],
      ['SplitButton', '「保存」ボタンをクリック'],
      ['TabItem', '「保存」タブを選択'],
      ['MenuItem', 'メニューから「保存」を選択'],
      ['CheckBox', '「保存」にチェック'],
      ['RadioButton', '「保存」を選択'],
      ['ListItem', '「保存」を選択'],
      ['TreeItem', '「保存」を選択'],
      ['ComboBox', '「保存」を開く'],
      ['Edit', '「保存」欄をクリック'],
      ['Hyperlink', 'リンク「保存」をクリック'],
      ['Text', '「保存」をクリック'],
      ['Image', '「保存」をクリック'],
      ['Group', '「保存」をクリック'],
      ['Custom', '「保存」をクリック'],
    ];
    for (const [type, expected] of cases) {
      assert.equal(textOf({ controlTypeName: type }), expected, `ControlType=${type}`);
    }
  });

  await t.test('Excel のセル（DataItem＋セル番地）は「セル『B5』をクリック」', () => {
    const xl = { controlTypeName: 'DataItem', appName: 'EXCEL.EXE' };
    assert.equal(textOf({ ...xl, name: 'B5' }), 'セル「B5」をクリック');
    assert.equal(textOf({ ...xl, name: 'AB12' }), 'セル「AB12」をクリック');
    // Excel でも名前がセル番地形式でなければ通常の選択文
    assert.equal(textOf({ ...xl, name: '合計行' }), '「合計行」を選択');
    // Excel 以外の DataItem はセル扱いしない
    assert.equal(
      textOf({ controlTypeName: 'DataItem', name: 'B5', appName: 'ListApp.exe' }),
      '「B5」を選択'
    );
  });

  await t.test('右クリックは種類を問わず「◯◯」を右クリック', () => {
    assert.equal(textOf({}, { button: 'right' }), '「保存」を右クリック');
    assert.equal(textOf({ controlTypeName: 'ListItem', name: 'ファイルA' }, { button: 'right' }),
      '「ファイルA」を右クリック');
  });
});

test('stepText — フォールバック文（前提10・RemoteApp 主系統）', async (t) => {
  await t.test('解決なしはウィンドウタイトル付きフォールバック', () => {
    const u = normalizeUia({ ok: false, windowTitle: '受注入力 - 業務システム', appName: 'mstsc.exe' });
    assert.equal(stepText(u, { button: 'left' }), 'ウィンドウ「受注入力 - 業務システム」内の図の位置をクリック');
    assert.equal(stepText(u, { button: 'right' }), 'ウィンドウ「受注入力 - 業務システム」内の図の位置を右クリック');
  });

  await t.test('ウィンドウタイトルも無ければ「図の位置をクリック」', () => {
    assert.equal(stepText(normalizeUia(null), { button: 'left' }), '図の位置をクリック');
    assert.equal(stepText(normalizeUia(null), { button: 'right' }), '図の位置を右クリック');
  });

  await t.test('コンテナ系（Window/Pane/Document/TitleBar）は名前があってもフォールバック', () => {
    for (const type of ['Window', 'Pane', 'Document', 'TitleBar']) {
      assert.equal(
        textOf({ controlTypeName: type, name: '受注入力', windowTitle: '受注入力' }),
        'ウィンドウ「受注入力」内の図の位置をクリック',
        `ControlType=${type}`
      );
    }
  });

  await t.test('解決できても名前が空ならフォールバック', () => {
    assert.equal(textOf({ name: '' }), 'ウィンドウ「文書 1 - Word」内の図の位置をクリック');
    assert.equal(textOf({ name: '   ' }), 'ウィンドウ「文書 1 - Word」内の図の位置をクリック');
  });
});

test('cleanLabel — 名前の正規化', async (t) => {
  await t.test('改行・連続空白は1つに・前後はトリム', () => {
    assert.equal(cleanLabel('  保存\n して閉じる  '), '保存 して閉じる');
  });
  await t.test('40字を超えたら「…」省略', () => {
    const long = 'あ'.repeat(50);
    const out = cleanLabel(long);
    assert.equal(out.length, 41);
    assert.ok(out.endsWith('…'));
  });
  await t.test('null/undefined は空文字', () => {
    assert.equal(cleanLabel(null), '');
    assert.equal(cleanLabel(undefined), '');
  });
  await t.test('文生成でも省略後の名前が使われる', () => {
    const name = 'とても長いボタンの名前'.repeat(5); // 55字
    const t1 = textOf({ name });
    assert.ok(t1.startsWith('「とても長いボタンの名前'));
    assert.ok(t1.includes('…」ボタンをクリック'));
  });
});

// ── 2-R2b: 操作種類の拡張（ダブルクリック・入力・キー・ドラッグ）──────
const { dblClickText, inputText, keyStepText, dragText } = require('../steptext');

test('dblClickText — ダブルクリック文（2-R2b ①）', async (t) => {
  await t.test('名前ありは種類を問わず「◯◯をダブルクリック」', () => {
    assert.equal(dblClickText(normalizeUia(raw())), '「保存」をダブルクリック');
    assert.equal(
      dblClickText(normalizeUia(raw({ name: 'report.xlsx', controlType: 50007, controlTypeName: 'ListItem' }))),
      '「report.xlsx」をダブルクリック'
    );
  });
  await t.test('Excel のセル番地はセル特化文', () => {
    assert.equal(
      dblClickText(normalizeUia(raw({ name: 'B5', controlType: 50029, controlTypeName: 'DataItem', appName: 'EXCEL.EXE' }))),
      'セル「B5」をダブルクリック'
    );
  });
  await t.test('解決なし・コンテナ止まりはフォールバック文', () => {
    assert.equal(
      dblClickText(normalizeUia({ ok: false, windowTitle: '業務システム' })),
      'ウィンドウ「業務システム」内の図の位置をダブルクリック'
    );
    assert.equal(
      dblClickText(normalizeUia(raw({ controlType: 50033, controlTypeName: 'Pane', name: '業務システム' }))),
      'ウィンドウ「文書 1 - Word」内の図の位置をダブルクリック'
    );
    assert.equal(dblClickText(normalizeUia(null)), '図の位置をダブルクリック');
  });
});

test('inputText — 文字入力文（2-R2b ②）', async (t) => {
  await t.test('フォーカス要素の名前があれば「◯◯欄に入力」', () => {
    const u = normalizeUia(raw({ name: 'ファイル名', controlType: 50004, controlTypeName: 'Edit' }));
    assert.equal(inputText(u), '「ファイル名」欄に入力');
    assert.equal(inputText(u, { enter: true }), '「ファイル名」欄に入力して Enter');
  });
  await t.test('Document は入力対象として名前を使う（メモ帳・Word 本文）', () => {
    const u = normalizeUia(raw({ name: 'テキスト エディター', controlType: 50030, controlTypeName: 'Document' }));
    assert.equal(inputText(u), '「テキスト エディター」欄に入力');
  });
  await t.test('Window/Pane 止まり・解決なしはウィンドウ名のフォールバック', () => {
    const u = normalizeUia(raw({ controlType: 50033, controlTypeName: 'Pane' }));
    assert.equal(inputText(u), 'ウィンドウ「文書 1 - Word」内で文字を入力');
    assert.equal(
      inputText(normalizeUia({ ok: false, windowTitle: 'メモ帳' }), { enter: true }),
      'ウィンドウ「メモ帳」内で文字を入力して Enter'
    );
    assert.equal(inputText(normalizeUia(null)), '文字を入力');
  });
});

test('keyStepText — キー操作文（2-R2b ③）', async (t) => {
  await t.test('既知のショートカットは操作名で言い切る', () => {
    assert.equal(keyStepText('Ctrl+S'), 'Ctrl+S で保存');
    assert.equal(keyStepText('Ctrl+V'), 'Ctrl+V で貼り付け');
    assert.equal(keyStepText('Alt+F4'), 'Alt+F4 でウィンドウを閉じる');
    assert.equal(keyStepText('Alt+Tab'), 'Alt+Tab でアプリを切り替え');
    assert.equal(keyStepText('F5'), 'F5 で更新');
  });
  await t.test('未知のコンボ・単独 Enter は「キーを押す」', () => {
    assert.equal(keyStepText('Ctrl+Shift+K'), 'Ctrl+Shift+K キーを押す');
    assert.equal(keyStepText('Enter'), 'Enter キーを押す');
  });
});

test('dragText — ドラッグ文（2-R2b ④）', async (t) => {
  const named = (name) => normalizeUia(raw({ name }));
  const unresolved = normalizeUia({ ok: false, windowTitle: 'エクスプローラー' });
  await t.test('両端の名前が取れれば「AからBへドラッグ」', () => {
    assert.equal(dragText(named('report.xlsx'), named('ごみ箱')), '「report.xlsx」から「ごみ箱」へドラッグ');
  });
  await t.test('片側フォールバックは図の始点/終点で補う', () => {
    assert.equal(dragText(named('report.xlsx'), unresolved), '「report.xlsx」から図の終点位置へドラッグ');
    assert.equal(dragText(unresolved, named('ごみ箱')), '図の始点位置から「ごみ箱」へドラッグ');
  });
  await t.test('両側フォールバックは始点のウィンドウ名で包む', () => {
    assert.equal(dragText(unresolved, unresolved), 'ウィンドウ「エクスプローラー」内の図の始点から終点へドラッグ');
    assert.equal(dragText(normalizeUia(null), normalizeUia(null)), '図の始点から終点へドラッグ');
  });
});
