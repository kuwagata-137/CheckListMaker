// io.js — JSON のエクスポート/インポートと、URLリンク共有のエンコード/デコード。
// いずれもサーバ不要。共有はチェックリスト1件をURLの #share= に埋め込む。

// ---- JSON バックアップ（アプリ全体） ----

export function exportStateToFile(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `checklists-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function readStateFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.checklists)) {
          throw new Error('checklists 配列が見つかりません');
        }
        resolve(data);
      } catch (e) {
        reject(new Error('JSONの読み込みに失敗しました: ' + e.message));
      }
    };
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.readAsText(file);
  });
}

// ---- URL共有（チェックリスト1件） ----
// UTF-8 を安全に base64 化するため encodeURIComponent を経由する。

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// 共有時はサイズ目安を返し、長すぎる場合は呼び出し側がJSON共有を促せるようにする。
export function encodeShareLink(checklist) {
  const payload = utf8ToBase64(JSON.stringify(checklist));
  const base = location.origin + location.pathname;
  const url = `${base}#share=${payload}`;
  return { url, length: url.length };
}

// 現在のURLハッシュから共有データを取り出す（なければ null）。
export function readShareFromHash(hash = location.hash) {
  const m = hash.match(/[#&]share=([^&]+)/);
  if (!m) return null;
  try {
    const checklist = JSON.parse(base64ToUtf8(m[1]));
    if (!checklist || !Array.isArray(checklist.sections)) return null;
    return checklist;
  } catch (e) {
    console.warn('共有データの解析に失敗しました:', e);
    return null;
  }
}
