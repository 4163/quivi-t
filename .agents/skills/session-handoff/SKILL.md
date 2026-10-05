---
name: session-handoff
description: Use when the user explicitly asks to hand off current work for another agent or harness to continue.
argument-hint: "<current task, branch, or handoff context>"
---

# Session handoff

Use this only when the user explicitly asks to hand off current work for another agent or harness to continue.

This writes a task-first entry to `.agents/session-index.md` and gives the user a one-sentence copy/paste message for the next agent. The next agent picks up from the entry plus the working tree.

## Handoff entry

Before writing:

- inspect the current working tree and relevant diffs
- never fabricate data; use `N/A` when a value is unknown
- create `.agents/session-index.md` with a generic header if it does not exist yet.

Insert the entry directly beneath the `# Session index` heading, so the list remains newest first. Separate entries with `---` for readability.

Follow this entry shape. Write for the next agent or harness first and users second:

```markdown
### `<id>` - <slug>
**Date:** YYYY-MM-DD | **Agent:** <agent> | **Model:** <model> | **Tokens:** <count>
**Summary:** <concise human-readable summary>
- **What is being worked on:** ...
- **Files changed or intended to change:** ...
- **Technical details, scripts, commands, and tool failures that matter for continuation:** ...
- **Encountered issues, scope corrections, and intentional decisions:** ...
- **Verification already run and verification still missing:** ...
- **Exact next actions:** ...
```

Treat prior entries as a lead, not proof. Verify claims against the current source before writing them.

## Using the scripts

Instead of running raw SQL or PowerShell, use the provided Python scripts in `.agents/skills/session-handoff/scripts/`.

Each script supports `list`, `read <id>`, and `search <keyword>`. They output clean text and handle their own database paths.

| Tool | Harness / Source | Example |
| --- | --- | --- |
| `python scripts/opencode.py` | OpenCode DB | `python .agents/skills/session-handoff/scripts/opencode.py search "config"` |
| `python scripts/kilo.py` | Kilo DB | `python .agents/skills/session-handoff/scripts/kilo.py list` |
| `python scripts/antigravity.py` | AGY CLI and IDE DBs | `python .agents/skills/session-handoff/scripts/antigravity.py read <id>` |
| `python scripts/codex.py` | Codex JSONL | `python .agents/skills/session-handoff/scripts/codex.py search "bug"` |
| `python scripts/kiro.py` | Kiro IDE JSONL | `python .agents/skills/session-handoff/scripts/kiro.py list` |
| `python scripts/grok.py` | Grok CLI | `python .agents/skills/session-handoff/scripts/grok.py read <id>` |

## Session store paths

If a script fails or you need to run a broad `rg` search directly, these are the current store locations:

| Store | Location |
| --- | --- |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Kilo CLI | `~/.local/share/kilo/kilo.db` |
| Antigravity CLI | `~/.gemini/antigravity-cli/conversation_summaries.db` |
| Antigravity IDE | `~/.gemini/antigravity-ide/conversations/*.db` |
| Codex | `~/.codex/session_index.jsonl` |
| Kiro IDE | `~/.kiro/sessions/<workspace-hash>/<id>/messages.jsonl` |
| Grok CLI | `~/.grok/sessions/<url-encoded cwd>/<id>/chat_history.jsonl` |

## User handoff message

After updating the index, end with a fenced code block containing exactly one concise sentence the user can paste into the next agent.

Use this shape as reference (not strict, thus change it up and keep it varied):

```text
Continue from session-index entry `<id>`, and continue planning and/or discussion.
```
