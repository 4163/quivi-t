# Roadmap execution playbook

## How to run

Start a fresh chat on `Gemini 4 Neon High`, run `/familiarize`, then run:

```text
/orchestrate @[.agents/roadmap-execution-playbook.md]
```

Optional overrides: add a unit, batch, or checkpoint fix target after the file, such as `U02`, `U01 batch 2`, or `fix U02`. With no arguments, the orchestrator automatically picks up the next unfinished pass from [roadmap.md](major-refactor/roadmap.md).

## Orchestrator procedure

1. **Detect the next single pass.** Read [roadmap.md](major-refactor/roadmap.md) sequentially from `U01` through the last active unit and pick the first unit with `[ ]` or `[~]` items unless the user named a unit. Run **only one pass per session**:
   - **Pass A, Telemetry A:** `#UXX-TA` is still `[ ]` or `[~]`.
   - **Pass B, Production batch:** `#UXX-TA` is `[-]` or `[x]` and one or more `#UXX-01`..`#UXX-NN` items are `[ ]` or `[~]`. Run only the next unfinished batch for the unit.
   - **Pass C, Telemetry B:** All production items in the unit are `[-]` or `[x]` and `#UXX-TB` is `[ ]` or `[~]`.
2. **Load only the active unit's context.** Before spawning any worker, check `git status --short`: if `roadmap.md` has `[~]` items, resume those `[~]` items on the dirty tree; if no `[~]` items exist and tracked files are dirty, stop and ask the user before spawning workers. Then read:
   - The active unit section and `Locked contracts` in [roadmap.md](major-refactor/roadmap.md)
   - The unit's Stage 3 audit file listed in the table below
   - Relevant `R1` through `R7` and `Sync A` through `F` rules in [cross-split-seams.md](major-refactor/cross-split-seams.md)
   - The unit's section in [comparisons.md](major-refactor/telemetry/comparisons.md)
3. **Execute the pass under `/orchestrate` rules.**
   - **Pass A, Telemetry A:** Spawn 1 worker to add the tests, `#[cfg(test)] #[path = ...]` test mounts, or diagnostic probe and scenario updates specified in `#UXX-TA`. Only `#[cfg(test)] #[path = ...]` mount lines are permitted in production `.rs` files during Pass A, with zero production logic edits. Orchestrator runs every `#UXX-TA` command using `npm run e2e -- --agent --spec <file>` only if an elevated shell is reported, writes structured summary JSON containing `command`, `passed`, `failed`, and `duration_ms` into `.agents/major-refactor/telemetry/uXX-baseline-<suite>.json` for `cargo`, `mocha`, and `e2e` runs, copies generated `e2e/replay-diagnostics/reports/` output to `.agents/major-refactor/telemetry/uXX-baseline-diagnose-<scenario>.json` and cleans up stray generated report files, fills the `Baseline` Telemetry A column in `comparisons.md`, marks `#UXX-TA` as `[-]`, and stops at **Commit gate A**.
   - **Pass B, Production batch:** Split the active batch across **1 to 3 strictly file-disjoint workers**, choosing `Neon Medium` or `Neon High` per slice based on complexity and risk. Brief each worker to compile and run targeted checks inside its slice, update any broken unit-test imports in that batch so the tree stays compiling and green between batches, and post `@coordinator [blocker]` or `@coordinator [finding]` with `file:line` proof and a concise proposed fix instead of silently improvising around contradictions or editing out-of-scope files. Orchestrator resolves escalations via the escalation ladder below, runs targeted integration checks matching the batch blast radius, routes failures back via `@<worker>` on the board, audits `git diff`, marks completed items `[-]`, and stops cleanly for manual commit before the next batch.
   - **Pass C, Telemetry B:** Spawn 1 worker to apply any remaining `#UXX-TB` test import or contract updates. Orchestrator runs every `#UXX-TB` command using `npm run e2e -- --agent --spec <file>` only if elevated, writes structured summary JSON containing `command`, `passed`, `failed`, and `duration_ms` into `.agents/major-refactor/telemetry/uXX-post-<suite>.json` for `cargo`, `mocha`, and `e2e` runs, copies generated `e2e/replay-diagnostics/reports/` output to `.agents/major-refactor/telemetry/uXX-post-diagnose-<scenario>.json` and removes stray generated report files, fills `Post` Telemetry B and `Verdict` in `comparisons.md`, verifies zero regressions, marks `#UXX-TB` as `[-]`, and stops at **Commit gate B**.
4. **Handoff for manual commit.** End every session with:
   - Pass completed and items marked `[-]` or `[~]` if paused early
   - Exact test and diagnostic commands run with pass/fail counts
   - `git status --short` summary
   - Encountered issues and resolutions whenever Tier 1 or Tier 2 escalation fired: what broke or conflicted, the chosen fix, any `roadmap.md` or `cross-split-seams.md` updates, and the test proof
   - The unit's manual smoke check on Pass C so the user can test, flip `[-]` to `[x]`, and commit manually
   - On Pass C, judge from the actual diff and test coverage rather than fixed unit rules whether any changes carry concrete risk: subtle concurrency, OS or COM integration, GPU or lifecycle state, cross-window sync, other paths automated tests cannot fully observe, or open risk from the diff audit. If so, suggest that the user run a separate `validate-changes` pass before committing, and never run it without explicit user approval. Scope that suggestion strictly to the exact flagged files or items and the specific risk found.

## Escalation ladder

- **Tier 1, routine mismatch or in-slice bug:** When a worker hits a plan-vs-code contradiction or an unexpected bug, it posts `@coordinator [blocker]` or `@coordinator [finding]` with `file:line` proof and a concise proposed fix, then waits. The `Neon High` orchestrator verifies the proof against the unit audit, [cross-split-seams.md](major-refactor/cross-split-seams.md), and `Locked contracts` and replies once: approve as proposed, send an adjusted fix with green light to implement, or defer it as a downstream note in [roadmap.md](major-refactor/roadmap.md).
- **Tier 2, factual pushback or locked-contract clash:** Trigger only if the worker pushes back once with concrete local proof that the orchestrator's adjusted fix fails, or if resolving the blocker appears to require bending `Locked contracts`, `R1` to `R7`, or `Sync A` to `F`. Spawn **1 fresh `Neon High` read-only arbiter** for a bounded consensus pass of at most 2 rounds with the orchestrator and owning worker. Prefer any contract-preserving fix first; if preserving the contract is technically impossible, agree on the smallest safe amendment, update all affected callers plus the matching lines in [roadmap.md](major-refactor/roadmap.md) and [cross-split-seams.md](major-refactor/cross-split-seams.md), have the owning worker apply and locally test it, and require the arbiter's post-fix `[Agree]` sign-off before integration checks.
- **Mid-run user pause:** Pause mid-session only for non-technical stops such as quota 429, missing external fixtures or tools, or a trade-off that changes user-facing behavior with no behavior-preserving workaround. Resolve technical blockers autonomously and present them in the handoff for commit-gate review.

## User-flagged checkpoint fixes

When the user reports an issue at Commit gate A, between Pass B batches, or at Commit gate B, resolve it autonomously inside the active `/orchestrate` session (or a fresh `fix UXX` session) and keep [roadmap.md](major-refactor/roadmap.md) free of bug-chase items or history logs.

1. **Triage and reproduce first.** Inspect the active unit's diff (`git diff <unit-base>..HEAD`) and prove the failure with a failing targeted test or replay diagnostic (`cargo test`, `mocha`, `e2e --spec`, or `diagnose`) before patching code.
2. **Decide scope autonomously.**
   - **Unit regression or blocking issue in owned files:** fix in place.
   - **Blocking pre-existing issue in a downstream unit's files:** apply the minimal root-cause fix now so the gate passes, and add a 1-line note on the downstream unit in [roadmap.md](major-refactor/roadmap.md) so the later unit does not duplicate or overwrite it.
   - **Non-blocking pre-existing issue outside this unit:** log a 1-line downstream note on the owning unit in [roadmap.md](major-refactor/roadmap.md) and report it in the handoff.
   - **Test, probe, or telemetry defect:** fix the test or probe and refresh only the affected telemetry.
   - Pause mid-fix only for the non-technical stops listed under **Mid-run user pause**.
3. **Fix via `/orchestrate` workers.** Flip the open gate item (`#UXX-TA`, `#UXX-TB`, or an uncommitted `#UXX-NN` item) from `[-]` to `[~]`. Reuse the waiting slice worker via `post_message` if still in the same Pass B session, or spawn 1 focused worker (up to 2 if strictly file-disjoint; `Neon High` for concurrency, COM, GPU, or lifecycle bugs, `Neon Medium` otherwise). The worker must add a targeted regression test covering the repro, apply the minimal root-cause fix, and pass local checks. Trigger Tier 2 arbiter review if the fix touches `Locked contracts`, `R1` to `R7`, or `Sync A` to `F`.
4. **Refresh affected verification and hand off.**
   - **Commit gate A:** re-run affected baseline suite(s), overwrite their `uXX-baseline-*.json`, and update matching rows in [comparisons.md](major-refactor/telemetry/comparisons.md).
   - **Between Pass B batches:** run targeted blast-radius tests and type or syntax checks without writing telemetry JSON.
   - **Commit gate B:** rebuild the debug binary if Rust changed, re-run the new regression test plus every `#UXX-TB` suite in the fix's blast radius, overwrite the affected `uXX-post-*.json` files, and update [comparisons.md](major-refactor/telemetry/comparisons.md).
   - Flip `[~]` back to `[-]`, report the issue, root cause, fix, regression test proof, and updated `git status --short` in the handoff, and re-present the smoke check for manual commit.

## Guardrails

- **Live source of truth.** [roadmap.md](major-refactor/roadmap.md) is the live source of truth for unit order, item IDs, and locked contracts. Because [UPSTREAM_PARITY.md](UPSTREAM_PARITY.md) can add or prune items between runs, treat the Pass B batch ranges below as split guidance and absorb any newly added `#UXX-NN` items into the unit's final batch or an additional batch if large.
- **One unit at a time, strictly sequential.** Ignore parallel unit edges such as `U04 || U05` and `U07 || U08..U11` to keep commits linear and quota draw low.
- **No `/swarm` skill.** Follow `.agents/skills/orchestrate/SKILL.md` only; never add monitor, narrator, or standing peer-debate workers.
- **Worker cap:** Never run more than **3 implementation workers at once**, 1 for Pass A or C and 1 to 3 for Pass B. The sole exception is 1 fresh `Neon High` read-only arbiter spawned only on a Tier 2 escalation. Leave finished workers `waiting` for follow-up fixes; do not kill them.
- **Model discipline:** The orchestrator runs on `Gemini 4 Neon High` and decides `Gemini 4 Neon Medium` vs `Gemini 4 Neon High` per worker slice. Never use `Hydrogen` models. Never switch models mid-run via `swarm{action:"model"}`. If quota hits 429 mid-pass, mark any partially applied items `[~]` in `roadmap.md` and pause cleanly.
- **Locked contracts:** Preserve all active IPCs, Rust-to-JS events, JS events, `quivit://` and `quivit-preview://` routes, E2E selectors, and diagnostic probes listed in the live `Locked contracts` section of [roadmap.md](major-refactor/roadmap.md), unless amended through a Tier 2 arbiter resolution and reported in the session handoff.
- **No automated commits or `[x]` marks:** Never run `git commit` or `git push`. Mark agent-verified items `[-]`; the user marks `[x]` after manual verification.

## Unit dispatch table

The high-risk column flags slices where `Gemini 4 Neon High` is most useful; the orchestrator makes the final `Neon High` vs `Neon Medium` call per slice.

| Unit | Audit file | Baseline Pass B batches | High-risk slices for `Neon High` consideration | User smoke check on Pass C |
|---|---|---|---|---|
| `U01` | [audit-08](major-refactor/audit-08-be-core-windows-config.md) | B1: `#U01-01`..`#U01-10`<br>B2: `#U01-11`..`#U01-20` | `config.rs`, `windows.rs` | Launch app with 0 CSP errors and DevTools opening, toggle portable/roaming, tray hide, detach file list. |
| `U02` | [audit-09](major-refactor/audit-09-be-media-archives-protocol.md) | B1: `#U02-01`..`#U02-10` | `archives/*`, `protocol.rs`, `formats/*` | Open ZIP/RAR/7z/TAR, scrub rapidly during scans, open animated GIF/WebP/AVIF/TIFF/ICO. |
| `U03` | [audit-10](major-refactor/audit-10-be-fs-library-network-drop.md) | B1: `#U03-01`..`#U03-07`<br>B2: `#U03-08`..`#U03-14` | `platform/drop.rs`, `temp_archive.rs` | Drop image on main + detached file list, Recycle Bin delete, move library, URL download. |
| `U04` | [audit-11](major-refactor/audit-11-be-previews-registry.md) | B1: `#U04-01`..`#U04-09` | `com_server.rs`, `thumb_server.rs`, `image_pane.rs` | Explorer preview pane on PNG/GIF/WebP/SVG/archive, folder thumbnails, Options -> File Types. |
| `U05` | [audit-01](major-refactor/audit-01-fe-core-fs-workspace.md) | B1: `#U05-01`..`#U05-10`<br>B2: `#U05-11`..`#U05-19` | `core.js`, `fsUtils.js`, `workspaceSession.js` | Folder + archive keyboard nav, Options live preview, detach/reattach file panel. |
| `U06` | [audit-02](major-refactor/audit-02-fe-main-chrome-css.md) | B1: `#U06-01`..`#U06-12` | None by default | Light/Dark themes + custom CSS, statusbar/menubar toggles, `#file-list` scroll + resize, Options tab reset. |
| `U07` | [audit-03](major-refactor/audit-03-fe-options-metadata.md) | B1: `#U07-01`..`#U07-10` | None by default | Options tabs, keybind conflict styling + reset, custom CSS preview/revert, Metadata window. |
| `U08` | [audit-04](major-refactor/audit-04-fe-filepanel.md) | B1: `#U08-01`..`#U08-08`<br>B2: `#U08-09`..`#U08-17` | `filePanel.js` | Large folder list + thumbnail scroll, panel/column resize, detached favorites toggle, Library tree. |
| `U09` | [audit-05](major-refactor/audit-05-fe-urlloader.md) | B1: `#U09-01`..`#U09-06` | None by default | Import URL/MangaDex gallery, cancel mid-download, verify progress in main + detached windows. |
| `U10` | [audit-06](major-refactor/audit-06-fe-viewer-strip.md) | B1: `#U10-01`..`#U10-06`<br>B2: `#U10-07`..`#U10-12` | `viewerRender.js`, `manhwaStrip.js` | Rapid nav across images/GIFs/videos/ICOs, spread + manhwa strip, zoom/pan/rotate, video audio. |
| `U11` | [audit-07](major-refactor/audit-07-fe-viewer-webgl.md) | B1: `#U11-01`..`#U11-11` | `viewerPipelines.js`, `glRuntime.js` | Anime4K Fast/Normal, CRT/Phosphor/Scanlines, Lanczos across single/spread/manhwa, 0 WebGL errors. |
