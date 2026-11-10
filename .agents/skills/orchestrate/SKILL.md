---
name: orchestrate
description: Trigger when asked to orchestrate, use subagents to execute a task, act as an orchestrator, or coordinate implementation across multiple subagents.
argument-hint: "<task, feature, or refactor to accomplish>"
---

# Orchestrate

Coordinate a feature, bugfix, refactor, or migration across subagents.

The orchestrator analyzes the scope, decides how to tackle the work, splits it into slices for subagents, runs runtime checks on the combined result, and audits the final diff. Subagents write the code and run local checks inside their assigned slices. This keeps the main context lean while the orchestrator focuses on design, integration, and verification.

## Guardrails

1. **Do not edit code during implementation.** Let subagents own all source changes while they run their slices.
2. **Keep updates brief.** Report task dispatches, test results, blockers, and status changes without repeating subagent diffs in chat.
3. **Do not poll.** Launch subagents and wait for the system to wake you when they report back.
4. **Do not finalize early.** Wait for the user to confirm before treating the task as done.

## Workflow

### 1. Analyze scope and approach

Read the affected files before delegating anything. Understand how the existing modules, data flow, and contracts fit together, and check any repository guidelines that apply. Decide what needs to change, which edge cases matter, and how to split the work cleanly. Do not generate a separate audit or planning document unless the user asks for one.

### 2. Divide the task and delegate

Break the work into slices and hand them to subagents with `invoke_subagent` using `Model: "flash"`.

- **Give each slice exclusive files.** Two subagents running at the same time must never touch the same file.
- **Pick parallel or sequential order from dependencies.** Run slices in parallel when their file sets and contracts are independent. Run them in sequence when one slice builds on types, exports, or behavior created by an earlier slice.
- **Scope each prompt tightly.** Tell the subagent what to build, which files it may edit, and which files are off-limits.
- **Require code verification.** Each subagent must prove its slice compiles and passes targeted syntax, type, or unit checks before reporting back with a short summary.

### 3. Verify at runtime

Once the subagents finish and pass their slice checks, verify the integrated changes yourself.

1. Run the project build, integration tests, or live runtime checks that exercise the new behavior end to end.
2. Probe edge cases, error paths, and state transitions across the boundaries between slices.
3. If a check fails, do not patch the implementation yourself. Send the exact error and reproduction details back to the responsible subagent, or launch a focused subagent to fix it and re-run its code checks, then repeat runtime verification.

### 4. Audit the diff

After runtime checks pass, inspect the working tree with `git diff` and `git status`.

1. Check that the changes match the initial scope and the planned approach.
2. Look for rule violations, unintended behavior changes, stray files, dead code, or leftover debug output.
3. **Surgical cleanup.** During this final audit only, you may make small direct edits such as deleting a stray file, fixing an import, or tidying a comment without spinning up another subagent. If a deeper logic issue turns up, delegate the fix back to a subagent and re-verify.
4. Present a concise summary of the verified changes and audit findings to the user.
