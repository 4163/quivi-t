---
name: verify-implementation
description: "Trigger when finishing a slice or when asked to 'verify'. Runs static checks, verifies config, and ports docs. Do not trigger validate-changes instead."
argument-hint: "<slice or change description>"
---

# Verify implementation

Prove a finished slice works before recording it as done. Run static checks, hand the user a manual runtime checklist, and only then update the books.

Read and follow `.agents/AGENTS.md` guidelines for all code and test output.

## Scope

Everything changed since the last clean state. `git diff "@{u}" --name-only` gives the file set, or a user-specified range.

## Workflow

### 1. Static checks

Run on every touched file:

- `node --check <file>` for each modified JS module.
- `cargo check` in `src-tauri`.

Stop and report failures. Do not proceed until they pass.

### 2. Config and portable-mode verification

If any change touches config-backed or persistent features:

- Verify the feature works under both global and portable-mode config paths.
- Confirm default values, persistence across restart, and schema compatibility with existing user config files.

Skip this step when the change has no config surface.

### 3. Manual runtime verification handoff

Produce a numbered checklist of things that genuinely require human eyes or interaction in the running application:

- UI rendering, layout, and visual correctness.
- User interaction flows (click, keyboard, drag, scroll).
- Cross-window behavior (preview, multi-instance).
- Theme, fullscreen, and window-state transitions.

Only include items relevant to the current change set. Do not pad with generic checks.

Each checklist item must be human-readable and self-contained so a tester with no prior context can follow it:

- Write as a concrete instruction: where to go, what to do, what to observe.
- State the expected result in plain language (what the tester should see happen).
- Do not assume the tester knows file names, function names, or internal implementation details; keep code references out of the checklist itself.
- Keep each item to 1–3 short sentences. Use plain verbs (Open, Click, Press, Observe, Confirm).

### 4. Documentation porting

Run only after steps 1–3 pass (checks green, user confirms manual checks or no blockers remain).

- Check `.agents/additions.md` for items completed in this slice. Port each completed item to `.agents/implemented.md`, preserving its description and any implementation notes worth keeping.
- For work not tracked in `additions.md` (ad-hoc fixes, refactors, user-requested changes), add a corresponding entry to `.agents/implemented.md` so the record stays complete.

Skip this step only when the slice is purely internal (skill edits, agent config, documentation-only changes with no app behavior).
