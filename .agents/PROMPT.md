# Swarm audit and roadmap prompt

You are the coordinator for a `/swarm` audit, code review, performance investigation, and roadmap-generation session on branch `refactor/decoupling-and-perf`.

Read `.agents/skills/swarm_pane/SKILL.md` before briefing or adding the first workers, then run `swarm{action:"models", all:true}` to inspect exact model identifiers.

## Mission and boundaries

- **Audit and planning only.** Deliver verified audits and an execution roadmap under `.agents/major-refactor/`. Do not modify production code in `src/`, `src-tauri/`, `mocha/`, or `e2e/` as final output.
- **No pre-decided splits or solutions.** Do not dictate how splits are partitioned, which files go into which split, which models each split receives, or what technical refactorings to pick. Every decision that benefits from multi-agent discussion must happen live through the consensus stages below.
- **Rule context for this session.** This `/swarm` session is explicitly an audit and planning run. `orchestrate/SKILL.md` rules against loading `swarm` or writing planning docs do not apply here, and `AGENTS.md` restrictions against mid-implementation documentation edits do not block creating `.agents/major-refactor/` deliverables. All `AGENTS.md` architecture rules, `.agents/skills/validate-changes/SKILL.md` criteria, and `.agents/skills/unslop/SKILL.md` writing rules apply in full.
- **Clean tree guarantee.** Stage 3 workers may run tests, replay diagnostics, or temporary timing scripts to prove performance findings, but they must revert or delete every temporary script and generated report artifact before closing Stage 3. At session end, `git status` must show only `.agents/major-refactor/` artifacts and `.agents/PROMPT.md`. Do not run `git commit` or `git push`.

## Branch goals

The generated roadmap must drive three branch goals across current `refactor/decoupling-and-perf`:

1. **Whole-app decoupling.** Audit every non-vendor source file in `src/` and `src-tauri/src/`, small, medium, and large, plus `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, and the Explorer preview player assets. Separate mixed responsibilities, pure-vs-UI reach-in, foreign DOM writes, duplicated logic, and Rust domain-vs-IPC/platform coupling under `AGENTS.md` single-owner and YAGNI rules. Keep each window as one HTML entry document while auditing HTML for `<template>` pools, static placeholder markup, `<link>` ordering, and leaked markup or inline styles. Do not treat `AGENTS.md`'s single-sheet-per-page wording as blocking splitting multi-surface CSS sheets by UI owner. Explicitly mark already-clean files as cohesive so 100% of non-vendor files are accounted for. Exclude `src/js/vendors/`.
2. **Thorough `validate-changes` code review.** Inspect the full codebase against `.agents/AGENTS.md` and `.agents/skills/validate-changes/SKILL.md`: single-writer DOM ownership, pure service boundaries, HTML-first rendering and node recycling, CSS source-of-truth and 3-tier scope rules, Rust facade encapsulation and `#[path]` test placement, duplicated code, and dead or stale code and references.
3. **Exhaustive UX and functional performance audit.** Audit every frontend and functional UX surface, especially primary user flows such as image and archive loading, navigation swap latency, zoom/pan/rotate/fit, manga spread and manhwa continuous strip scrolling, WebGL filters and Lanczos scaling, GPU and VRAM lifecycles, file panel list and thumbnail scrolling, icon and thumbnail caching, URL gallery importing, drag-and-drop, startup and window sizing, Options and Metadata responsiveness, detached workspace sync, Explorer previews and thumbnails, and the Rust IPC, protocol, archive, and filesystem paths serving them. Look for concrete ways to make the app noticeably faster and smoother, beyond `validate-changes` basics.

## Test and diagnostic suites

All Telemetry A and B references across Stages 1 through 5 refer to these four suites in the repository:

1. **Mocha frontend unit tests:** `npm run mocha`, running `mocha/*.test.js` across pure JS modules. Note that `package.json` defines `npm run mocha` and has no `npm test` script.
2. **WebdriverIO desktop E2E tests:** `npm run e2e` with optional `-- --spec <file>`, `--split`, or `--agent`, running feature specs `e2e/specs/01-startup.e2e.js` through `08-url-loader.e2e.js` against the live desktop binary.
3. **Replay diagnostics:** `npm run diagnose -- <scenario>` or `npm run replay -- <scenario>`, running `e2e/replay-diagnostics/` probes against recorded scenarios in `e2e/scenarios/` to inspect frame pacing, blackout frames, layout jumps, WebGL readiness, and IPC timing.
4. **Rust backend unit tests:** `cargo test --manifest-path src-tauri/Cargo.toml` with optional `<filter>`, running `src-tauri/src/tests/` and inline `#[cfg(test)]` modules in `src-tauri/src/`.

## Model pool

Restrict all spawned workers across Stages 1 through 5 strictly to these three models:

- `Gemini 4 Neon High`
- `Gemini 4 Neon Medium`
- `Gemini 4 Hydrogen High`

Do not hardcode model-per-split assignments in advance. Let Stage 2 consensus allocate them per task, keeping `Neon High` concentrated on high-leverage synthesis, hardest systems/concurrency/GPU/state surfaces, tie-breaking, and final verification, and capping Stage 4 at 2 agents maximum.

## Unanimous consensus protocol

Consensus across Stages 1, 2, 3, and 5 means **agreement among all assigned agents** in that group:

1. **No empty agreement.** Every participant must cast an explicit vote of `[Agree]`, `[Amend]`, or `[Block]` along with a brief verification note naming what it directly checked, such as verified `file:line` references, traced callers, contracts, or command/timing output.
2. **Hard block on facts and safety.** While any agent holds a substantiated `[Block]` showing an inaccurate `file:line`, misread control flow, missed caller, broken contract, or `AGENTS.md` conflict, the item cannot become `[Agreed]`. The group must fix or drop it.
3. **Two-round escalation valve on pure design ties.** When all agents agree on the facts and problem, and competing solutions both satisfy `AGENTS.md` and performance goals, allow up to 2 structured debate rounds weighing concrete trade-offs. If still deadlocked after round 2, submit a concise Escalation Brief with both options to the coordinator to select one, then ratify and proceed.

## Five-stage swarm workflow

Execute these five stages in order. Do not skip consensus gates.

### Stage 1: Split charter consensus

Spawn a diverse group of planners from the allowed model pool to survey the live repository tree, file sizes, import/IPC boundaries, and existing test coverage across the four test and diagnostic suites listed above. Have the planners debate how to partition the 3 branch goals across splits with zero overlapping file ownership and zero blind spots, and reach unanimous consensus on a written **Split Charter** before Stage 2 begins.

### Stage 2: Delegation consensus

Keep the Stage 1 planners waiting on the board and have them debate and reach unanimous consensus on the **Delegation Matrix** for every split in the Split Charter: worker count per split, exact model choice from the three allowed models, distinct investigation lenses per worker so peers complement and challenge each other, cross-split boundary sync points, and whether Telemetry A and B test-surface mapping is owned inside each split's lenses or also backed by a dedicated cross-cutting test-surface reviewer.

### Stage 3: Split investigation, verification, and solution consensus

Spawn the Stage 3 workers according to the Delegation Matrix. Inside every split, enforce this sequence:

1. **Independent pass.** Each worker investigates its files independently before adopting a peer's conclusions. Workers are not limited to read-only inspection and may run `npm run mocha`, `cargo test`, `npm run diagnose`, or temporary timing scripts to ground performance claims in data.
2. **Cross-verification.** Peers verify each other's findings against live code: confirm exact `file:line` targets, trace callers and blast radius, check detached `?surface=fileList` parity, check portable vs roaming config, and verify locked contracts in `mocha/`, `e2e/`, `e2e/replay-diagnostics/`, IPC commands, and `quivit://` routes.
3. **Solution and Telemetry A/B consensus.** Debate candidate remediations and reach unanimous consensus on the confirmed findings, the chosen fix, and the **Telemetry A and B surface spec** for each `[Agreed]` item: which of the 4 suites apply using one or multiple suites across crossed layers, what existing tests or scenarios already cover it, what missing contract, edge-case, or timing assertions Telemetry A must add before refactoring, and what parity checks plus measurable performance or structural gains Telemetry B must prove. Mark each candidate `[Agreed]`, `[Dropped]`, or `[Escalated]`.
4. **Cross-split seam check.** Each split posts its proposed boundary changes, shared helpers, CSS token/sheet splits, HTML template additions, and IPC/session contract touches so adjacent splits unanimously confirm there are no conflicting extractions.
5. **Write split audits and clean up.** Each split writes its consensus findings and Telemetry A/B specs to `.agents/major-refactor/audit-<id>-<slug>.md` following `.agents/skills/unslop/SKILL.md`, and cleans up any temporary scripts or generated diagnostic/report files. Keep Stage 3 workers `waiting` on the board for Stage 5.

### Stage 4: Roadmap synthesis

Use **at most 2 agents**, ideally fresh `Neon High` context reading only the Stage 3 `[Agreed]` audit files, cross-split boundary map, `AGENTS.md`, and `.agents/skills/validate-changes/SKILL.md`, to write `.agents/major-refactor/roadmap.md` and initialize `.agents/major-refactor/telemetry/comparisons.md`.

Retain these roadmap conventions:
- **State markers:** `[ ]` pending, `[~]` in progress, `[-]` agent-verified complete, `[x]` user-verified complete, `[o]` deferred with mutual item links.
- **Present-state single-line checklist items:** Lead with `**#ID Scope**` plus exact `path:line -> target`, action and acceptance criteria, and `[Ref: audit-XX:L#]`. Keep history and session notes out of `roadmap.md`.
- **Per-unit Telemetry A/B and commit gates:** Structure execution units in whatever phase or slice layout fits the dependencies best, and lift `AGENTS.md`'s mid-implementation test-harness ban during refactor execution so tests can expand before production edits. Every unit starts with a **Telemetry A** step that expands appropriate test coverage, diagnostic probes, or scenarios against pre-refactor code, captures baseline JSON under `.agents/major-refactor/telemetry/` from one or multiple matching suites among `npm run mocha`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run e2e -- --spec <file>`, and `npm run diagnose -- <scenario>`, and pauses for commit before any production code changes. Every unit closes with a **Telemetry B** step that updates imports or adds invariant assertions for extracted seams, captures post-refactor JSON from the same suite or suites, compares results in `telemetry/comparisons.md` to confirm 1:1 UX/functional parity plus accepted performance or architectural improvements with zero regressions, and pauses for commit.
- **Locked contracts and coverage ledger:** Document locked diagnostic probes, E2E selectors, IPC commands, and `quivit://` routes, and include an Audit Coverage Ledger mapping every Stage 3 `[Agreed]` finding to its roadmap items.

### Stage 5: Final item-by-item verification

Do not let Stage 4 grade its own output alone. Combine **1 fresh `Neon High` Final Auditor** with the already-waiting **Stage 3 split workers** via board messages:

- **Stage 3 split workers** inspect every item in `roadmap.md` touching their split against live files: exact `file:line` references, symbol names, faithful capture of the Stage 3 consensus fix, and no missed callers.
- **The fresh `Neon High` Final Auditor** verifies 100% non-vendor file coverage across `src/` and `src-tauri/src/`, 100% mapping of Stage 3 `[Agreed]` findings into `roadmap.md`, zero un-audited filler items, sound execution-unit dependency order, disjoint files across parallel units, complete and runnable Telemetry A and B commands across the right combination of the 4 suites covering every item in each unit, and `.agents/skills/unslop/SKILL.md` compliance across all `.agents/major-refactor/*.md` files.

Any substantiated `[Block]` returns to the Stage 4 author for an in-place fix until all Stage 3 splits and the fresh Final Auditor sign off unanimously.

## Final handoff

Once Stage 5 reaches unanimous sign-off and `git status` confirms only `.agents/major-refactor/` and `.agents/PROMPT.md` are untracked or modified, present a concise summary of the generated audits, roadmap phases/slices, Stage 5 sign-off status, and any escalated trade-offs resolved during the run.
