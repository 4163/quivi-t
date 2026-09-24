---
name: update-architecture-state
description: "Trigger when the user asks to explicitly update the architecture state tracking in .agents/architecture-state.md, AGENTS.md Architecture Rules, and the README.md Documentation section."
argument-hint: "<refactor or restructuring summary>"
---

# Update architecture state

Use this skill when explicitly requested by the user to update the architecture state after a refactor or system behavior change. This keeps the architectural map synced with the codebase.

Read and follow `.agents/skills/unslop/SKILL.md` for all written output.

## Scope

- `.agents/architecture-state.md`
- `.agents/AGENTS.md` section: `## Architecture rules`
- `README.md` sections: `## Documentation`, `## Stack`, and `## Project Structure`
- Git: working tree, recent commits, current branch, or a user-specified range

## Update guidelines

### README documentation
- Write what is current fact, not what changed. Never turn documentation into a changelog, migration narrative, or slice history.
- Keep user-facing sections concise. Explain what the user needs to know to use the app. Deep contracts, schemas, and contributor guides belong in dedicated documents (such as `.agents/architecture-state.md` or branch READMEs).
- Keep `## Stack` grouped by functional layer and update it whenever dependencies or core technologies change.
- Keep `## Project Structure` matched to the actual filesystem at equal expansion depth between frontend and backend.

### AGENTS.md architecture rules
- Update an architecture rule only when the layering, ownership, or boundary contract itself actually changes.
- Rewrite the stale bullet directly. Do not append slice history, "we now...", or redundant clarifications that restate existing rules.

### Architecture state
- `.agents/architecture-state.md` is a structural map of the codebase, not a feature list.
- Keep entries present-tense, concise, and grouped by layer. Prefer replacing a stale line over adding a clarifying paragraph.

## Instructions

1. **Analyze:** Map the code changes to the affected architectural surfaces.
2. **Surgical updates:** Edit only the specific lines, lists, or bullets that govern the modified surface. Do not rewrite surrounding stable documentation.
3. **Verify structure and stack:** If files or dependencies were added, moved, or deleted, update `README.md` (`## Stack` and `## Project Structure`).
4. **Update rules:** If layering or ownership changed, update the matching lines in `.agents/AGENTS.md`.
5. **Update module map:** Record structural additions or shifted boundaries in `.agents/architecture-state.md`.
