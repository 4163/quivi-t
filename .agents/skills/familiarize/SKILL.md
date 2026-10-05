---
name: familiarize
description: Use at the very start of a session to familiarize yourself with this repository before proceeding with actual work.
argument-hint: "<low|docs|skim|surface|normal> [task to prepare for]"
---

# Familiarize

Three tiers control how deep you go. The user specifies the tier, or you infer it from the request. Default is normal.

## Tiers

### Low / docs

Read agent guidelines only. No codebase exploration.

- `.agents/AGENTS.md`
- `.agents/skills/unslop/SKILL.md`
- `.agents/architecture-state.md`
- `.agents/skills/blast-radius/SKILL.md`
- `.agents/skills/validate-changes/SKILL.md`
- `.agents/skills/verify-implementation/SKILL.md`
- `README.md`

Do not read source files, manifests, or directory trees.

### Skim / Surface

Read guidelines (everything in Low) plus a surface-level pass over the codebase. No deep dives.

- Walk the root directory tree and note the layout.
- Read manifests (`package.json`, `Cargo.toml`).
- Skim entry points and architecture docs, but do not open individual module files or trace call chains.

Do not use subagents.

### Normal

Everyday orientation. Rules plus layout plus who owns what.

- Build on the lower tiers. Docs holds the guidelines, skim holds the layout, manifests, and entry points.
- Read build/config files only as far as skim has not covered.
- Note the conventions in place: naming, folder layout, testing patterns, style. New work fits the codebase, not the other way around.
- Stop at module doors. Do not open module files to learn them and do not trace call chains or data flow. Depth beyond this is task-scoped and comes after handoff, through subagents.

## Subagents

If the harness supports subagents, delegate parts of the Normal tier to run in parallel (directory mapping, manifest reading, subsystem exploration). Have each subagent report a short summary, not raw output.

If the harness does not support subagents, do the work yourself. Never use any pseudo subagents skill as a substitute.
