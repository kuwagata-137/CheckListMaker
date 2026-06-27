---
name: dev-policy
description: 標準の開発方針（着手前の仕様確定、PR/マージはユーザー承認ゲート、main直push禁止、ブランチ衛生、外向き・不可逆操作の独断禁止）を現在のリポジトリへ展開・適用する。新しいリポジトリのセットアップ時や、別プロジェクトにもこの方針を効かせたいときに使う。`.claude/CLAUDE.md`・`.claude/settings.json`（PreToolUse フック）・`.claude/hooks/dev-policy-gate.py` をひな形から設置する。
---

# dev-policy — 開発方針を他のプロジェクトへ伝播させるスキル

このスキルは、合意済みの開発方針を**現在の作業リポジトリに展開**する。方針本体は
このスキルディレクトリの `templates/` に同梱してある（要約版ではなく完全版）。

## このスキルが設置するもの

| 設置先 | 内容 |
|--------|------|
| `.claude/CLAUDE.md` | 開発方針（MECE 8領域の完全版） |
| `.claude/settings.json` | PreToolUse フック登録（main直pushは遮断/deny・PR作成・PRマージは要確認/ask） |
| `.claude/hooks/dev-policy-gate.py` | 上記を機械的に強制する判定スクリプト（fail-open） |

## 手順

1. 対象リポジトリのルート（`.git` のある場所）にいることを確認する。
2. `.claude/` が無ければ作成する。
3. このスキルの `templates/` から各ファイルをコピーする:
   - `templates/CLAUDE.md` → `.claude/CLAUDE.md`
   - `templates/settings.json` → `.claude/settings.json`
   - `templates/hooks/dev-policy-gate.py` → `.claude/hooks/dev-policy-gate.py`
4. **既存ファイルがある場合は上書きせず、内容を統合（マージ）する**:
   - `.claude/CLAUDE.md` が既にあるなら、方針8領域の内容を追記・統合する（重複は避ける）。
   - `.claude/settings.json` が既にあるなら、`hooks.PreToolUse` 配列へ本フックの2エントリを
     追加する（既存の hooks を壊さない）。matcher は `Bash` と
     `mcp__github__create_pull_request|mcp__github__merge_pull_request|mcp__github__enable_pr_auto_merge`。
   - `dev-policy-gate.py` は同名があれば差分を確認してから反映する。
5. フックスクリプトに実行権限を付ける: `chmod +x .claude/hooks/dev-policy-gate.py`。
6. 動作確認（誤爆しないこと・fail-open であること）:
   ```bash
   H=.claude/hooks/dev-policy-gate.py
   printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git push -u origin main"}}' | python3 "$H"      # denyが出る
   printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git push -u origin feature/x"}}' | python3 "$H" # 何も出ない
   printf '%s' '{"tool_name":"mcp__github__create_pull_request","tool_input":{}}' | python3 "$H"             # askが出る
   printf '%s' 'broken-json' | python3 "$H"                                                                  # 何も出ない(fail-open)
   ```
7. 設置内容（どのファイルを作成／統合したか）をユーザーに報告する。

## 重要な前提（この方針自体に従う）

- **このスキルの実行（ファイル設置・コミット・push）はローカル／作業ブランチ内に留める。**
  方針 領域3 のとおり、**PR の作成・マージ・`main` への直接 push は行わない**——それらは
  ユーザーの明示的な指示を待つ。
- 設置後にコミットするかどうか、どのブランチに乗せるかはユーザーに確認する。
- `~/.claude/`（ユーザー全体メモリ／スキル）はローカルでは全プロジェクトに効くが、Web/リモート
  実行環境ではコンテナ再生成で消えるため、**確実に残すにはリポジトリ内（`.claude/`）に置く**。

## 方針の要点（詳細は templates/CLAUDE.md 参照）

1. 着手前: 方向性と仕様を先に確定（曖昧仕様のまま実装しない）
2. ローカル作業: 作業ブランチで進める／既存ブランチを再利用
3. 統合ゲート: PR 作成・マージ・main 反映はユーザー承認が必須
4. その他の外向き・不可逆操作: 独断禁止（履歴改変・外部送信・削除）
5. ブランチのライフサイクル: main に統合、不要ブランチは整理
6. 実行環境の制約: 環境によりリモートブランチ削除不可（UI で依頼）
7. コミュニケーション: 正直な報告・ミスを認める・理由を説明
8. 方針の維持と伝播: CLAUDE.md／settings フック／本スキルで横展開
