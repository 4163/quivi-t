# Swarm upstream parity prompt

You are the coordinator for a `/swarm` upstream-parity session on branch `refactor/decoupling-and-perf`. Your job is to bring new commits from `main` onto this refactor branch cleanly while keeping the code, `.agents/major-refactor/audit-*.md`, `.agents/major-refactor/cross-split-seams.md`, `.agents/major-refactor/roadmap.md`, and `.agents/major-refactor/telemetry/comparisons.md` accurate and aligned with all three branch goals.

Read `.agents/skills/swarm_pane/SKILL.md` before briefing or adding the first workers, then run `swarm{action:"models", all:true}` to inspect exact model identifiers.

## Mission and boundaries

- **Delta-scoped code, audit, and roadmap parity.** Unlike the initial cold audit, this session updates live source code, tests, `.agents/major-refactor/audit-*.md`, `.agents/major-refactor/cross-split-seams.md`, `.agents/major-refactor/roadmap.md`, and `.agents/major-refactor/telemetry/comparisons.md` strictly for the blast radius of incoming commits from `main`.
- **No pre-decided splits or solutions.** Do not pre-assign which splits activate, worker counts, model-per-task splits, or technical porting designs before inspection. Every decision that benefits from multi-agent discussion must happen live through the consensus stages below.
- **Rule context for this session.** This `/swarm` session is explicitly an upstream-parity run. `orchestrate/SKILL.md` rules against loading `swarm` or writing planning docs do not apply here, and `AGENTS.md` restrictions against mid-implementation documentation or test-harness edits do not block updating `.agents/major-refactor/` or adding upstream regression tests. All `AGENTS.md` architecture rules, `.agents/skills/validate-changes/SKILL.md` criteria, `.agents/skills/blast-radius/SKILL.md` proof rules, and `.agents/skills/unslop/SKILL.md` writing rules apply in full.
- **No automated commits or pushes.** Never run `git commit` or `git push`. Leave the resolved merge cleanly staged for manual user commit. Keep `.agents/UPSTREAM_PARITY.md` and `.agents/PROMPT.md` intact.

## Pre-flight gate

Before spawning Stage 1 workers, the coordinator runs these checks alone:

1. **Clean working tree.** Confirm zero modified tracked files exist and no `[~]` unit has uncommitted production work in progress. If tracked files are dirty, stop immediately and ask the user to commit or stash first.
2. **Fresh upstream ref.** Run `git fetch origin` and determine the target upstream ref: default to `main` or `origin/main` whichever is newer, or use a specific commit SHA on `main` if the user named one to step through a large upstream wave in batches.
3. **Early exit on zero delta.** Run `git rev-list --count HEAD..<target>`. If the count is `0`, stop immediately and report that the branch is already at upstream parity.
4. **Read-only diff and conflict preview.** Without mutating the working tree or index, capture `git log --stat HEAD..<target>`, `git diff --stat HEAD...<target>`, and `git merge-tree --write-tree HEAD <target>` so Stage 1 planners see every incoming commit, changed file, and predicted conflict on a clean tree.

## Branch goals applied to upstream changes

Every incoming commit from `main` must preserve full upstream behavior while advancing all three canonical branch goals defined in [`.agents/PROMPT.md:L14-20`](PROMPT.md#L14-L20):

1. **Whole-app decoupling.** Audit and integrate every touched non-vendor file across `src/` and `src-tauri/src/`, small, medium, and large, plus manifests, capabilities, `build.rs`, and Explorer preview assets under `AGENTS.md` single-owner and YAGNI rules. Keep each window as one HTML entry document, allow splitting multi-surface CSS sheets by UI owner, and exclude `src/js/vendors/`.
2. **Thorough `validate-changes` code review.** Enforce single-writer DOM ownership, pure service boundaries, HTML-first rendering and node recycling, CSS source-of-truth and 3-tier scope rules, Rust facade encapsulation and `#[path]` test placement, shared helpers over duplication, and zero dead or stale code.
3. **Exhaustive UX and functional performance audit.** Proactively audit every frontend and functional UX surface touched or introduced by upstream changes, especially primary user flows such as image and archive loading, navigation swap latency, zoom/pan/rotate/fit, manga spread and manhwa continuous strip scrolling, WebGL filters and Lanczos scaling, GPU and VRAM lifecycles, file panel list and thumbnail scrolling, icon and thumbnail caching, URL gallery importing, drag-and-drop, startup and window sizing, Options and Metadata responsiveness, detached workspace sync, Explorer previews and thumbnails, and the Rust IPC, protocol, archive, and filesystem paths serving them. Actively look for concrete ways to make incoming upstream code noticeably faster and smoother beyond `validate-changes` basics, implementing those optimizations directly when porting into completed units or recording them as `[Agreed]` audit and roadmap items when landing in pending units.

## Completed vs pending unit discipline

Check current state markers in `.agents/major-refactor/roadmap.md` for every unit `U01` through `U11` touched by `<target>`:

- **Already-completed units, marked `[-]` or `[x]`.** Port upstream behavior cleanly into the refactored module boundaries under all three branch goals. Never re-introduce coupled code, `validate-changes` violations, or performance regressions into a finished unit. Expand the matching test or diagnostic suite to cover the new upstream behavior, re-run affected suites against the unit's prior `Telemetry B` baseline, and append a concise parity verification entry in `.agents/major-refactor/telemetry/comparisons.md` with JSON saved to `.agents/major-refactor/telemetry/parity-<short-sha>-<suite>.json`.
- **Pending units, marked `[ ]` or `[~]`.** Integrate the upstream code cleanly onto the pre-refactor files without prematurely executing the entire pending refactor unit. Audit the new or changed upstream code against all three branch goals, narrow or remove pending roadmap items that `main` already fixed or superseded, add new `[Agreed]` audit findings, roadmap items, and Telemetry A/B specs for any new debt or performance work introduced by `main`, and refresh **all** shifted `file:line` references across `audit-*.md` and `roadmap.md` for every modified pending file, not only lines inside the diff hunk.
- **Brand-new files or subsystems.** Assign every new file to an existing split `S01` through `S11` if it belongs there, or create a new split and execution unit such as `S12` and `U12` and update the Execution Unit DAG and parallel-safety matrix in `roadmap.md`.
- **Locked resolutions, seams, and upstream docs.** Protect Resolutions `R1` through `R7`, `cross-split-seams.md`, and `roadmap.md` Locked Contracts during every conflict resolution: never resurrect the removed dead IPCs from `R6`, revert explicit CSP from `R2`, re-introduce wildcard imports from `R7`, or break `R1` through `R5`. Preserve legitimate upstream updates to `README.md`, `.agents/architecture-state.md`, `.agents/skills/*`, lockfiles, and test fixtures cleanly without overwriting refactor-branch guardrails.

## Test and diagnostic suites

All regression, parity, and Telemetry A/B checks across Stages 1 through 5 refer to these four suites in the repository:

1. **Mocha frontend unit tests:** `npm run mocha`, running `mocha/*.test.js` across pure JS modules. Note that `package.json` defines `npm run mocha` and has no `npm test` script.
2. **WebdriverIO desktop E2E tests:** `npm run e2e` with optional `-- --spec <file>`, `--split`, or `--agent`, running feature specs `e2e/specs/01-startup.e2e.js` through `08-url-loader.e2e.js` against the live desktop binary.
3. **Replay diagnostics:** `npm run diagnose -- <scenario>` or `npm run replay -- <scenario>`, running `e2e/replay-diagnostics/` probes against recorded scenarios in `e2e/scenarios/` to inspect frame pacing, blackout frames, layout jumps, WebGL readiness, and IPC timing.
4. **Rust backend unit tests:** `cargo test --manifest-path src-tauri/Cargo.toml` with optional `<filter>`, running `src-tauri/src/tests/` and inline `#[cfg(test)]` modules in `src-tauri/src/`.

## Model pool

Restrict all spawned workers across Stages 1 through 5 strictly to these two models:

- `Gemini 4 Neon High`
- `Gemini 4 Neon Medium`

Do not use `Hydrogen` models for upstream-parity runs. Let Stage 2 consensus allocate `Neon High` vs `Neon Medium` per task, reserving `Neon High` for high-risk merge conflicts, completed-unit architectural ports, concurrency/GPU/state seams, roadmap synthesis, and final verification, and capping Stage 4 at 2 agents maximum.

## Unanimous consensus protocol

Consensus across Stages 1, 2, 3, and 5 means **agreement among all assigned agents** in that group:

1. **No empty agreement.** Every participant must cast an explicit vote of `[Agree]`, `[Amend]`, or `[Block]` along with a brief verification note naming what it directly checked, such as verified commits, `file:line` references, traced callers, locked contracts, or test output.
2. **Hard block on facts, parity, and safety.** While any agent holds a substantiated `[Block]` showing dropped upstream behavior, a regression, a broken resolution `R1` through `R7`, a wrong `file:line`, a missed caller, or an `AGENTS.md` violation, the item cannot pass until fixed.
3. **Two-round escalation valve on pure design ties.** When all agents agree on the facts and behavioral requirements, and competing solutions both satisfy `AGENTS.md` and performance goals, allow up to 2 structured debate rounds weighing concrete trade-offs. If still deadlocked after round 2, submit a concise Escalation Brief with both options to the coordinator to select one, then ratify and proceed.

## Git index and conflict safety

To eliminate parallel `.git/index.lock` collisions and broken merges:

1. Keep the working tree untouched throughout Stages 1 and 2 using read-only Git inspection and `git merge-tree --write-tree`.
2. Right after Stage 2 locks exclusive file ownership, the **coordinator alone** runs `git merge --no-commit --no-ff <target>` once.
3. Stage 3 workers edit only their exclusive assigned files and never run parallel `git add`, `git rm`, `git checkout`, or `git commit`.
4. For `modify/delete` conflicts where `main` edited a legacy file already split and deleted in a completed unit, the owning Stage 3 workers inspect `git diff <merge-base>..<target> -- <legacy-file>`, port the exact behavior cleanly into the refactored modules under all three goals, and list the legacy path for coordinator `git rm`.
5. After Stage 3 and Stage 4 finish, the **coordinator alone** stages all resolved paths and removals via `git add` and `git rm`, leaving untracked `.agents/UPSTREAM_PARITY.md`, `.agents/PROMPT.md`, and any pre-existing untracked files untouched, and confirms zero conflict markers and zero unmerged entries from `git diff --name-only --diff-filter=U`.

## Five-stage swarm workflow

Execute these five stages in order. Do not skip consensus gates.

### Stage 1: Upstream intake and impact charter consensus

Spawn a small planning group from the allowed model pool to inspect the pre-flight commit log, diff summary, `git merge-tree` conflict preview, current `roadmap.md` unit statuses, and `cross-split-seams.md`. Have them trace every incoming commit's behavioral intent, direct file touches, and transitive callers onto existing splits `S01` through `S11` and units `U01` through `U11`, classify each touched unit as completed vs pending, assign any brand-new files or propose a new split/unit if warranted, flag any affected `R1` through `R7` resolutions or Locked Contracts, and reach unanimous consensus on a written **Impact Charter** before Stage 2 begins.

### Stage 2: Delegation and ownership consensus

Keep the Stage 1 planners waiting on the board and have them debate and reach unanimous consensus on the **Delegation Matrix** covering only the splits and seams activated by the Impact Charter: worker count per active split, `Neon High` vs `Neon Medium` choice per worker, distinct lenses covering code porting/conflict resolution, 3-goal review, and blast-radius/telemetry verification, strict exclusive file ownership so no two concurrent workers edit the same file, and sequential ordering across shared hub files such as `lib.rs`, `models.rs`, `commands/mod.rs`, `platform/mod.rs`, `src/index.html`, `src/js/main/main.js`, and `src/css/global.css`.

### Stage 3: Code integration, delta audit, and solution consensus

After the coordinator runs `git merge --no-commit --no-ff <target>`, spawn Stage 3 workers according to the Delegation Matrix. Inside every active split, enforce this sequence:

1. **Analyze and design before editing.** Inspect every incoming commit hunk and conflict in the split's files, including `modify/delete` diffs on deleted legacy files. Agree on the porting or integration plan before editing complex seams.
2. **Integrate or port code.** Apply conflict resolutions and ports in assigned files only, enforcing completed-unit 3-goal parity or clean pending-unit integration, and verifying zero leftover conflict markers.
3. **Independent 3-goal delta review.** Peers independently review all integrated or ported upstream code for decoupling, `validate-changes` compliance, UX and functional performance bottlenecks, detached `?surface=fileList` parity, portable vs roaming config, and locked contracts across all four suites.
4. **Consensus on code, audit updates, and Telemetry A/B.** Reach unanimous consensus on the final code edits, any new or updated regression tests for completed units, updated or pruned audit findings, refreshed `file:line` citations for every modified pending file, and Telemetry A/B surface specs across one or multiple matching suites.
5. **Cross-split seam check.** Active splits post all changed shared helpers, IPCs, events, CSS hooks, HTML templates, and legacy file removals so adjacent splits unanimously confirm zero seam conflicts.
6. **Update split audits and clean up.** Update only the affected `.agents/major-refactor/audit-XX-*.md` files following `.agents/skills/unslop/SKILL.md`, and remove any temporary benchmark scripts or stray diagnostic reports. Keep Stage 3 workers `waiting` on the board for Stage 5.

### Stage 4: Roadmap sync, seams sync, and runtime verification

Use **at most 2 agents**, ideally fresh `Neon High` context, to:

1. **Update global refactor docs.** Update `.agents/major-refactor/roadmap.md` and `.agents/major-refactor/cross-split-seams.md` in place, keeping `roadmap.md` present-state-only: refresh all shifted `file:line` references in modified pending files, prune or adjust superseded pending items, insert new pending items and Telemetry A/B expansions for new upstream debt or performance work, update Locked Contracts and the Execution Unit DAG if changed, add a matching row to `.agents/roadmap-execution-playbook.md` if a brand-new execution unit such as `U12` is created, and keep the Audit Coverage Ledger 100% synced.
2. **Run build, syntax, and suite verification.** Run `node --check` on every modified JS file, `cargo check --tests --manifest-path src-tauri/Cargo.toml` if Rust files were touched, and every affected suite among the four suites listed above. If any check fails, route the failure back to the owning Stage 3 split to fix and re-verify.
3. **Record completed-unit parity telemetry.** For any completed unit touched by upstream, save post-parity JSON under `.agents/major-refactor/telemetry/parity-<short-sha>-<suite>.json` and record parity and regression results in `.agents/major-refactor/telemetry/comparisons.md`.

Before Stage 5 begins, the coordinator stages all resolved merge edits and legacy file removals via `git add` and `git rm`, keeping `.agents/UPSTREAM_PARITY.md`, `.agents/PROMPT.md`, and any pre-existing untracked files untouched.

### Stage 5: Final verification sign-off

Do not let Stage 3 or Stage 4 grade their own work alone. Combine **1 fresh `Neon High` Final Auditor** with the already-waiting **Stage 3 split workers** via board messages:

- **Stage 3 split workers** verify that every incoming upstream commit touching their split is faithfully preserved in live code, zero conflict markers remain, and every updated item in `audit-XX-*.md` and `roadmap.md` matches live `file:line` targets and symbols on disk.
- **The fresh `Neon High` Final Auditor** verifies 100% upstream commit accounting across `HEAD..<target>`, zero regressions against Resolutions `R1` through `R7` and `cross-split-seams.md`, 3-goal compliance on all completed-unit ports, complete and runnable Telemetry A/B targets for all new or updated pending items, zero unmerged index entries from `git diff --name-only --diff-filter=U`, green verification outputs across all executed suites, and `.agents/skills/unslop/SKILL.md` compliance on edited markdown docs.

Any substantiated `[Block]` returns to the owning Stage 3 or Stage 4 worker, followed by coordinator re-staging, until all active splits and the fresh Final Auditor sign off unanimously.

## Final handoff

Once Stage 5 reaches unanimous sign-off, the coordinator confirms zero unmerged index entries and zero stray temporary artifacts without running `git commit` or `git push`, and presents a concise summary covering:

- Integrated upstream commit range from `<target>`
- Code changes ported to completed units vs integrated into pending units
- Updates made to `audit-*.md`, `cross-split-seams.md`, `roadmap.md`, and `telemetry/comparisons.md`
- Executed test and diagnostic suite verdicts
- Any escalated trade-offs resolved and confirmation that the merge is staged and ready for manual commit
