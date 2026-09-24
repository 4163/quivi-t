---
name: verify-implementation
description: "Trigger when finishing a slice or when asked to 'verify'. Runs static checks, verifies config, and ports docs. Do not trigger validate-changes instead."
argument-hint: "<slice or change description>"
---

# Verify implementation

Prove a finished slice works before recording it as done. Run static checks, hand the user a manual runtime checklist ('runtime list'), and only then update the books.

Read and follow `.agents/AGENTS.md` guidelines for all code and test output.

## Scope

Everything changed since the last clean state. `git diff "@{u}" --name-only` gives the file set, or a user-specified range.

## Workflow

### 1. Static checks & automated tests

Run on every touched file:

- `node --check <file>` for each modified JS module.
- `cargo check --tests --manifest-path src-tauri/Cargo.toml` if Rust files were touched.
- `npm test` to verify pure frontend unit tests and scenario/probe contract integrity.
- Run the nearest existing test that calls the changed code. Prefer a filtered `cargo test`, one mocha file, or one e2e spec over the full suite. Use `.agents/skills/blast-radius/SKILL.md` to decide what has to pass. Do not run the full test suite during slice iteration.
- Run the full suite (`cargo test --manifest-path src-tauri/Cargo.toml`) only when finishing a slice that touches core cross-cutting contracts (`lib.rs`, `models.rs`) or during final slice signoff.
- If `e2e/replay-diagnostics/investigation.js` is present, confirm whether it is an intentional multi-session investigation file or needs to be cleaned up.

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
- Keep each item to 1 to 3 short sentences. Use plain verbs (Open, Click, Press, Observe, Confirm).

### 4. Report and await user signoff

Do not declare the slice finished.

Stop here. Present the results of the static checks and the runtime list to the user. Wait for the user to explicitly confirm that the checks passed and that the slice is approved for finalization.
