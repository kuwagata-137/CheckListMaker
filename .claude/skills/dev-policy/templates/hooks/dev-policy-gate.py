#!/usr/bin/env python3
"""PreToolUse ゲートフック（開発方針 領域3 の補助）。

PR の作成 / マージ / auto-merge 有効化（GitHub MCP ツール）を
ユーザー確認（permissionDecision=ask）に倒す。

このフックが見るのは上記の GitHub MCP ツール名だけ。
`main` 直 push の機械判定は意図的に含めない
（Bash コマンド文字列の正規表現マッチは誤爆・回避が多く設計が難しいため。
 main 直 push 禁止は CLAUDE.md の人間可読ルールで守る）。

設計方針:
  - fail-open。stdin の解析や判定で何が起きても、決して操作をブロックしない
    （例外時は何も出力せず exit 0 = 通常の許可フローに委ねる）。
"""
import json
import sys

PR_TOOLS = (
    "mcp__github__create_pull_request",
    "mcp__github__merge_pull_request",
    "mcp__github__enable_pr_auto_merge",
)


def main() -> None:
    data = json.loads(sys.stdin.read())
    if data.get("tool_name", "") in PR_TOOLS:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": (
                    "開発方針 領域3: PR の作成・マージは独断で行わない。"
                    "ユーザーの明示的な指示があるか確認してください。"
                ),
            }
        }))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # fail-open: 何があってもブロックしない
        sys.exit(0)
