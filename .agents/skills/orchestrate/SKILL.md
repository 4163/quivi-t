---
name: orchestrate
description: Trigger when asked to orchestrate, use subagents to execute a task, act as an orchestrator, or coordinate implementation across multiple subagents.
argument-hint: "<task, feature, or refactor to accomplish>"
---

# Orchestrate

Coordinate a feature, bugfix, refactor, or migration across subagents.

The orchestrator analyzes the scope, decides how to tackle the work, splits it into slices for subagents, runs runtime checks on the combined result, and audits the final diff. Subagents write the code and run local checks inside their assigned slices. This keeps the main context lean while the orchestrator focuses on design, integration, and verification.

## Guardrails

1. **Do not load the `swarm` skill.** Use `swarm` to spawn and check workers, and `post_message` to message them. Follow this workflow instead, and do not add `narrator`, `monitor`, or verifier workers.
2. **Do not edit code during implementation.** Let subagents own all source changes while they run their slices.
3. **Keep updates brief.** Report task dispatches, test results, blockers, and status changes without repeating subagent diffs in chat.
4. **Do not poll.** End the turn after dispatching work, or call `swarm_wait` instead of polling `read_board` in a loop.
5. **Do not kill finished workers.** Leave completed workers `waiting` on the board so they keep their slice context for follow-up fixes via `post_message`. Waiting workers cost nothing. Only call `swarm{action:"kill"}` if the user explicitly asks to shut down the swarm.

## Workflow

### 1. Analyze scope and approach

Read the affected files before delegating anything. Understand how the existing modules, data flow, and contracts fit together, and check any repository guidelines that apply. Decide what needs to change, which edge cases matter, and how to split the work cleanly. Do not generate a separate audit or planning document unless the user asks for one.

### 2. Divide the task and delegate

Break the work into slices and spawn workers with `swarm{action:"add", name, model, workspace:"inherit", brief}`. Default `model` to `"gemini-4-neon-medium"` unless the user specifies another model or reasoning level from `swarm{action:"models"}`.

- **Give each slice exclusive files.** Two workers running at the same time must never touch the same file.
- **Pick parallel or sequential order from dependencies.** Add independent slices together so they run in parallel. Add dependent slices only after the earlier slice reports `@coordinator [done]` on the board, or assign the follow-up to that worker with `post_message`.
- **Scope each brief tightly.** State what to build, which files the worker may edit, which files are off-limits, and that it must post `@coordinator [done]` with a short summary rather than `@all`.
- **Require code verification.** Each worker must prove its slice compiles and passes targeted syntax, type, or unit checks before reporting back.
- **Respect the first-turn board delay.** `post_message`, `read_board`, and `swarm_wait` appear on the turn after your first `swarm{action:"add"}`, while `add` delivers each `brief` immediately. End the first spawn turn instead of looking for board tools, then read results with `read_board` once workers post.

### 3. Verify at runtime

Once all slices finish and pass their local checks, verify the integrated changes yourself.

1. Run the project build, integration tests, or live runtime checks that exercise the new behavior end to end.
2. Probe edge cases, error paths, and state transitions across the boundaries between slices.
3. If a check fails, do not patch the implementation yourself. Send the exact error and reproduction details back to the responsible worker via `post_message` with `@<name>`, or add a focused worker, wait for it to fix and re-verify its code checks, then repeat runtime verification.

### 4. Audit the diff

After runtime checks pass, leave the slice workers `waiting` on the board and inspect the working tree with `git diff` and `git status`.

1. Check that the changes match the initial scope and the planned approach.
2. Look for rule violations, unintended behavior changes, stray files, dead code, or leftover debug output.
3. **Surgical cleanup.** During this final audit only, you may make small direct edits such as deleting a stray file, fixing an import, or tidying a comment without spinning up another worker. If a deeper logic issue turns up, message the responsible worker with `post_message` (`@<name>`) to fix it and re-verify.
4. Present a concise summary of the verified changes and audit findings to the user.
