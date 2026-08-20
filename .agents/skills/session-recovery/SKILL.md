---
name: session-recovery
description: Find relevant prior agent session context when resuming work, checking continuity, or adding verified session provenance.
argument-hint: "<session id, title, date, or resume context>"
disable-model-invocation: true
---

# Session recovery

Use this when the request is about prior sessions, such as resuming an interrupted task, finding a specific conversation, checking whether recent session notes match the current task, or adding a verified entry to the session index. Do not use it as a substitute for reading the current source.

Before reading old session data, check whether it is still relevant:

- Inspect the current working tree and recent commits first.
- Compare the candidate session date, branch/worktree hints, changed files, and summary against the active task.
- Skip the session if it predates newer unrelated commits or its summary does not match the current request.
- Treat recovered content as a lead. Verify code claims against the current source before acting on them.

All sessions for this project may be indexed at `.agents/session-index.md`. The index is a candidate list, not a source of truth. Its entries can be stale.

## Adding session entries

When adding sessions from other tools, insert new entries at the top of `.agents/session-index.md`, directly beneath the `# Session Index` heading, so the list remains newest first.

Every session ID, agent, model, and token count must come from the actual session store. Do not fabricate, guess, or copy values from another row. If a count cannot be retrieved, use `Tokens: N/A`.

Use this format:

```markdown
### `<id>` - <slug>
**Date:** YYYY-MM-DD | **Agent:** <agent> | **Model:** <model> | **Tokens:** <count>
**Summary:** <one paragraph describing what was done>
```

## Using the scripts

Instead of running raw SQL or PowerShell, use the provided Python scripts in `.agents/skills/session-recovery/scripts/`.

Each script supports `list`, `read <id>`, and `search <keyword>`. They output clean text and handle their own database paths.

| Tool | Harness / Source | Example |
| --- | --- | --- |
| `python scripts/opencode.py` | OpenCode DB | `python .agents/skills/session-recovery/scripts/opencode.py search "config"` |
| `python scripts/kilo.py` | Kilo DB | `python .agents/skills/session-recovery/scripts/kilo.py list` |
| `python scripts/antigravity.py` | AGY CLI and IDE DBs | `python .agents/skills/session-recovery/scripts/antigravity.py read <id>` |
| `python scripts/codex.py` | Codex JSONL | `python .agents/skills/session-recovery/scripts/codex.py search "bug"` |
| `python scripts/kiro.py` | Kiro IDE JSONL | `python .agents/skills/session-recovery/scripts/kiro.py list` |
| `python scripts/grok.py` | Grok CLI | `python .agents/skills/session-recovery/scripts/grok.py read <id>` |

## Session store paths

If a script fails or you need to run a broad `rg` search directly, these are the current store locations:

| Store | Location |
| --- | --- |
| OpenCode | `C:\Users\x4163\.local\share\opencode\opencode.db` |
| Kilo CLI | `C:\Users\x4163\.local\share\kilo\kilo.db` |
| Antigravity CLI | `C:\Users\x4163\.gemini\antigravity-cli\conversation_summaries.db` |
| Antigravity IDE | `C:\Users\x4163\.gemini\antigravity-ide\conversations\*.db` |
| Codex | `C:\Users\x4163\.codex\session_index.jsonl` |
| Kiro IDE | `C:\Users\x4163\.kiro\sessions\<workspace-hash>\<id>\messages.jsonl` |
| Grok CLI | `C:\Users\x4163\.grok\sessions\E%3A%5CProjects%5CQuiviT\<id>\chat_history.jsonl` |
