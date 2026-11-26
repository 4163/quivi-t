---
name: validate-changes
description: "Trigger only when asked to 'validate'. Runs a multi-agent consensus review against AGENTS.md, proposes agreed fixes, and optionally applies and re-verifies them."
argument-hint: "<target file, diff, commit range, branch, or working tree>"
---

# Validate changes

Run a multi-agent consensus review of code changes against `.agents/AGENTS.md`, checking for rule breaks, contract regressions, redundant logic, and stale references. Reviewers agree on both confirmed findings and exact resolution methods, then pause for approval before dedicated fixers apply and re-verify approved changes.

## Core constraints

- **No pre-decided splits or solutions.** Do not dictate in advance how the diff is partitioned, which models each role receives, or what technical fixes to pick. Every decision that benefits from multi-agent discussion happens live through the consensus stages below.
- **No code edits in Phase A.** Do not edit repository files during audit and consensus. Reviewers may run non-mutating commands such as `git diff`, `git log`, grep, typecheck, lint, or tests to prove findings. Do not leave temporary scripts or generated files behind.
- **Gate 1 before edits.** Present the Phase A report and wait for user approval before modifying code, unless the user explicitly asked to validate and fix up front.
- **Author and auditor separation.** `val-*` reviewers never edit repository files. Never reuse workers that authored the code under review as `val-*` reviewers.
- **Keep workers waiting.** Leave completed `val-*` and `fix-*` workers `waiting`, or resumable in subagent environments. Never kill workers unless the user explicitly asks to shut down the swarm.

## Execution backends

Use the highest available backend so the same consensus protocol runs across environments.

1. **Antigravity `swarm`.** When `swarm` is available, read `swarm_pane/SKILL.md` before briefing or adding the first workers when running in `/swarm`, then run `swarm{action:"models", all:true}` to inspect exact model identifiers. Spawn `val-*` and `fix-*` workers with `swarm{action:"add", workspace:"inherit"}` and run consensus live on the board.
2. **Harness-native agent teams.** When `swarm` is unavailable but the runtime provides native peer messaging or shared team coordination, such as Claude Code Agent Teams (`TeamCreate` and `SendMessage`), Codex multi-agent mailboxes (`spawn_agent` and `send_message`), or OpenCode swarm plugins, spin up fresh `val-*` teammates with command access for non-mutating checks and run consensus directly across peers. In Phase B, add disjoint-file `fix-*` teammates and route the post-fix diff back to the waiting `val-*` teammates for verification.
3. **Subagent spawning with coordinator relay.** When no shared board or peer-messaging team tool is available, but subagent spawning is available, run the same consensus protocol with the coordinator acting as message relay. Spawn fresh `val-*` subagents with command access for non-mutating verification, instructing them not to edit repository files. Run their independent passes in parallel, relay peer findings back to those same subagents for cross-verification voting, and relay up to 2 debate rounds on ties. In Phase B, spawn disjoint-file `fix-*` subagents and relay the post-fix diff back to the same `val-*` subagents for verification.
4. **Single-agent fallback.** When no multi-agent tool is available, or the user explicitly asks for a quick single-agent pass, run the review dimensions sequentially in one session. Follow with an explicit adversarial check that re-verifies every candidate's `file:line`, control flow, and callers against live code before keeping it.

## Model pool and tier baseline

When `swarm` is available, run `swarm{action:"models", all:true}` and restrict all spawned workers strictly to the Neon family (`High`, `Medium`, `Low`). Never spawn Hydrogen agents. Outside Antigravity, map `High`, `Medium`, and `Low` to the equivalent reasoning tiers of the active primary model family and ask the user to confirm the mapped pool before spawning workers. The coordinator stays on the model the user started the session with.

Agents decide exact worker counts and tiers through consensus, guided by this baseline:

- **`Medium` as default workhorse.** Use `Medium` for initial planning, standard `.agents/AGENTS.md`, contract, and blast-radius reviews, routine logic or boundary `fix-*` workers executing clear consensus specs, and standard post-fix verification.
- **`High` for targeted precision.** Reserve `High` for high-risk or ambiguous code paths such as concurrency and async lifecycles, streaming, memory, or backpressure paths, storage, quota, or transaction invariants, subtle cross-layer seams, multi-pass refactors, or complex `fix-*` patches where a small mistake breaks contracts. Never blanket-assign `High`. Consensus allocation must cite the specific touched files or invariants justifying the extra cost.
- **`Low` for bounded mechanical work.** Use `Low` only for deterministic, low-ambiguity work such as wide grep sweeps for unused imports, dead variables, or stale references, or `fix-*` workers applying purely mechanical `[Nit]` cleanups with an exact agreed diff. Never assign `Low` solo to architecture judgment, control-flow or state audits, or non-trivial logic fixes.
- **Minimum reasoning floor.** Every `[Blocking]` finding and every post-fix sign-off on a `[Blocking]` fix must include verification from at least a `Medium` or `High` reviewer.

## Unanimous consensus protocol

Consensus means agreement among all assigned reviewers in a group:

1. **No empty agreement.** Every participant casts `[Agree]`, `[Amend]`, or `[Block]` along with a brief verification note naming what it directly checked, such as `file:line`, traced callers, `.agents/AGENTS.md` rules, or command output. Bare agreement is invalid.
2. **Symmetric hard block on facts and safety.** A substantiated `[Block]` prevents an item from becoming `[Agreed]` when it proves either a false positive, such as an inaccurate `file:line`, misread control flow, or non-applicable rule, or an under-classified risk, such as a missed downstream caller, broken contract, or direct `.agents/AGENTS.md` violation. The group must fix, re-classify, or drop the item.
3. **Two-round escalation valve on judgment ties.** When reviewers agree on the facts and rules and only judgment differs, such as `[Warning]` vs. `[Nit]`, YAGNI vs. shared-helper extraction, or competing fix approaches, allow at most 2 structured debate rounds. If still deadlocked after round 2, submit a concise Escalation Brief with both positions to the coordinator to select and ratify.
4. **Outcome tags.** Every candidate resolves to `[Agreed]`, `[Dropped]`, or `[Escalated]`.

## Workflow

### Phase A: Audit and remediation consensus

1. **Scope the review.** Determine what to check and run `git diff --stat` to capture changed files and touched directories:
   - **File as an anchor.** Find where a slice began with `git log <upstream> --full-history --oneline -- "*<name>*"`, then inspect `git diff <commit>^..HEAD -- ":(exclude)*.md"`.
   - **Branch or commit range.** Run `git diff <range>` or `git diff <base>..HEAD`.
   - **Working tree.** Run `git diff` or `git diff --cached`.

2. **Charter and allocation consensus.** Bootstrap 2 `Medium` workers (`val-1`, `val-2`) with the diff summary, `.agents/AGENTS.md`, and the tier baseline. In one consensus pass, they unanimously agree on:
   - **Review topology.** Complementary lenses across the full diff for focused changes, or disjoint file and module splits with a mandatory cross-split seam check for large or multi-layer diffs.
   - **Roster and tiers.** Exact reviewer count and `High`, `Medium`, or `Low` tier per role, justified against the diff.

   Promote `val-1` and `val-2` directly into the agreed `Medium` reviewer roles instead of spawning duplicate `Medium` workers. Spawn only additional agreed slots, such as a `High` specialist or a `Low` mechanical sweep worker.

3. **Independent pass.** Each `val-*` reviewer reads `.agents/AGENTS.md` and inspects the diff and surrounding code independently before reading peer conclusions. Audit four dimensions:
   - **`.agents/AGENTS.md` compliance.** Cross-reference every rule, invariant, ownership boundary, and performance directive defined in `.agents/AGENTS.md` against the diff.
   - **Behavioral contracts and blast radius.** Check whether revisions altered function intent, return types, schemas, routes, or configs, or broke downstream callers.
   - **Redundant code and shared helpers.** Check for repeated inlined logic across callsites or missed existing helpers that already do the job.
   - **Stale code and references.** Check for unused imports or variables, dead functions, orphaned files, outdated comments, or stale paths and selectors using grep and caller checks.

   Every candidate finding must include exact `file:line`, severity, live proof, and a proposed resolution method:
   - `[Blocking]`: Direct `.agents/AGENTS.md` rule breaks, broken behavioral or interface contracts, altered intent, broken downstream callers, or regression risks.
   - `[Warning]`: Architectural drift, premature abstractions, duplicated logic across callsites, or hot-path allocations.
   - `[Nit]`: Dead code, unused imports or variables, stale comments, or minor hygiene issues.

4. **Cross-verification and resolution consensus.** Reviewers post candidates and verify each other's findings against live code using `[Agree]`, `[Amend]`, or `[Block]` with proof. They reach unanimous consensus on both confirmed findings and the exact agreed fix for each item. For split reviews, adjacent splits also run a cross-split seam check on shared interfaces, types, schemas, routes, or helpers.

5. **Synthesize the Phase A report and pause at Gate 1.** The coordinator compiles only `[Agreed]` and coordinator-resolved `[Escalated]` items into the `Validation report` below.
   - **No silent synthesis edits.** Do not add un-debated findings, alter agreed severities, or strip verified `file:line` evidence during synthesis. If the coordinator spots a missed issue while compiling the report, post it to the waiting `val-*` reviewers for verification first.
   - Pause at Gate 1 and ask the user which items to fix, unless the user explicitly requested validation and fixing up front.

### Phase B: Remediation and post-fix verification consensus

Run Phase B after user approval at Gate 1, or immediately if the user explicitly requested validation and fixing.

6. **Fixer allocation consensus.** Ask the waiting `val-*` reviewers to reach unanimous consensus on the Fixer Plan: number of dedicated `fix-*` workers, disjoint file ownership per worker, and `High`, `Medium`, or `Low` tier per worker against the tier baseline.

7. **Apply approved fixes.** Spawn the agreed disjoint-file `fix-*` workers briefed with their approved finding IDs, exact `file:line`, agreed resolution method, editable files, and off-limits files. Each fixer applies only the agreed changes, runs non-destructive local checks such as typecheck, lint, or targeted tests, and reports its applied changes and check results.

8. **Post-fix verification consensus.** Wake the waiting `val-*` reviewers with the post-fix `git diff` and check results. Reviewers verify against live code that every targeted finding is resolved and no new `.agents/AGENTS.md` violations or regressions were introduced, then cast unanimous `[Agree]` or `[Block]` with proof while preserving the `Medium` floor on `[Blocking]` fixes. Any substantiated `[Block]` returns to the waiting fixer that wrote the patch for an in-place fix and another verification pass until unanimous sign-off.

9. **Synthesize the Phase B report.** Leave all `val-*` and `fix-*` workers `waiting` and output the `Remediation report` below.

## Report templates

### Phase A: Validation report

```markdown
## Validation report

**Target:** (Working tree, staged changes, commit range, or branch)
**Review setup:** (swarm | agent teams | subagents | single-agent) | (roster, lenses or splits, and tiers) | (N dropped in cross-verification)
**Summary:** (1-2 sentences describing what the diff accomplishes)

### AGENTS.md violations
(If none, state "None".)
- `V1` [File:Line] [Blocking|Warning|Nit] Describe the violation, which AGENTS.md rule it breaks, and the verified proof.
  - **Agreed fix:** Consensus resolution method.

### Redundant code and shared helpers
(If none, state "None".)
- `V2` [File:Line] [Blocking|Warning|Nit] Describe the duplicated logic and verified callsites.
  - **Agreed fix:** Shared helper to reuse or extract.

### Stale code and references
(If none, state "None".)
- `V3` [File:Line] [Blocking|Warning|Nit] Describe the stale reference and grep or caller proof.
  - **Agreed fix:** Removal or updated reference.

### Escalations
(Include this section only if a round-2 tie-break occurred.)
- `E1` [File:Line] Summarize both positions and the coordinator decision.

### Verdict
(Pass / Pass with warnings / Fail)
(Gate 1: reply with `fix all`, `fix blocking`, specific IDs such as `V1, V3`, or `report only`.)
```

### Phase B: Remediation report

```markdown
## Remediation report

**Applied:** (Approved IDs fixed) | **Fixers:** (fixer roster and tiers)
**Checks:** (Non-mutating checks run and results)

### Verified fixes
- `V1` [File:Line] [Verified] Brief summary of the applied change and post-fix consensus proof.

### Deferred or unselected
- (Unselected findings from Gate 1, or "None".)

### Final verdict
(Pass / Pass with warnings / Fail, with unanimous post-fix sign-off from active `val-*` reviewers)
```
