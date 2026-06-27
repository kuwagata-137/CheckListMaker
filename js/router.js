// router.js — ハッシュベースの簡易ルーター。
//   #/            → ホーム（一覧）
//   #/c/<id>      → エディタ（指定チェックリスト）
//   #share=...    → 共有データ（io.js が解釈。ここでは share と判定して通知）

export function parseHash(hash = location.hash) {
  if (hash.startsWith('#share=')) return { name: 'share', raw: hash };
  const m = hash.match(/^#\/c\/(.+)$/);
  if (m) return { name: 'editor', id: m[1] };
  return { name: 'home' };
}

export function goHome() {
  location.hash = '#/';
}

export function goEditor(id) {
  location.hash = '#/c/' + id;
}

// onChange(route) をハッシュ変更と初回に呼ぶ。解除関数を返す。
export function startRouter(onChange) {
  const handler = () => onChange(parseHash());
  window.addEventListener('hashchange', handler);
  handler(); // 初回
  return () => window.removeEventListener('hashchange', handler);
}
