#!/usr/bin/env python3
"""PreToolUse ゲートフック（開発方針 領域3 の機械的強制）。

次の操作をユーザー確認（permissionDecision=ask）に倒す:
  - `main` への直接 push
  - リモートブランチ削除の push（この環境では 403 になるので早めに気づかせる）
  - PR の作成 / マージ / auto-merge 有効化（GitHub MCP ツール）

設計方針:
  - fail-open。stdin の解析や判定で何が起きても、決して操作をブロックしない
    （例外時は何も出力せず exit 0 = 通常の許可フローに委ねる）。セッションを
    ブリックさせないことを最優先する。
"""
import json
import re
import sys


def _decide(decision: str, reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def ask(reason: str) -> None:
    """ユーザー確認を要求して終了する（指示があれば通せる操作向け）。"""
    _decide("ask", reason)


def deny(reason: str) -> None:
    """操作をハード遮断して終了する（そもそも行ってはいけない操作向け）。"""
    _decide("deny", reason)


def main() -> None:
    raw = sys.stdin.read()
    data = json.loads(raw)
    tool = data.get("tool_name", "")
    ti = data.get("tool_input", {}) or {}

    # --- GitHub MCP: PR 作成 / マージ / auto-merge ---
    if tool in (
        "mcp__github__create_pull_request",
        "mcp__github__merge_pull_request",
        "mcp__github__enable_pr_auto_merge",
    ):
        ask("開発方針 領域3: PR の作成・マージは独断で行わない。"
            "ユーザーの明示的な指示があるか確認してください。")

    # --- Bash: main 直 push / リモートブランチ削除 ---
    if tool == "Bash":
        cmd = ti.get("command", "") or ""
        # git push を含む部分だけを対象にする
        if re.search(r"\bgit\s+push\b", cmd):
            # main への push（refspec として main を「独立した ref」で指している場合のみ）。
            # ブランチ名に main を含むだけ（例: claude/main-fix）は誤検知しないようにする。
            if re.search(
                r"\bgit\s+push\b[^|;&\n]*?(?:"
                r"(?<![\w/:-])main(?![\w/-])"   # 単独トークンの main
                r"|HEAD:main(?![\w/-])"          # HEAD:main
                r"|:main(?![\w/-])"              # <src>:main
                r"|refs/heads/main(?![\w/-])"    # refs/heads/main
                r")",
                cmd,
            ):
                deny("開発方針 領域3: `main` への直接 push は禁止。"
                     "main へ入れるのは『ユーザーが PR をマージする』経路のみ。"
                     "作業ブランチへ push し、PR 化はユーザーに任せること。")
            # ブランチ削除の push
            if re.search(r"\bgit\s+push\b[^|;&\n]*"
                         r"(\s--delete\b|\s-d\b|\borigin\s+:)", cmd):
                ask("開発方針 領域6: この環境ではリモートブランチを削除できない"
                    "（403）。削除は GitHub Web UI でユーザーに依頼してください。")

    # それ以外は何もしない（通常フロー）。
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # fail-open: 何があってもブロックしない
        sys.exit(0)
