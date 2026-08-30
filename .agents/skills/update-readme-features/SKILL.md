---
name: update-readme-features
description: "Trigger when the user asks to explicitly update the user-facing feature lists and shortcuts in the top sections of the README."
argument-hint: "<new feature or modified behavior>"
---

# Update README features

Run this skill when explicitly requested by the user to update the user-facing feature lists and shortcut tables after a new feature is added or existing behavior is modified.

Read and apply `.agents/skills/unslop/SKILL.md` to all edits. Keep the writing concise, factual, and aligned with the existing documentation style.

## Scope

- `README.md` sections: `## Features`, `## Shortcuts & Controls`, `## Custom CSS`, `## Attributions`.
- Git: working tree, recent commits, current branch, or a user-specified range.

## Instructions

1. **Analyze:** Identify the exact user-facing changes made during the feature slice (e.g., a new keybind, a new file format supported, a new setting).
2. **Surgical Updates:** Do not rewrite or restructure the sections completely UNLESS a new feature requires a restructure or new section. Ask/discuss with the user where warranted. Otherwise, only add, modify, or remove the exact bullet points and table rows relevant to the feature change.
3. **Format Constraints:** Preserve the existing Markdown table formatting for `Shortcuts & Controls` (ensure columns align correctly and keyboard inputs are wrapped in backticks, e.g., `Ctrl+Shift+A`).
