Compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` when writing, revising, and verifying this tracker.

# Window relocation gap tasks

## Fixed scope and progress rules

- Source of findings: `.agents/08-synthesis.txt`. Keep that file unchanged. Its SHA-256 at tracker creation is `7EFB434193B786F94DE53D10F0C87C9EFFA7AC4904389F1CD64109008DBCCD67`.
- Branch: `feature/window-relocation`. Audit target and starting HEAD: `35f38e9d81cf95cd0534ac33e316291bf26e2f8c`. Before snapshot: `a473a5c2fbb0eaa93bdbb99cca111327c07104ab`.
- Starting tree: tracked files clean; the synthesis is untracked. This Markdown file is the only change made while preparing the tracker.
- Preserve the audit IDs and priorities. `F01` through `F10` map to Findings 01 through 10. `R01` through `R07` map to Risks 01 through 07. Findings are confirmed by the audit; risks require verification before deciding whether to change code.
- `[ ]` means not started. `[~]` means in progress, including implemented work awaiting automated or manual runtime verification. `[x]` means an accepted resolution with evidence recorded. Use a disposition of `fixed`, `ruled out`, or `deferred with user agreement`; do not silently drop an item.
- At creation, all 17 tasks were unchecked and no app checks had run. Executed automated checks and runtime verification results appear below. Branch orientation and tracker preparation do not resolve a gap.
- Source references below are repository-relative `file:line` anchors at the starting HEAD. Re-resolve them after edits. On resumption, read this file, the synthesis, repository rules, `git status`, and the current diff before continuing from unchecked work.
- Keep definitions, scope, IDs, and acceptance criteria stable. If implementation or runtime testing reveals a different cause, record the evidence and revised approach under that item. Add a newly discovered gap with its own ID and rationale; do not fold rejected legacy issues into this scope without an explicit scope change.
- Update this tracker after each logical slice with files changed, supporting `file:line` references, automated test results, manual runtime verification results, and user acceptance. Leave architecture tracking and README feature documentation alone until explicitly requested. Do not commit without instructions.

## Implementation and verification constraints

Main remains the session authority for shared state, filesystem operations, imports, and durable configuration. Each UI owner paints its own document. Cross-window work uses the existing session and owner APIs. Keep bootstrap thin, domain modules free of DOM, and native window logic in `src-tauri/src/windows.rs`.

Preserve action IDs, existing IPC contracts, protocol URLs, bounded request/cache limits, and intentional window-local behavior unless a listed fix requires a documented change. Reuse helpers, static markup, and CSS state. Do not put test or diagnostic machinery in `src/`, or introduce another writer for a UI concern.

Verify every slice with both targeted automated checks and manual runtime verification. Run syntax and type checks (`node --check`, `cargo check --tests`), relevant unit/integration tests (`npm run mocha`, targeted `cargo test` filters), targeted E2E specs (`npm run e2e -- --spec <file>`, or with `--agent` when the runner reports an elevated shell), and replay diagnostics (`npm run diagnose`) when isolating cross-window timing or focus behavior. Do not create new test suites or test harnesses during implementation; edit existing tests only when a change breaks them, as repository rules require.

Run the corresponding manual runtime checks from the ordered manual runtime checklist below for each slice before treating the slice as verified. Automated checks with mocked boundaries or single-window E2E specs do not replace detached multi-window runtime verification.

## Preview group verification, 2026-10-28

Compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`. This group covers F03, F04, and R06 in the seven-file diff from `35f38e9`, committed in `c1dc66e`. Manual runtime verification for this group is tracked in checklist item 4 below.

1. **V01, addressed. Snapshot transport no longer renders previews or resets backgrounds.** `src/js/shared/workspaceSession.js:120` includes preview data only on the full initial snapshot. Receipt at line 133 records it without importing or invoking theme/CSS renderers. `src/js/main/main.js:294` consumes that initial state in the existing UI owner. Ordinary navigation snapshots cannot invoke theme or CSS application through the session transport. In addition, `src-tauri/src/windows.rs:75` retains the existing native theme routing but no longer writes a default background color to every window. CSS background color stays with the existing shell-background owner. This preserves native System theme behavior without disturbing other windows' CSS colors.
2. **V02, addressed. First show waits for native theme and the effective CSS shell color.** `src/js/shared/theme.js:11` retains the pending native-theme request, exposed by `waitForTheme()` at line 16. `src/js/shellBackground.js:38` exports an immediate sync that cancels a queued timer, waits for prior background writes and the current theme request, reads the current CSS color, and awaits the native background command. `src/js/main/main.js:404` waits for that promise before `show_window`. The existing 20 ms scheduling remains for ordinary style events; it is flushed explicitly for first show.

Executed automated checks:

- `node --check` passed for all six changed JS modules.
- `cargo check --tests --manifest-path src-tauri/Cargo.toml` passed after the native theme change.
- `npm run mocha` passed, 308 tests.
- Three focused `node --input-type=module` stdin checks against the real JS modules passed with mocked DOM/Tauri calls and delayed promises, covering initial-only preview publication, data-only replica receipt, theme/background write ordering, and System mapping to a null native theme.
- `cargo test --manifest-path src-tauri/Cargo.toml config::tests` passed 14 tests, including split and single-file config coverage.
- `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js` passed with exit code 0 (2 tests, 1 spec), exercising Options tab navigation plus live theme changes and Save in the attached window.
- `git diff --check` passed and the synthesis SHA-256 remains unchanged.

## Strip synchronization group verification, 2026-10-28

Compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`. The four-module diff from `c1dc66e` covers F06, F09, and R04. Manual runtime verification for this group is tracked in checklist item 5 below.

1. **V03, addressed. Boundary input waits for the detached reveal acknowledgement.** `src/js/shared/workspaceControls.js:47` retains one pending reveal, returns `false` while it is pending, and updates confirmed state only after success. Newer scroll reports take precedence over an older reply; docking changes invalidate pending ownership. Failure retains the hold and permits retry. The visible panel reports top-state changes through `src/js/filepanel/filePanel.js:70`, including programmatic scrolling and clamping, without waiting for a browser scroll event. Combined mode retains the direct synchronous boolean.
2. **V04, addressed. Startup retains range changes received before UI subscription.** `src/js/shared/workspaceSession.js:163` retains live ranges before dispatching them, and the UI seeds from that latest value. A repeated full snapshot also applies Core state before dispatching its range repaint at line 152, so the settle consumer sees the matching selection.

Executed automated checks:

- `node --check` passed for all four changed JS modules.
- `npm run mocha` passed all 308 tests.
- Disposable Node stdin checks against the real session/controls modules passed with mocked Tauri/event boundaries.
- `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js` (7 tests) and `npm run e2e -- --agent --spec e2e/specs/02-navigation.e2e.js --spec e2e/specs/03-viewer.e2e.js` (4 navigation tests and 7 viewer tests) passed with exit code 0.
- `git diff --check` passed and the synthesis SHA-256 remains unchanged.

## Prompt and dialog focus group verification, 2026-10-28

Compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`. The nine-file diff covers F10 and R05 (`src/js/core.js`, `src/js/filepanel/filePanel.js`, `src/js/main/main.js`, `src/js/main/passwordOverlay.js`, `src/js/main/urlOverlay.js`, `src/js/services/actions.js`, `src/js/shared/workspaceControls.js`, `src/js/shared/workspaceSession.js`, `src/js/urlLoader.js`). Replay diagnostics and manual runtime testing identified and repaired three coordination defects (`V05`, `V06`, and `V07`). Both tasks in this group are accepted (`[x]`) and verified in runtime (checklist item 7 passed).

1. **V05, addressed. Initiator tracking ignores background RPCs and handles directory-preview-to-archive-open and retry/cancel transitions.** `src/js/shared/workspaceSession.js:44, 121` restricts remote initiator updates to user-initiated `action`, `core`, `fs`, and `import` methods from `workspace-file-list` and returns `'main'` whenever `fileList` is docked. `src/js/shared/workspaceControls.js:124` sets `lastInitiator` to `'main'` for local `main` imports/drops. `src/js/main/passwordOverlay.js:24, 62, 127, 141` tracks `_lockedMode` and `_submitting`, re-evaluates `_show()` when `state.mode` transitions into `'archive'`, preserves `_initiatingWindow` across password retries, deduplicates the `Escape` focus-restore branch, and prevents passive directory-mode `password_incorrect` cache hits from stealing focus back to `main`.
2. **V06, addressed. URL prompt submission retains main viewer focus while Escape restores the initiating window, and recombined panels fall back locally.** `src/js/main/urlOverlay.js:58, 163` passes `restoreInitiator: true` only on `Escape` cancellation (`escape_key`), restoring `_initiatingWindow` on cancel while keeping focus on `main` after a successful submit. `src/js/shared/workspaceControls.js:91` falls back to local `main` focus if `fileList` was recombined before focus restoration.
3. **V07, addressed. Detached File List replica no longer activates `#password-overlay` or calls `setFocus()` / `fileListUl.focus()` on incoming archive snapshots.** `src/js/main/main.js:268, 288` passes `Core: ViewportCore` to `initPasswordOverlay` and `initUrlOverlay` so `workspace-file-list` receives empty viewport state (`mode: 'empty'`, `index: -1`) and never activates viewport overlays or calls `setFocus()`. `src/js/filepanel/filePanel.js:1720, 2293, 2501, 3101` and `src/js/core.js:264` also skip redundant `Core.selectIndex` RPC dispatches on the second click of a double-click, guard against late `checkArchiveEncryption` resolution after entering archive mode, and suppress `fileListUl.focus()` in `workspace-file-list` when an archive password prompt is active or `workspace-file-list` does not have document focus.

Executed automated and manual runtime checks:

- `node --check` passed for all nine changed JS modules.
- `npm run mocha` passed all 308 tests.
- Disposable `node --input-type=module` stdin checks against `core.js`, `workspaceSession.js`, `workspaceControls.js`, `passwordOverlay.js`, `urlOverlay.js`, and `filePanel.js` passed with mocked DOM/Tauri boundaries.
- Replay diagnostics (`npm run diagnose -- --scenario detached-password-focus`) verified that `main` retains OS and DOM focus on `#password-input` after opening a locked archive from `workspace-file-list`, and restores focus to `workspace-file-list` `#file-list` on `Escape`.
- `npm run e2e -- --agent --spec e2e/specs/04-archives.e2e.js --spec e2e/specs/08-url-loader.e2e.js` passed both specs (6 passing in `04-archives.e2e.js`, 1 passing in `08-url-loader.e2e.js`, exit code 0).
- User manual runtime testing confirmed both password prompt and URL prompt focus routing and Escape restoration across detached windows.
- `git diff --check` passed and the synthesis SHA-256 remains unchanged.

## Auxiliary window positioning and restoration group verification, 2026-10-28

Compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`. This group covers F01 and R07 in `src-tauri/src/windows.rs` and `src-tauri/src/lib.rs`. Both tasks are accepted (`[x]`) and verified in runtime (checklist items 2 and 8.2 passed).

1. **V08, addressed. Auxiliary windows restore and center over main.** `src-tauri/src/windows.rs:213` defines `raise_main`, which unminimizes and focuses main. `open_options` and `open_metadata_window` invoke it before window presentation (lines 222, 266), ensuring main is in the foreground. `center_window_over_main` (line 329) positions the auxiliary window centered over main, clamped to the monitor work area, with a current-monitor center fallback if main cannot be queried or remains minimized.
2. **V09, addressed. Single-instance handoff restores all minimized workspace windows.** `src-tauri/src/windows.rs:470` unminimizes every secondary window and main in `restore_from_tray` (lines 474, 479) after showing them, then focuses main. The bootstrap callback in `src-tauri/src/lib.rs:45` calls `windows::restore_from_tray(app)` before emitting `single-instance-open`. `open_workspace_window` (line 128) also unminimizes an existing detached window when re-detached.

Executed automated and manual runtime checks:

- `cargo check --tests --manifest-path src-tauri/Cargo.toml` passed.
- `git diff --check` passed and the synthesis SHA-256 remains unchanged.
- `npm run mocha` passed all 308 tests.
- `npm run e2e -- --agent --spec e2e/specs/06-configuration.e2e.js` passed with exit code 0 (2 tests).
- `npm run e2e -- --agent --spec e2e/specs/07-os-integration.e2e.js` passed with exit code 0 (4 tests, including single-instance file open handoff).
- User manual runtime testing confirmed auxiliary window opening/centering and single-instance unminimize restoration across detached windows.

## Confirmed gaps

Work through the P1 items first. Keep related risk investigations beside the corresponding fix when practical: R06 with F03/F04, R04 with F06, R03 with F07, R05 with F10, and R07 with F01.

1. [x] **F01, P1. Keep Options and Archive Info on screen when main is minimized.**

   Source: `.agents/08-synthesis.txt:239`. Owner and anchors: `src-tauri/src/windows.rs:213`, `src-tauri/src/windows.rs:222`, `src-tauri/src/windows.rs:266`, `src-tauri/src/windows.rs:329`. Callers include `src/js/options/options.js:207` and `src/js/main/metadataBadge.js:99`.

   Restore and focus the main window when opening Options or Archive Info from any workspace window, and center the auxiliary window over main. If main cannot be queried or remains minimized, fall back to centering on the current monitor. Keep sizing, restoring, and placement in the existing native window owner.

   Acceptance: Opening Options or Archive Info from the detached File List restores and focuses the main window, placing the auxiliary window on screen centered over main and on top of it. Combined-mode centering and resizing remain correct.

   Verification: Run `cargo check --tests --manifest-path src-tauri/Cargo.toml`, targeted Rust and E2E window bounds checks, and manual runtime checklist item 2 (opening Options and Archive Info from the detached File List while main is minimized).

   Evidence and disposition: `raise_main` (`src-tauri/src/windows.rs:213`) unminimizes and focuses main. `open_options` and `open_metadata_window` invoke it before window presentation (lines 222, 266), ensuring main is in the foreground. `center_window_over_main` (line 329) positions the auxiliary window centered over main. `usable_window_bounds` (line 308) guards against invalid dimensions or coordinates, falling back to `window.center()` (lines 342, 345) on the current monitor if main cannot be queried. The placement is clamped to main's monitor work area (line 360). Sizing stays in the native owner, and `open_options`/`open_metadata_window` unminimize existing auxiliary instances. IPC command names and signatures are unchanged. Automated checks: `cargo check --tests`, `git diff --check`, and `npm run e2e -- --agent --spec e2e/specs/06-configuration.e2e.js` passed. Manual runtime checklist item 2 passed. Disposition: fixed, accepted by user.

2. [ ] **F02, P1. Preserve live workspace state when Options saves.**

   Source: `.agents/08-synthesis.txt:259`. Owner and anchors: `src/js/options/options.js:473`, `src/js/options/options.js:513`, `src/js/options/options.js:538`, `src/js/core.js:654`.

   Replace the six-key preservation whitelist with a merge based on current authoritative configuration and the fields Options actually edits. Account for controls that mutate the dialog's in-memory config directly, including keybindings, wheel modifier, and nested filter options. Preserve unknown keys and intentional deletions, such as disabling Continue from last opened directory.

   Acceptance: Saving an unrelated Options field preserves live `fit_mode`, `scaling_mode`, `spread_enabled`, `spread_direction`, `spread_step`, `manhwa_enabled`, `file_list_view_mode`, `active_filter`, `directory_sort`, `last_opened_path`, and `last_active_image`. The six currently preserved keys also remain intact. Options-owned edits still save, including nested edits, and existing configuration files round-trip in split and portable layouts.

   Verification: Run `node --check`, `npm run mocha`, `cargo test --manifest-path src-tauri/Cargo.toml config::tests`, `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js` (and `05-persistence.e2e.js` where applicable), and manual runtime checklist item 3.

   Evidence and disposition: pending.

3. [x] **F03, P1. Clear preview overrides in every workspace window after Save.**

   Source: `.agents/08-synthesis.txt:279`. Owner and anchors: `src/js/main/main.js:323`, `src/js/main/main.js:348`, `src/js/main/main.js:359`, `src/js/options/options.js:562`.

   Make preview cleanup apply to both authority and replica before authority-only reload work. Preserve authoritative config loading and snapshot distribution. Cover event/snapshot ordering so a late config event cannot leave styling stuck on an old preview.

   Acceptance: Save ends both theme and CSS overrides in every live workspace window. Each window renders the saved values and responds to later changes. Local preview cleanup does not make the replica reload or persist configuration independently.

   Verification: Run `node --check`, `npm run mocha`, `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`, and manual runtime checklist item 4 across both `main` and detached `workspace-file-list`.

   Evidence and disposition: `src/js/main/main.js:341-354` clears `previewTheme` and `previewCss` before the replica guard without applying stale pre-save `Core.getState().config` on `workspaceSurface` unless a config snapshot (`pendingSnapshotThemeSync`) already arrived during preview; `main` reloads authoritative config via `reloadConfigAndSyncLibrary(null, { flush: false })` (`main.js:314, 356`) with generation-guarded `Core.loadConfig()` (`src/js/core.js:656-659`) and publishes `configEvent: true` (`src/js/shared/workspaceSession.js:255`) so the replica applies the saved theme/CSS once at `main.js:396-426`. `src/js/options/options.js:129-132, 533-534, 582-583` guards `refreshLiveConfigState()` during `saveOptions()`, and `src-tauri/src/config.rs:565-567` writes `quivit_config.json` last in `write_split_config`. Automated checks (`node --check`, `cargo check --tests`, `config::tests`, 308 Mocha tests, focused module checks, and `06-configuration.e2e.js`) passed. Manual runtime checklist item 4 passed. Disposition: fixed, accepted by user.

4. [x] **F04, P2. Give newly detached windows the active ephemeral preview before showing them.**

   Source: `.agents/08-synthesis.txt:301`. Owner and anchors: `src-tauri/src/windows.rs:109`, `src-tauri/src/windows.rs:134`, `src/js/main/workspaceBoot.js:1`, `src/js/shared/workspaceSession.js:114`, `src/js/main/main.js:385`. Related preview helpers: `src/js/shared/configPreview.js:18`, `src/js/shellBackground.js:1`.

   Carry the current preview through window initialization using the existing session/lifecycle owners. Apply effective theme, CSS, and native shell background before first show. Keep preview state separate from durable config and pre-paint localStorage caches. Depend on F03 for save cleanup.

   Acceptance: Detaching during an active theme or CSS preview opens a matching File List window. Save commits the selected styling; cancel restores saved styling in all windows. Detach/recombine/reopen does not lose or persist an unapplied preview.

   Verification: Run `node --check`, `cargo check --tests --manifest-path src-tauri/Cargo.toml`, `npm run mocha`, `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`, and manual runtime checklist item 4 (detaching the File List while a theme or CSS preview is active in Options, then testing Cancel and Save).

   Evidence and disposition: `src/js/shared/workspaceSession.js:126` carries initial preview data on `full` snapshots and line 139 records it without rendering. `src/js/main/main.js:307-310` initializes preview overrides, then `quivit-config-loaded` (`main.js:396-426`) applies the effective theme/CSS while only `main` writes `localStorage`. Before show, `main.js:431` awaits `syncShellBackground()` (`src/js/shellBackground.js:51-60`), which awaits `waitForTheme()` (`src/js/shared/theme.js:21`) and skips `plugin:window|set_background_color` (`InvalidateRect`/`UpdateWindow`) when the computed `--surface` color is unchanged. `src/js/shared/theme.js:3-10, 26-30` skips no-op DOM mutations, and `src-tauri/src/windows.rs:74-112, 150, 247, 289` tracks `ACTIVE_THEME` (`Option<tauri::Theme>`) across windows without forcing `Some(theme)` when `"system"` is active. Automated checks (`node --check`, `cargo check --tests`, `config::tests`, 308 Mocha tests, focused module checks, and `06-configuration.e2e.js`) passed. Manual runtime checklist item 4 passed. Disposition: fixed, accepted by user.

5. [ ] **F05, P2. Use one metadata producer and reject stale asynchronous results.**

   Source: `.agents/08-synthesis.txt:323`. Owner and anchors: `src/js/main/main.js:287`, `src/js/main/metadataBadge.js:29`, `src/js/main/metadataBadge.js:62`, `src/js/main/metadataBadge.js:102`, `src/js/metadata-window.js:193`.

   Select one session producer for extraction, cover downsampling, the metadata payload cache, and publication. Keep badge painting in the window hosting the badge, including after docking changes. Recheck the current container after asynchronous cover work before publishing. Simply skipping replica initialization must not disable its badge or Archive Info action.

   Acceptance: A container transition starts one extraction/downsampling/publication path. Out-of-order work cannot overwrite metadata for the current container. The visible badge and Archive Info still work when attached, detached, and recombined.

   Verification: Run `node --check`, `npm run mocha`, targeted archive/metadata E2E checks (`04-archives.e2e.js`), and manual runtime verification of Archive Info and badge updates across attached, detached, and recombined modes. Leave the rejected legacy metadata-clearing issue outside this fix.

   Evidence and disposition: pending.

6. [x] **F06, P2. Deliver strip settle updates to the detached File List and Favorites.**

   Source: `.agents/08-synthesis.txt:344`. Owner and anchors: `src/js/viewer/manhwaStrip.js:1858`, `src/js/shared/workspaceSession.js:201`, `src/js/shared/workspaceControls.js:9`, `src/js/shared/workspaceControls.js:69`, `src/js/filepanel/filePanel.js:3077`.

   Deliver the settle notification and current visible indices to the file panel owner in a defined order. Use the existing event/session path and avoid duplicate delivery or echo loops. Investigate R04 in the same area.

   Acceptance: On settle, the detached file selection matches the strip anchor and Favorites markers match the visible range, including when the anchor index itself did not change. Combined mode still works.

   Verification: Run `node --check`, `npm run mocha`, `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js`, and manual runtime checklist item 5 in detached mode.

   Evidence and disposition: `src/js/shared/workspaceControls.js:25` stores the delivered range before dispatching `quivit-manhwa-settle` on the replica. `src/js/filepanel/filePanel.js:3091` updates selection and Favorites from Core and that range, including a range change with an unchanged anchor. Anchor changes also reach the panel through Core snapshots. Main publishes range after its strip state listener and on settle; the viewport-owner guard prevents replica echoes. Repeated full snapshots apply state before notifying the range consumer. Automated checks (`node --check`, 308 Mocha tests, focused module checks, and `02-navigation.e2e.js` / `03-viewer.e2e.js`) passed. Disposition: fixed, pending full manual runtime verification in checklist item 5.

7. [ ] **F07, P2. Synchronize the active Library provider with its visible panel.**

   Source: `.agents/08-synthesis.txt:366`. Owner and anchors: `src/js/shared/workspaceSession.js:201`, `src/js/filepanel/libraryStore.js:113`, `src/js/filepanel/libraryStore.js:124`, `src/js/filepanel/filePanel.js:2757`, `src/js/menubar.js:717`.

   Deliver `quivit-library-active-changed` to the affected owner and ensure the receiver reads the updated provider state before repainting. Preserve the explicit-choice latch, the All selection, and automatic import activation semantics. Keep provider persistence in the existing store.

   Acceptance: Choosing a provider or All from either window updates the visible Library panel and menu selection consistently. An explicit choice still controls subsequent auto-activation.

   Verification: Run `node --check`, `npm run mocha`, targeted E2E checks, and manual runtime checklist item 6 (switching Library providers from both `main` and `workspace-file-list`).

   Evidence and disposition: pending.

8. [ ] **F08, P2. Route detached deletion failure feedback to the visible status bar.**

   Source: `.agents/08-synthesis.txt:386`. Owner and anchors: `src/js/filepanel/filePanel.js:1319`, `src/js/shared/workspaceSession.js:129`, `src/js/shared/workspaceSession.js:183`, `src/js/menubar/statusbar.js:99`. Detached chrome rules: `src/js/menubar/chrome.js:59`, `src/css/main.css:497`.

   Add a narrowly scoped replica-to-main notification path for `quivit-status-flash`. Keep status rendering in its existing owner and preserve the detached status bar's disabled/hidden behavior. Avoid a general unrestricted event relay.

   Acceptance: A failed deletion restores the row and displays the existing explanatory message once in main's status bar. Combined mode still produces one message, and success produces no failure feedback.

   Verification: Run `node --check`, `npm run mocha`, targeted E2E or controlled IPC failure checks, and manual runtime checklist item 6.

   Evidence and disposition: pending.

9. [x] **F09, P2. Reveal the parent row in the visible File List and preserve boundary holds.**

   Source: `.agents/08-synthesis.txt:404`. Owner and anchors: `src/js/main/main.js:259`, `src/js/shared/workspaceControls.js:32`, `src/js/shared/workspaceControls.js:62`, `src/js/filepanel/filePanel.js:3097`, `src/js/viewer/manhwaStrip.js:2376`, `src/js/viewer/manhwaStrip.js:3130`, `src/js/viewer/viewer.js:31`.

   Route reveal requests to the window hosting the File List. Preserve the meaning of `revealListTop()` returning whether the list was already at the top. Its callers currently branch synchronously on that boolean; returning an RPC Promise or an unconditional `true` would change boundary navigation. Define the remote acknowledgement/state behavior before wiring it into those callers. Depend on current strip synchronization from F06 where needed.

   Acceptance: The first boundary gesture reveals `..` in the visible detached list and holds navigation when the list was scrolled down. Subsequent input follows the existing already-at-top behavior. Pan, keyboard navigation, and jump-to-start behave consistently in combined and detached mode, without scrolling hidden main-window DOM as a substitute.

   Verification: Run `node --check`, `npm run mocha`, `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js`, and manual runtime checklist item 5 in detached mode.

   Evidence and disposition: `src/js/main/main.js:262` routes the strip reveal callback through the workspace owner. `src/js/shared/workspaceControls.js:47` preserves the combined synchronous return and routes detached work to the visible panel. An unknown or scrolled-down remote state returns `false`; repeated input stays held while one reveal awaits acknowledgement. Success confirms the top only when no newer scroll report supersedes it. Docking invalidates old pending ownership, and rejection does not release the hold. `src/js/filepanel/filePanel.js:3111` remains the sole scroll writer for reveal; `reportScrollTop()` also reports programmatic selection/clamp changes. Automated checks (`node --check`, 308 Mocha tests, focused module checks, and `02-navigation.e2e.js` / `03-viewer.e2e.js`) passed. Disposition: fixed, pending full manual runtime verification in checklist item 5.

10. [x] **F10, P2. Route prompt focus to the owner and restore the initiating window.**

    Source: `.agents/08-synthesis.txt:427`. Owner and anchors: `src/js/main/passwordOverlay.js:19`, `src/js/main/passwordOverlay.js:95`, `src/js/main/passwordOverlay.js:108`, `src/js/main/urlOverlay.js:19`, `src/js/main/urlOverlay.js:43`, `src/js/shared/workspaceControls.js:55`, `src/js/services/actions.js:264`.

    Track the initiating window through the existing action/open flow, including state-driven password prompts. Request native focus before DOM input focus, and restore the initiator on cancellation through its owner API. Keep prompt DOM with its owner. Preserve deliberate `restoreFocus: false` paths and sibling-navigation rules that avoid stealing focus. Investigate R05 alongside this work.

    Acceptance: A detached archive open directs immediate typing to the password field, and cancelling password or URL input returns to the initiating window. The same flows from main retain main focus. A successful open, retry, or backdrop dismissal keeps its intended focus behavior.

    Verification: Run `node --check`, `npm run mocha`, replay diagnostics (`detached-password-focus`), `npm run e2e -- --agent --spec e2e/specs/04-archives.e2e.js --spec e2e/specs/08-url-loader.e2e.js`, and manual runtime checklist item 7.

    Evidence and disposition: `src/js/services/actions.js:264` forwards `payload` in `cmd-use-url` to `ctx.UrlLoader?.openPrompt(payload)` (`src/js/urlLoader.js:2676`). `src/js/shared/workspaceControls.js:43, 91, 124, 134` tags forwarded actions with `initiator: 'workspace-file-list'`, records `'main'` on local actions and imports, and implements `restoreFocus(target)` with local fallback when docked and `plugin:window|set_focus` + `filePanel.focus` RPC when detached. `src/js/shared/workspaceSession.js:44, 121` updates `lastInitiator` only on user-initiated `action`, `core`, `fs`, and `import` requests from `workspace-file-list` and returns `'main'` when combined. `src/js/main/main.js:268, 288` passes `Core: ViewportCore` to `initPasswordOverlay` and `initUrlOverlay` so only the viewport owner (`main`) activates viewport overlays or calls `getCurrentWindow().setFocus()`. `src/js/main/passwordOverlay.js:24, 45, 60, 125, 139` tracks `_initiatingWindow`, `_lockedMode`, and `_submitting`, requests native focus before DOM focus on archive open and retry, preserves sibling-navigation and directory-preview non-stealing rules, and restores `_initiatingWindow` on `Escape`. `src/js/filepanel/filePanel.js:1720, 2293, 2501, 3101` and `src/js/core.js:264` prevent `workspace-file-list` from calling `fileListUl.focus()` on incoming archive-prompt or unfocused snapshots. `src/js/main/urlOverlay.js:22, 44, 58, 163` requests native focus before DOM focus, restores `_initiatingWindow` on `Escape`, retains `main` on submit, and preserves `restoreFocus: false` dismissals. Syntax checks, 308 Mocha tests, focused module checks, replay diagnostics (`detached-password-focus`), `--agent` E2E runs (`04-archives.e2e.js` and `08-url-loader.e2e.js`), and manual runtime checklist item 7 passed. Disposition: fixed, accepted by user.

## Conditional risks

Investigate each risk to confirm or rule out its causal path with supporting `file:line` references, automated tests, and runtime verification. Keep the audit classification until the evidence and disposition are recorded. These investigations may run beside related findings without changing their IDs.

11. [ ] **R01, P2. Bound visible-range synchronization during rapid gallery scrolling.**

    Source: `.agents/08-synthesis.txt:457`. Anchors: `src/js/filepanel/filePanel.js:2115`, `src/js/urlLoader.js:2660`, `src/js/shared/workspaceSession.js:59`.

    Inspect range-send frequency, deduplication/coalescing, pending-request creation, reply settlement, and timeout cleanup. Determine whether sustained scrolling can accumulate requests while replies lag. If needed, coalesce superseded range updates at the existing sender owner; do not raise the pending limit to hide the problem.

    Acceptance and verification: Verify bounded in-flight work, delivery of the final visible range, and no starvation of ordinary workspace commands using unit/module tests, delayed-reply E2E or replay diagnostics, and runtime observation during rapid scrolling in detached mode.

    Evidence and disposition: pending.

12. [ ] **R02, P3. Establish consistent replica download-status path keys on Windows.**

    Source: `.agents/08-synthesis.txt:464`. Anchors: `src/js/urlLoader.js:2639`, `src/js/urlLoader.js:2794`. Existing related coverage: `mocha/urlLoader.test.js`, `mocha/urlLoaderFlows.test.js`, `e2e/specs/08-url-loader.e2e.js`.

    Trace event, initial snapshot, and row-query paths, comparing key construction and lookup for both Windows path separators and any required case normalization. Reuse an existing normalizer if a mismatch is found.

    Acceptance and verification: Verify that pending/downloading/error/completed states and placeholder checks use equivalent keys on attachment and later updates using `npm run mocha`, `08-url-loader.e2e.js`, and runtime observation of downloading gallery rows in detached mode on Windows.

    Evidence and disposition: pending.

13. [ ] **R03, P3. Invalidate Library thumbnails in the window that owns them after relocation.**

    Source: `.agents/08-synthesis.txt:471`. Anchors: `src/js/main/main.js:296`, `src/js/main/main.js:341`, `src/js/filepanel/filePanel.js:85`.

    Establish whether the replica misses invalidation when the Library root changes. If so, notify the owning file panel through the existing relocation/session flow. Retain main's import, history, and watcher responsibilities; do not run those independently on the replica.

    Acceptance and verification: Verify relocation notification to ordinary and Favorites cache invalidation/remapping in the visible owner across split and portable config paths using automated checks and runtime observation after relocating the Library folder in Options while detached.

    Evidence and disposition: pending.

14. [x] **R04, P3. Seed the initial visible strip range without waiting for another gesture.**

    Source: `.agents/08-synthesis.txt:478`. Anchors: `src/js/shared/workspaceControls.js:7`, `src/js/shared/workspaceControls.js:20`, `src/js/shared/workspaceControls.js:65`, `src/js/shared/workspaceSession.js:114`.

    Inspect the idle-strip attachment path to ensure initial connection obtains the current range without a new scroll or state change, seeding it during the existing ready/state exchange after the viewport owner is available. Coordinate with F06, including reconnects and delayed initialization.

    Acceptance and verification: Verify initial range availability, listener registration, and first repaint so visible-range classes and Favorites markers match main immediately upon detaching the File List, using automated checks and manual runtime checklist item 5.

    Evidence and disposition: Main registers the current viewport range provider at `src/js/shared/workspaceControls.js:21`; a ready request includes it in the full snapshot at `src/js/shared/workspaceSession.js:133`. Replica receipt caches the seed before UI import. Live range receipt at line 163 replaces that seed even before controls subscribe. `createWorkspaceControls` reads the latest cached range at line 13 before file-panel initialization and its first render. Repeated full snapshots apply Core state before range notification. Empty ranges clear old data, and fresh detached documents obtain a new ready snapshot. Focused module checks and 308 Mocha tests passed. Disposition: fixed, pending full manual runtime verification in checklist item 5.

15. [x] **R05, P3. Establish native foreground behavior for URL and file/folder dialogs.**

    Source: `.agents/08-synthesis.txt:485`. Anchors: `src/js/shared/workspaceControls.js:58`, `src/js/services/actions.js:258`, `src/js/services/actions.js:261`, `src/js/services/actions.js:264`, `src-tauri/src/windows.rs:113`.

    Trace action ownership, focus requests, and native dialog parenting for Open URL, Open Directory, and Open File from the detached File List. Fix missing ownership/focus coordination where needed.

    Acceptance and verification: Verify owner, focus-request ordering, and dialog parenting in both automated tests and manual runtime checklist item 7 (`Ctrl+I`, `Ctrl+O`, and `Ctrl+Shift+O` from the detached File List window).

    Evidence and disposition: `src/js/services/actions.js:258, 261` sets `owner: 'window'` for `cmd-open-dir` and `cmd-open-file`. When invoked from the detached File List, the action runs locally in `workspace-file-list`, parenting `pick_folder` (`src-tauri/src/commands/shell.rs:64` via `window.hwnd()`) and `window.__TAURI__.dialog.open` (`tauri-plugin-dialog` 2.7.2 `set_parent(&window)`) directly to the active `workspace-file-list` window without cross-window focus transfer. Selected paths forward via `FsUtils.loadFile` replica RPC. `cmd-use-url` remains owned by `main` with `focusOwner: true` because `#url-overlay` lives in `#viewport` on `main`, requesting native focus on `main` before DOM input focus via F10. Syntax checks, 308 Mocha tests, focused module checks, `--agent` E2E runs (`04-archives.e2e.js` and `08-url-loader.e2e.js`), and manual runtime checklist item 7 passed. Disposition: fixed, accepted by user.

16. [x] **R06, P2. Finish preview reversion before native Options close destroys its webview.**

    Source: `.agents/08-synthesis.txt:492`. Anchors: `src/js/options/options.js:338`, `src/js/options/options.js:346`, `src/js/options/options.js:361`, `src/js/shared/configPreview.js:10`, `src-tauri/src/windows.rs:202`.

    Inspect native close-request handling, default destruction behavior, and asynchronous preview reversion. Defer close in the existing lifecycle owner until reversion finishes, then close once. Preserve the explicit Close button, force-close escape, and saved-state behavior. Coordinate with F03/F04.

    Acceptance and verification: Verify that native titlebar `X` close reverts unsaved theme and CSS previews across all workspace windows before destruction, without recursing or hanging, using automated checks and manual runtime checklist item 4.

    Evidence and disposition: Tauri 2.11.5 (`src-tauri/Cargo.lock:4643`, `src/manager/window.rs:170`) and `@tauri-apps/api` 2.11.1 (`node_modules/@tauri-apps/api/window.js:1632`) await the `onCloseRequested` callback before destroying the window, and `src/js/options/options.js:365` prevents default close, awaits `revertPreviewChanges()`, and closes once after reversion completes. Automated checks (`node --check`, 308 Mocha tests, `06-configuration.e2e.js`) passed. Manual runtime checklist item 4 passed. Disposition: fixed, accepted by user.

17. [x] **R07, P3. Restore the minimized detached File List on single-instance handoff.**

    Source: `.agents/08-synthesis.txt:499`. Anchors: `src-tauri/src/lib.rs:44`, `src-tauri/src/windows.rs:470`.

    Trace the single-instance callback through the native restore owner for both minimized workspace windows. Ensure restoring from a second-instance handoff unminimizes both workspace windows without adding window-management logic to bootstrap. Preserve tray restore behavior.

    Acceptance and verification: Verify that single-instance handoff opens the file in the original process and unminimizes both `main` and `workspace-file-list`, including hide-to-tray/restore and combined mode, using `cargo check --tests`, `07-os-integration.e2e.js`, and manual runtime checklist item 8.2.

    Evidence and disposition: Risk confirmed by source. Tao 0.35.3 `set_visible(true)` issues `ShowWindow(SW_SHOW)`, which does not restore an iconic window; only `set_minimized(false)` issues `SW_RESTORE` (`tao/src/platform_impl/windows/window_state.rs`, `apply_diff`). `restore_from_tray` (`src-tauri/src/windows.rs:470`) unminimizes every secondary window (line 474) and main (line 479) after showing them, then focuses main. Window restoration stays in the native window owner. The bootstrap callback in `src-tauri/src/lib.rs:45` calls `windows::restore_from_tray(app)` before emitting `single-instance-open`. Tray Show and left-click share the same function. `open_workspace_window` (line 128) also unminimizes an existing detached window when re-detached. Automated checks: `cargo check --tests` passed; `npm run e2e -- --agent --spec e2e/specs/07-os-integration.e2e.js` passed 4/4, including `single-instance-open` temp-archive handoff. Manual runtime checklist item 8.2 passed. Disposition: fixed, accepted by user.

## Exclusions retained from the synthesis

These are not additional tasks. Report 06's missing `directory_sort` preservation is covered by F02. Report 03's password/URL focus findings are covered by F10.

Keep the synthesis's four rejected issues outside this scope: legacy metadata-window clearing when navigating to a container without metadata, the untraced submenu DPI clipping hypothesis, legacy config-watcher rebinding between roaming and portable modes, and the presentational duplicate `workspace-keybind-note` ID. Reopen one only with new evidence and an explicit scope change.

## Verification and acceptance tracking

Run the targeted automated checks reaching each slice's consumers alongside manual runtime verification. Existing entry points include `mocha/core.test.js`, `mocha/actions.test.js`, `mocha/metadata.test.js`, `mocha/urlLoader.test.js`, `mocha/urlLoaderFlows.test.js`, and `mocha/diagnosticsContract.test.js`; E2E navigation, viewer, archive, persistence, configuration, OS integration, and URL loader specs live in `e2e/specs/`.

1. [ ] Verify each changed owner and affected consumer against the task's acceptance criteria with concrete `file:line` references, automated tests, and manual runtime checks.
2. [ ] Run implementation static and unit checks: `node --check <changed-js-file>` for touched JS modules, `cargo check --tests --manifest-path src-tauri/Cargo.toml` when Rust changes, and `npm run mocha`. Record any failures before continuing.
3. [ ] For F02 and persistence changes, verify split and portable read/write paths, defaults, unknown keys, restart loading, and preview non-persistence. Use isolated configuration for automated tests; do not run automated tests against live roaming user data.
4. [ ] For shared session/event changes, verify ordering, bounded work, single delivery, source/target ownership, and reconnect behavior. Use replay diagnostics (`npm run diagnose`) when isolating multi-window timing, focus, or IPC ordering behavior.
5. [ ] Run targeted E2E specs through `npm run e2e -- --spec <file>`; retry with `--agent` only if the runner reports an elevated shell. Run targeted Rust test filters when backend code changes. Reserve the full Rust suite for final signoff or core-contract verification.
6. [ ] Execute the corresponding manual runtime checks in the ordered manual runtime checklist below, covering attach/detach/recombine, view/index retention, metadata access, title synchronization, local chrome, native drops, and shutdown paths.
7. [ ] Compare the diff against ownership, CSS/HTML, performance, duplicate-helper, stale-reference, and diagnostics rules in `.agents/skills/validate-changes/SKILL.md`. Preserve the synthesis SHA-256 fingerprint and limit changes to the listed gaps and justified downstream repairs.
8. [ ] Present the executed automated checks and manual runtime verification steps to the user, resolve any runtime issues found, and await explicit user signoff before marking a slice complete. Run architecture/README update skills only on explicit request.

## Ordered manual runtime checklist

Execute these runtime checks in a live build (`npm run tauri dev` or built binary) to verify all slices end to end.

1. [ ] **Basic detach and layout integrity (baseline)**
   1. Launch QuiviT and open a folder or archive containing multiple images.
   2. Select **Windows → File List → Detached**.
   3. Confirm the File List disappears from the main viewer window and opens in a separate **File List** window (`workspace-file-list`).
   4. Confirm the current directory, selected image, and scroll position match the previous combined state.
   5. Confirm the detached **File List** window hides viewer-only controls (Fit, Zoom, Effect, Manhwa, Spread, Navigation menus, and bottom status bar).

2. [x] **Auxiliary window centering while main is minimized (`F01`)**
   1. With the **File List** detached, minimize the main viewer window to the Windows taskbar.
   2. Focus the detached **File List** window and press `5` (or click **Options** in the menu).
   3. Confirm the main viewer window restores and comes to the front, and **Options** opens on screen, centered over the main viewer and on top of it.
   4. Close **Options**, minimize the main viewer again, click the **Archive Info** (`i`) badge in the detached **File List** window, and confirm main restores and **Archive Info** opens centered over it.
   5. Restore the main viewer window.

3. [ ] **Options live state preservation (`F02`)**
   1. Open **Options** (`5`) and keep it open alongside the main viewer and detached **File List**.
   2. In the main viewer, press `Q` to change Fit Mode, press `M` to toggle Manhwa mode, and in the detached **File List** press `T` to toggle Thumbnail view and navigate to a different image or folder.
   3. In **Options**, change an unrelated setting (such as Keyboard Pan Step) and click **Save**.
   4. Confirm the main viewer and detached **File List** keep the live Fit Mode, Manhwa state, Thumbnail view mode, sort order, and current image/folder without reverting to the state from when **Options** was first opened.

4. [x] **Theme preview, detach during preview, Save reset, and native close (`F03`, `F04`, `R06`)**
   1. With the **File List** detached and **Options** open to **Customization**, click **Dark** theme, then click **Light** theme, then click **Save**. Confirm both the main viewer and the detached **File List** window display the saved **Light** theme (neither window stays stuck on **Dark**).
   2. Recombine the **File List** (**Windows → File List → Left** or **Right**). In **Options → Customization**, click a contrasting theme (such as **Dark**) without clicking **Save**, then detach the **File List** (**Windows → File List → Detached**). Confirm the newly opened **File List** window immediately opens in the previewed **Dark** theme without a white flash or stale theme.
   3. Click the native titlebar close button (`X`) on the **Options** window while previewing an unsaved contrasting theme (and also test clicking the **Close** button). Confirm both workspace windows revert to the saved theme.

5. [ ] **Manhwa initial attach range, scroll settle, and boundary reveal (`F06`, `F09`, `R04`)**
   1. In combined mode, open a multi-image folder (that has a parent `..` row) in **Manhwa** mode (`M`) so multiple images are visible in the vertical strip, then detach the **File List** (**Windows → File List → Detached**).
   2. Confirm that without scrolling or clicking anything, the rows in the detached **File List** (and **Favorites** if pinned) immediately show the visible-strip indicator bars for all images currently visible in the viewer strip (`R04`).
   3. Scroll vertically through several images in the main viewer strip and let scrolling come to a complete stop. Confirm the active selection highlight in the detached **File List** and the `.in-view` markers in **Favorites** update to match the settled strip position (`F06`).
   4. In the detached **File List**, scroll the file list downward so the top `..` row is scrolled out of view.
   5. In the main viewer, scroll/pan up past the very top of the first image (or press `Home` / `Up` / `PageUp` at the top boundary). Confirm the first boundary action scrolls the detached **File List** back to the very top so `..` is visible while holding navigation inside the current folder, and a second boundary gesture navigates as expected (`F09`).

6. [ ] **Metadata badge, Library active provider, relocation cache clear, and deletion failure status flash (`F05`, `F07`, `F08`, `R03`)**
   1. With the **File List** detached and **Archive Info** open, navigate between archives/folders with metadata and confirm **Archive Info** updates cleanly once per container without stale cover overwrites, and the badge works when attached, detached, and recombined (`F05`).
   2. With the **File List** detached and the **Library** panel visible, select a specific provider from the **Imports** menu in the main viewer window. Confirm the detached **Library** panel immediately filters to that provider (`F07`).
   3. Browse **Library** items in Thumbnail view in the detached **File List**, relocate the Library folder in **Options**, save, and confirm thumbnails refresh cleanly in the detached **File List** (`R03`).
   4. In the detached **File List**, attempt to delete a file that is locked by another process or read-only. Confirm the item is restored in the detached **File List** and the `"Delete failed. The item was restored."` message flashes once in the main viewer window's status bar (`F08`).

7. [x] **Modal prompt focus routing and native dialogs (`F10`, `R05`)**
   1. Open **Windows → File List → Detached**, click the detached **File List** window, double-click a password-protected archive, and type a few letters without clicking the viewer window. Confirm the letters appear inside the password box in the viewer window, then press `Esc` and press the Up or Down arrow key to confirm selection moves in the detached **File List** window.
   2. Click the detached **File List** window, press `Ctrl+I` to open the **Open URL** prompt, and type a few letters without clicking the viewer window. Confirm the letters appear inside the URL box in the viewer window, then press `Esc` and press the Up or Down arrow key to confirm selection moves in the detached **File List** window.
   3. From the detached **File List** window, trigger **Open File** (`Ctrl+O`) or **Open Folder** (`Ctrl+Shift+O`) and confirm the native dialog opens in front of the active window.

8. [ ] **Native window recombination, single-instance restore, URL gallery scroll/status, and shutdown (`R01`, `R02`, `R07`)**
   1. In detached mode, start a multi-item gallery download via **Open URL** (`Ctrl+I`), confirm downloading rows in the detached **File List** show spinner badges rather than broken icons (`R02`), and rapidly scroll the detached **File List** during download without console `"Too many pending workspace requests"` errors (`R01`).
   2. With the **File List** detached, minimize both the main viewer window and the detached **File List** window, then open an image from Windows Explorer (single-instance handoff) and confirm both windows unminimize and restore (`R07`).
   3. Close the detached **File List** window via its titlebar `X` button and confirm the File List recombines cleanly back into its previous docked side (`Left` or `Right`) in the main window.
   4. Detach the **File List** again, then close the main viewer window via its titlebar `X` button and confirm the entire application exits cleanly without leaving an orphaned **File List** window open.
