---
name: session-recovery
description: Trigger when the user asks to pick up a handed-off task from another agent or harness.
argument-hint: "<session id, title, date, or handoff context>"
---

# Session recovery

Use this when the user asks to pick up a handed-off task and names the index entry.

Read that entry from `.agents/session-index.md` and continue from its exact next actions. Treat the entry as a lead and verify code claims against the current source before acting on them.

## Continuation discipline

When picking up a handoff entry that lists "exact next actions", the receiving agent must follow this order:

1. Familiarize at docs level first.
2. Select the next candidate items from the roadmap or task list referenced in the handoff.
3. Report the selected items to the user and wait for approval before starting thorough planning, deep research, or implementation.

Do not jump into context gathering, implementation planning, or code changes before the user confirms the selected items.
