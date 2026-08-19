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

All sessions for this project may be indexed at `references/session-index.md`. The index is a candidate list, not a source of truth. Its entries can be stale.

## Adding session entries

When adding sessions from other tools, insert new entries at the top of `references/session-index.md`, directly beneath the `# Session Index` heading, so the list remains newest first.

Every session ID, agent, model, and token count must come from the actual session store. Do not fabricate, guess, or copy values from another row. If a count cannot be retrieved, use `Tokens: N/A`.

Use this format:

```markdown
### `<id>` - <slug>
**Date:** YYYY-MM-DD | **Agent:** <agent> | **Model:** <model> | **Tokens:** <count>
**Summary:** <one paragraph describing what was done>
```

## Session stores

OpenCode sessions are stored in:

```text
C:\Users\x4163\.local\share\opencode\opencode.db
```

Antigravity CLI conversations are stored in:

```text
C:\Users\x4163\.gemini\antigravity-cli\conversations\<conversation-id>.db
C:\Users\x4163\.gemini\antigravity-cli\brain\<conversation-id>\.system_generated\logs\transcript.jsonl
C:\Users\x4163\.gemini\antigravity-cli\brain\<conversation-id>\.system_generated\logs\transcript_full.jsonl
C:\Users\x4163\.gemini\antigravity-cli\conversation_summaries.db
```

Antigravity IDE sessions are stored in:

```text
C:\Users\x4163\.gemini\antigravity-ide\conversations\*.db
```

Kilo CLI sessions are stored in:

```text
C:\Users\x4163\.local\share\kilo\kilo.db
```

Codex sessions are stored in:

```text
C:\Users\x4163\.codex\sessions\YYYY\MM\DD\rollout-<timestamp>-<thread-id>.jsonl
C:\Users\x4163\.codex\session_index.jsonl
C:\Users\x4163\.codex\archived_sessions\rollout-<timestamp>-<thread-id>.jsonl
```

Kiro IDE sessions are stored in:

```text
C:\Users\x4163\.kiro\sessions\<workspace-hash>\<session-id>\messages.jsonl
C:\Users\x4163\AppData\Roaming\Kiro\User\workspaceStorage\<workspace-hash>\state.vscdb
```

## Query patterns

Prefer `rg` for JSONL transcripts and small targeted SQLite queries for databases. Keep extraction narrow to the session, date, branch, or keyword required by the task.

OpenCode:

```python
import sqlite3

db = sqlite3.connect(r'C:\Users\x4163\.local\share\opencode\opencode.db')
rows = db.execute("""
    SELECT id, slug, title, time_created, time_updated, tokens_input + tokens_output
    FROM session WHERE directory LIKE ? ORDER BY time_updated DESC
""", ('E:/Projects/QuiviT%',)).fetchall()

msgs = db.execute("""
    SELECT m.time_created, m.data, p.data
    FROM message m
    LEFT JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ? ORDER BY m.time_created ASC
""", (session_id,)).fetchall()
```

Antigravity CLI:

```python
import sqlite3

summaries_db = sqlite3.connect(r'C:\Users\x4163\.gemini\antigravity-cli\conversation_summaries.db')
rows = summaries_db.execute("""
    SELECT conversation_id, title, created_at, last_modified_at
    FROM conversation_summaries
    ORDER BY last_modified_at DESC
""").fetchall()

conv_db = sqlite3.connect(
    r'C:\Users\x4163\.gemini\antigravity-cli\conversations\<conversation-id>.db'
)
steps = conv_db.execute("""
    SELECT step_index, source, type, status, content
    FROM steps ORDER BY step_index ASC
""").fetchall()
```

Antigravity CLI JSONL:

```powershell
rg -n "keyword" C:\Users\x4163\.gemini\antigravity-cli\brain\*\.system_generated\logs\transcript.jsonl
Get-Content "C:\Users\x4163\.gemini\antigravity-cli\brain\<conversation-id>\.system_generated\logs\transcript.jsonl"
```

Antigravity IDE:

```python
import sqlite3

db = sqlite3.connect(r'C:\Users\x4163\.gemini\antigravity-ide\conversations\<conversation-id>.db')
rows = db.execute("""
    SELECT idx, step_type, status, step_payload
    FROM steps ORDER BY idx ASC
""").fetchall()
```

Kilo CLI:

```python
import sqlite3

db = sqlite3.connect(r'C:\Users\x4163\.local\share\kilo\kilo.db')
rows = db.execute("""
    SELECT id, title, time_created, time_updated, tokens_input + tokens_output as total_tokens
    FROM session WHERE directory LIKE ? ORDER BY time_updated DESC
""", ('%QuiviT%',)).fetchall()

msgs = db.execute("""
    SELECT m.time_created, json_extract(m.data, '$.role') as role, json_extract(p.data, '$.text')
    FROM message m
    LEFT JOIN part p ON p.message_id = m.id AND json_extract(p.data, '$.type') = 'text'
    WHERE m.session_id = ? ORDER BY m.time_created ASC
""", (session_id,)).fetchall()
```

Codex:

```powershell
Get-Content C:\Users\x4163\.codex\session_index.jsonl
rg -n "<thread-id>|<title>|<keyword>" C:\Users\x4163\.codex\sessions C:\Users\x4163\.codex\archived_sessions
```

Kiro:

```python
import json
import sqlite3

db = sqlite3.connect(
    r'C:\Users\x4163\AppData\Roaming\Kiro\User\workspaceStorage\<workspace-hash>\state.vscdb'
)
kiro_data = db.execute(
    "SELECT value FROM ItemTable WHERE key = 'kiro.kiroAgent'"
).fetchone()
if kiro_data:
    data = json.loads(kiro_data[0])
    sessions = data.get('sessionPanels', {}).get('entries', [])
    for s in sessions:
        print(f"ID: {s['id']}, Title: {s['title']}, Location: {s['location']}")
db.close()
```

```powershell
Get-ChildItem C:\Users\x4163\.kiro\sessions\<workspace-hash> -Directory
rg "search term" C:\Users\x4163\.kiro\sessions\<workspace-hash>\*\messages.jsonl
```
