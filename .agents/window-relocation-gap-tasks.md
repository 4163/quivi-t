Compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` when writing, revising, and independently verifying this tracker. Verification follows the user's clarified intent below. Review conclusions and executed checks are labelled separately.

# Window relocation gap tasks

## Fixed scope and progress rules

- Source of findings: `.agents/08-synthesis.txt`. Keep that file unchanged. Its SHA-256 at tracker creation is `7EFB434193B786F94DE53D10F0C87C9EFFA7AC4904389F1CD64109008DBCCD67`.
- Branch: `feature/window-relocation`. Audit target and starting HEAD: `35f38e9d81cf95cd0534ac33e316291bf26e2f8c`. Before snapshot: `a473a5c2fbb0eaa93bdbb99cca111327c07104ab`.
- Starting tree: tracked files clean; the synthesis is untracked. This Markdown file is the only change made while preparing the tracker.
- Preserve the audit IDs and priorities. `F01` through `F10` map to Findings 01 through 10. `R01` through `R07` map to Risks 01 through 07. Findings are confirmed by the audit; risks still need evidence before deciding whether to change code.
- `[ ]` means not started. `[~]` means in progress, including implemented work awaiting checks or acceptance. `[x]` means an accepted resolution with evidence recorded. Use a disposition of `fixed`, `ruled out`, or `deferred with user agreement`; do not silently drop an item.
- At creation, all 17 tasks were unchecked and no app checks had run. Current implementation claims and independent verification results appear below. Branch orientation and tracker preparation do not resolve a gap.
- Source references below are repository-relative `file:line` anchors at the starting HEAD. Re-resolve them after edits. On resumption, read this file, the synthesis, repository rules, `git status`, and the current diff before continuing from unchecked work.
- Keep definitions, scope, IDs, and acceptance criteria stable. If implementation reveals a different cause, record the evidence and revised approach under that item. Add a newly discovered gap with its own ID and rationale; do not fold rejected legacy issues into this scope without an explicit scope change.
- Update this tracker after each logical slice with files changed, review confidence and supporting references, any checks run, unresolved assumptions, and user acceptance. Leave architecture tracking and README feature documentation alone until explicitly requested. Do not commit without instructions.

## Implementation and verification constraints

Main remains the session authority for shared state, filesystem operations, imports, and durable configuration. Each UI owner paints its own document. Cross-window work uses the existing session and owner APIs. Keep bootstrap thin, domain modules free of DOM, and native window logic in `src-tauri/src/windows.rs`.

Preserve action IDs, existing IPC contracts, protocol URLs, bounded request/cache limits, and intentional window-local behavior unless a listed fix requires a documented change. Reuse helpers, static markup, and CSS state. Do not put test or diagnostic machinery in `src/`, or introduce another writer for a UI concern.

The user's clarified intent is to establish confidence by reviewing the code. Trace the relevant producer, transport, consumer, state changes, and failure paths, then explain why the acceptance criterion follows. A sufficiently supported code review can satisfy a criterion without executing that scenario. This takes precedence over a default confidence ladder that would require runtime proof for every behavior.

Record review confidence as `high`, `medium`, or `low`, with file:line references and a short rationale. High means the relevant paths are traced without a material unresolved assumption. Medium means a timing, platform, or indirect dependency assumption remains. Low means the trace is incomplete. Distinguish `reviewed` from `tested` or `reproduced`; confidence from inspection is not a claim that the app was exercised. Avoid unsupported percentage scores.

Use targeted E2E or other existing tests where review leaves an uncertainty worth resolving, alongside the normal syntax/type and relevant regression checks required during implementation. Do not require a dedicated executable demonstration for every gap. Use existing runners; do not create test suites or harnesses during implementation. Edit existing tests only when a change breaks them, as repository rules require.

Remove manual checks that code review or E2E can establish. Keep only unresolved native, visual, or OS behavior in the short conditional manual section at the end. Lack of existing test coverage alone does not justify a manual checklist item. The per-task verification notes below describe review targets and possible E2E follow-ups, not mandatory runtime scenarios.

## Preview group verification, 2026-10-28

Compared against the repository validation rules. This earlier group covered F03, F04, and R06 in the seven-file diff from `35f38e9`, now committed in `c1dc66e`. Fourteen tasks were unchecked at that review. F03's Save path is addressed by review; R06's original single-close premise is ruled out by the installed Tauri implementation. F04's two independent-review findings were repaired, as recorded below. All three tasks in this group are accepted (`[x]`); the configuration E2E retry passed, while detached preview/native first-show frames were not exercised.

1. **V01, addressed. Snapshot transport no longer renders previews or resets backgrounds.** `src/js/shared/workspaceSession.js:120` includes preview data only on the full initial snapshot. Receipt at line 133 records it without importing or invoking theme/CSS renderers. `src/js/main/main.js:294` consumes that initial state in the existing UI owner. Ordinary navigation snapshots cannot invoke theme or CSS application through the session transport. In addition, `src-tauri/src/windows.rs:75` retains the existing native theme routing but no longer writes a default background color to every window. CSS background color stays with the existing shell-background owner. This preserves native System theme behavior without disturbing other windows' CSS colors. Review confidence: high; authority and replica module checks passed with mocked transport/DOM boundaries.
2. **V02, addressed. First show waits for native theme and the effective CSS shell color.** `src/js/shared/theme.js:11` retains the pending native-theme request, exposed by `waitForTheme()` at line 16. `src/js/shellBackground.js:38` exports an immediate sync that cancels a queued timer, waits for prior background writes and the current theme request, reads the current CSS color, and awaits the native background command. `src/js/main/main.js:404` waits for that promise before `show_window`. The existing 20 ms scheduling remains for ordinary style events; it is flushed explicitly for first show. Review confidence: high. A focused module check delayed theme and background promises and verified that show occurred only after they resolved, using the latest CSS color. Actual compositor frames were not observed.

Executed checks after repair:

- `node --check` passed for all six changed JS modules.
- `cargo check --tests --manifest-path src-tauri/Cargo.toml` passed after the native theme change.
- `npm run mocha` passed, 308 tests.
- Three focused `node --input-type=module` stdin checks against the real JS modules passed. Mocked boundaries supplied DOM/Tauri calls and delayed promises; no new test suite or harness files were created. The checks covered initial-only preview publication, data-only replica receipt, theme/background write ordering, and System mapping to a null native theme.
- The earlier `cargo test --manifest-path src-tauri/Cargo.toml config::tests` run passed 14 tests, including split and single-file config coverage. The repair adds no config keys or persistence writes. The earlier `config_tests` filter matched zero tests and is not counted as coverage.
- Latest `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js` rerun passed with exit code 0: 2 tests, 1 spec. It created a WebDriver session and exercised Options tab navigation plus live theme changes and Save in the running app. Earlier runs failed before any tests during session creation; that failure did not recur in this run. The retry alone does not establish its earlier cause. The attached-window spec does not exercise detached preview startup or first-frame appearance. A post-session mock cleanup warning was logged after session deletion; the spec and process still passed.
- Rust build output included a non-fatal LNK4098 MSVCRTD linker warning.
- `git diff --check` passed. No replay investigation override, architecture/README edits, or commits were introduced. The synthesis SHA-256 remains unchanged.

The focused checks establish JS transport and promise ordering with mocked external boundaries. The configuration E2E run now adds live attached-window Options/theme/Save coverage. Detached preview startup and actual compositor frames were not exercised, so their evidence remains code review and the focused module checks. The explicit color-before-show ordering is established without requesting a duplicate manual check.

Next unstarted P1 work is F01 and F02. The F10/R05 conditional manual check has been completed and accepted below.

## Strip synchronization group verification, 2026-10-28

Compared against the repository validation rules. The current four-module diff from `c1dc66e` covers F06, F09, and R04. Independent review found two remaining ordering defects and repaired them in the existing owners. All three tasks in this group are accepted (`[x]`). Eleven tasks remain unstarted, including F01 and F02.

1. **V03, addressed. Boundary input waits for the detached reveal acknowledgement.** The submitted F09 implementation set the cached top state to `true` immediately after sending a reveal. A second input returned `true` while the reply was still delayed. `src/js/shared/workspaceControls.js:47` now retains one pending reveal, returns `false` while it is pending, and updates confirmed state only after success. Newer scroll reports take precedence over an older reply; docking changes invalidate pending ownership. Failure retains the hold and permits retry. The visible panel reports top-state changes through `src/js/filepanel/filePanel.js:70`, including programmatic scrolling and clamping, without waiting for a browser scroll event. Combined mode retains the direct synchronous boolean. The unused replacement setter was removed and each window exposes only its relevant file-panel RPC method. Review confidence: high for these coordination paths. Main uses the latest delivered scroll report; this is asynchronous state coordination, not a claim of simultaneous cross-window DOM reads.
2. **V04, addressed. Startup retains range changes received before UI subscription.** The submitted R04 implementation cached only the initial snapshot range. A newer live range arriving between that snapshot and UI import was dispatched before the listener existed and left the initial seed stale. `src/js/shared/workspaceSession.js:163` now retains live ranges before dispatching them. The UI seeds from that latest value. A repeated full snapshot also applies Core state before dispatching its range repaint at line 152, so the settle consumer sees the matching selection. Review confidence: high.

Executed checks after repair:

- `node --check` passed for all four changed JS modules.
- The nearest Core, actions, and diagnostics-contract tests passed, 35 tests. The subsequent `npm run mocha` verification passed all 308 tests.
- Two disposable Node stdin checks against the real session/controls modules reproduced V03 and V04 before repair and passed afterward. Mocked Tauri/event boundaries covered delayed reveal acknowledgement, one pending reveal under repeated input, newer scroll reports, docking/reopening, rejection/retry, synchronous combined behavior, authority ready-snapshot publication, startup range updates, unchanged-anchor settle delivery, reconnect state-before-range order, empty ranges, and no replica echo. No test suite or harness files were added. These checks do not claim native window or rendered-row coverage.
- `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js` passed on retry, 7 tests in 1 spec, exit code 0, and `npm run e2e -- --agent --spec e2e/specs/02-navigation.e2e.js --spec e2e/specs/03-viewer.e2e.js` passed both specs (4 navigation tests and 7 viewer tests, exit code 0). They exercised directory navigation, sorting, parent folder ascent, fit, zoom, pan, spread, manhwa toggling/filter teardown, and ICO continuity in the running combined window. The first direct attempt built successfully, then failed during WebDriver session creation with a timeout and `Chrome instance exited`; no test body ran in that attempt. The retry does not establish the earlier failure's cause. Both builds logged the existing non-fatal LNK4098 warning. The passing run logged a mock cleanup warning after deleting its session; the spec and process passed. Logs remain in the ignored `.e2e-viewer-verification.log`, `.e2e-viewer-verification-retry.log`, and `e2e/.agent-logs/` files.
- This group adds no config keys or persistence writes. Core remains the authority, and split/portable config routing is unchanged. No Rust source changed, so a separate Cargo type/config test run was not required for this group.
- Validation comparison found no remaining ownership, CSS/HTML, duplicate-helper, stale-reference, or diagnostics-contract issue in this diff. No replay investigation override, architecture/README edits, or commits were introduced. `git diff --check` passed and the synthesis SHA-256 still matches the fixed fingerprint above.

No additional manual check is required for the reviewed synchronization and acknowledgement paths. Detached native-window/rendered-row E2E coverage is not claimed.

## Prompt and dialog focus group verification, 2026-10-28

Compared against the repository validation rules. The nine-file diff covers F10 and R05 (`src/js/core.js`, `src/js/filepanel/filePanel.js`, `src/js/main/main.js`, `src/js/main/passwordOverlay.js`, `src/js/main/urlOverlay.js`, `src/js/services/actions.js`, `src/js/shared/workspaceControls.js`, `src/js/shared/workspaceSession.js`, `src/js/urlLoader.js`). Independent review, replay diagnostics, and manual runtime testing identified and repaired three coordination defects in the existing owners (`V05`, `V06`, and `V07`). Both tasks in this group are accepted (`[x]`). Nine tasks remain unstarted, including F01 and F02.

1. **V05, addressed. Initiator tracking ignores background RPCs and handles directory-preview-to-archive-open and retry/cancel transitions.** The submitted implementation set `lastInitiator = message.source` on every incoming `execute(message)` call in `src/js/shared/workspaceSession.js`, allowing background `filePanel.setFileListAtTop`, `import.getActivity`, `url.*`, or `options` `core.flushConfig` requests to overwrite the initiator. In addition, selecting a locked archive row in the File List (`state.mode === 'image'`) already marked `#password-overlay` `.active` with `_lockedArchivePath === state.archivePath` and `shouldFocus = false`, causing the subsequent double-click or `Enter` open (`state.mode === 'archive'`) to skip `_show()` and never focus `main` or `#password-input`; and pressing `Escape` after a failed password retry returned via `openParent()` to `state.mode === 'image'` with cached `password_incorrect` while `_isFileListFocused()` on `main` was `false`, stealing focus back to `main`. `src/js/shared/workspaceSession.js:44, 121` now restricts remote initiator updates to user-initiated `action`, `core`, `fs`, and `import` methods from `workspace-file-list` and returns `'main'` whenever `fileList` is docked. `src/js/shared/workspaceControls.js:124` sets `lastInitiator` to `'main'` for local `main` imports/drops. `src/js/main/passwordOverlay.js:24, 62, 127, 141` tracks `_lockedMode` and `_submitting`, re-evaluates `_show()` when `state.mode` transitions into `'archive'`, preserves `_initiatingWindow` across password retries, deduplicates the `Escape` focus-restore branch, and prevents passive directory-mode `password_incorrect` cache hits from stealing focus back to `main`. Review confidence: high for JS initiator and overlay state routing.
2. **V06, addressed. URL prompt submission retains main viewer focus while Escape restores the initiating window, and recombined panels fall back locally.** The submitted `urlOverlay` implementation called `_restoreFocus(_initiatingWindow)` on every `restoreFocus !== false` hide, including successful URL submission (`_handleSubmit`), which would transfer focus back to `workspace-file-list` after opening a URL in `main`. `src/js/main/urlOverlay.js:58, 163` now passes `restoreInitiator: true` only on `Escape` cancellation (`escape_key`), restoring `_initiatingWindow` on cancel while keeping focus on `main` after a successful submit. `src/js/shared/workspaceControls.js:91` also falls back to local `main` focus if `fileList` was recombined before focus restoration. Review confidence: high; confirmed by user runtime test (Check 2 passed).
3. **V07, addressed. Detached File List replica no longer activates `#password-overlay` or calls `setFocus()` / `fileListUl.focus()` on incoming archive snapshots.** Replay diagnostics (`detached-password-focus`) isolated the exact cause of `main` becoming active for ~20ms and returning focus to `workspace-file-list`: `src/js/main/main.js:266` passed raw `Core` instead of `ViewportCore` to `initPasswordOverlay` (and `initUrlOverlay` at line 285), so when the `mode: 'archive', archiveEncryption: 'password_required'` snapshot arrived in `workspace-file-list` ~25ms after `main` focused itself, both `renderFilePanel` (`fileListUl.focus()`) and the duplicate `passwordOverlay` instance inside `workspace-file-list` (`getCurrentWindow().setFocus()` + `_input.focus()`) executed in `workspace-file-list` and pulled OS window focus back from `main`. `src/js/main/main.js:268, 288` now passes `Core: ViewportCore` to `initPasswordOverlay` and `initUrlOverlay` so `workspace-file-list` receives empty viewport state (`mode: 'empty'`, `index: -1`) and never activates viewport overlays or calls `setFocus()`. `src/js/filepanel/filePanel.js:1720, 2293, 2501, 3101` and `src/js/core.js:264` also skip the redundant `Core.selectIndex` RPC on the second click of a double-click, guard against late `checkArchiveEncryption` resolution after entering archive mode, and suppress `fileListUl.focus()` in `workspace-file-list` when an archive password prompt is active or `workspace-file-list` does not have document focus. Review confidence: high.

Executed checks after repair:

- `node --check` passed for all nine changed JS modules.
- `npm run mocha` passed all 308 tests.
- Disposable `node --input-type=module` stdin checks against the real `core.js`, `workspaceSession.js`, `workspaceControls.js`, `passwordOverlay.js`, `urlOverlay.js`, and `filePanel.js` modules passed with mocked DOM/Tauri boundaries.
- `npm run e2e -- --agent --spec e2e/specs/04-archives.e2e.js --spec e2e/specs/08-url-loader.e2e.js` passed both specs (6 passing in `04-archives.e2e.js`, 1 passing in `08-url-loader.e2e.js`, exit code 0).
- This group adds no config keys, persistence writes, or Rust changes.
- Validation comparison against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` found no remaining ownership, CSS/HTML, duplicate-helper, stale-reference, or diagnostics-contract issues. `git diff --check` passed and the synthesis SHA-256 remains unchanged.

## Confirmed gaps

Work through the P1 items first. Keep related risk investigations beside the corresponding fix when practical: R06 with F03/F04, R04 with F06, R03 with F07, R05 with F10, and R07 with F01.

1. [ ] **F01, P1. Keep Options and Archive Info on screen when main is minimized.**

   Source: `.agents/08-synthesis.txt:239`. Owner and anchors: `src-tauri/src/windows.rs:266`, `src-tauri/src/windows.rs:295`, `src-tauri/src/windows.rs:312`. Callers include `src/js/options/options.js:207` and `src/js/main/metadataBadge.js:99`.

   Replace centering based on minimized main-window coordinates with a usable workspace-window or monitor fallback. Keep sizing and placement in the existing native window owner.

   Acceptance: Opening either auxiliary window from the detached File List while main is minimized produces visible bounds on the intended monitor. Ordinary combined-window centering and resizing remain correct.

   Verification: Review the minimized-state guard, fallback selection, coordinate/scale calculations, sizing, and reopen path. Establish whether minimized coordinates can still reach placement. Use E2E/Tauri bounds queries only if platform geometry remains uncertain after the trace. No routine manual placement check.

   Evidence and disposition: pending.

2. [ ] **F02, P1. Preserve live workspace state when Options saves.**

   Source: `.agents/08-synthesis.txt:259`. Owner and anchors: `src/js/options/options.js:473`, `src/js/options/options.js:513`, `src/js/options/options.js:538`, `src/js/core.js:654`.

   Replace the six-key preservation whitelist with a merge based on current authoritative configuration and the fields Options actually edits. Account for controls that mutate the dialog's in-memory config directly, including keybindings, wheel modifier, and nested filter options. Preserve unknown keys and intentional deletions, such as disabling Continue from last opened directory.

   Acceptance: Saving an unrelated Options field preserves live `fit_mode`, `scaling_mode`, `spread_enabled`, `spread_direction`, `spread_step`, `manhwa_enabled`, `file_list_view_mode`, `active_filter`, `directory_sort`, `last_opened_path`, and `last_active_image`. The six currently preserved keys also remain intact. Options-owned edits still save, including nested edits, and existing configuration files round-trip in split and portable layouts.

   Verification: Review merge precedence and ownership for every listed key, including nested Options edits, absent/unknown keys, intentional deletions, config reload, and split/portable read/write paths. Explain how live values survive the save and restart load. Use focused E2E or config tests for any unresolved merge or persistence behavior.

   Evidence and disposition: pending.

3. [x] **F03, P1. Clear preview overrides in every workspace window after Save.**

   Source: `.agents/08-synthesis.txt:279`. Owner and anchors: `src/js/main/main.js:323`, `src/js/main/main.js:348`, `src/js/main/main.js:359`, `src/js/options/options.js:562`.

   Make preview cleanup apply to both authority and replica before authority-only reload work. Preserve authoritative config loading and snapshot distribution. Cover event/snapshot ordering so a late config event cannot leave styling stuck on an old preview.

   Acceptance: Save ends both theme and CSS overrides in every live workspace window. Each window renders the saved values and responds to later changes. Local preview cleanup does not make the replica reload or persist configuration independently.

   Verification: Trace Save, local preview cleanup, authoritative reload, snapshot delivery, and theme/CSS application in both windows. Review the possible event orders and persistence writes. Use E2E to compare final styling or later updates only if an ordering or rendering question remains.

   Evidence and disposition: Independent review confidence: high for the Save path. `src/js/main/main.js:327` clears both overrides before the replica guard. Main reloads authoritative config; `src/js/core.js:683` notifies state and emits `quivit-config-loaded`, which `src/js/shared/workspaceSession.js:211` publishes with `configEvent: true`. Replica receipt at `workspaceSession.js:138` reaches `main.js:375` and applies saved values with null overrides. The replica does not independently load or persist config. Disposition: fixed, accepted by user. The configuration E2E retry passed for the attached Options/theme/Save flow; detached Save remains established by the source trace rather than this spec.

4. [x] **F04, P2. Give newly detached windows the active ephemeral preview before showing them.**

   Source: `.agents/08-synthesis.txt:301`. Owner and anchors: `src-tauri/src/windows.rs:109`, `src-tauri/src/windows.rs:134`, `src/js/main/workspaceBoot.js:1`, `src/js/shared/workspaceSession.js:114`, `src/js/main/main.js:385`. Related preview helpers: `src/js/shared/configPreview.js:18`, `src/js/shellBackground.js:1`.

   Carry the current preview through window initialization using the existing session/lifecycle owners. Apply effective theme, CSS, and native shell background before first show. Keep preview state separate from durable config and pre-paint localStorage caches. Depend on F03 for save cleanup.

   Acceptance: Detaching during an active theme or CSS preview opens a matching File List window. Save commits the selected styling; cancel restores saved styling in all windows. Detach/recombine/reopen does not lose or persist an unapplied preview.

   Verification: Review the full hidden-window startup path through preview transfer, style/background application, and `show_window`. Trace Save/cancel cleanup and all disk/localStorage writes. Use E2E if initial styling or ordering remains uncertain. Eventual matching colors alone do not establish first-show behavior; retain the conditional native flash observation only if review and available E2E leave that question open.

   Evidence and disposition: Review confidence: high after repairing V01/V02. `src/js/shared/workspaceSession.js:120` carries initial preview data and line 133 records it without rendering. `src/js/main/main.js:294` initializes preview overrides, then the config listener at line 375 applies the effective theme/CSS. Before show, `main.js:404` awaits `syncShellBackground()`, whose implementation at `src/js/shellBackground.js:38` waits for native theme and previous background writes before applying the current CSS color. `src-tauri/src/windows.rs:75` no longer overwrites backgrounds in other windows during theme updates. Removing the preview localStorage write in `src/js/options/options.js:464` remains intact. Focused checks, syntax, Rust type checking, and 308 Mocha tests passed; the configuration E2E retry passed both attached-window tests. Disposition: fixed, accepted by user. No detached-preview E2E or observed first-frame result is claimed.

5. [ ] **F05, P2. Use one metadata producer and reject stale asynchronous results.**

   Source: `.agents/08-synthesis.txt:323`. Owner and anchors: `src/js/main/main.js:287`, `src/js/main/metadataBadge.js:29`, `src/js/main/metadataBadge.js:62`, `src/js/main/metadataBadge.js:102`, `src/js/metadata-window.js:193`.

   Select one session producer for extraction, cover downsampling, the metadata payload cache, and publication. Keep badge painting in the window hosting the badge, including after docking changes. Recheck the current container after asynchronous cover work before publishing. Simply skipping replica initialization must not disable its badge or Archive Info action.

   Acceptance: A container transition starts one extraction/downsampling/publication path. Out-of-order work cannot overwrite metadata for the current container. The visible badge and Archive Info still work when attached, detached, and recombined.

   Verification: Review initialization/subscriptions to establish one producer, then trace freshness guards across every asynchronous extraction and cover step. Follow publication through badge painting and Archive Info opening after docking changes. Use delayed-result E2E or call counts only if the review cannot settle a remaining race or ownership question. Leave the rejected legacy metadata-clearing issue outside this fix.

   Evidence and disposition: pending.

6. [x] **F06, P2. Deliver strip settle updates to the detached File List and Favorites.**

   Source: `.agents/08-synthesis.txt:344`. Owner and anchors: `src/js/viewer/manhwaStrip.js:1858`, `src/js/shared/workspaceSession.js:201`, `src/js/shared/workspaceControls.js:9`, `src/js/shared/workspaceControls.js:69`, `src/js/filepanel/filePanel.js:3077`.

   Deliver the settle notification and current visible indices to the file panel owner in a defined order. Use the existing event/session path and avoid duplicate delivery or echo loops. Investigate R04 in the same area.

   Acceptance: On settle, the detached file selection matches the strip anchor and Favorites markers match the visible range, including when the anchor index itself did not change. Combined mode still works.

   Verification: Trace settle emission, visible-range publication, forwarding, and the selection/Favorites consumers in delivery order. Include a changed visible range with an unchanged anchor. An event name in the forward list is insufficient without tracing its data and consumer. Use scroll/settle E2E only for unresolved ordering or rendering behavior.

   Evidence and disposition: Independent review confidence: high. `src/js/shared/workspaceControls.js:25` stores the delivered range before dispatching `quivit-manhwa-settle` on the replica. `src/js/filepanel/filePanel.js:3091` updates selection and Favorites from Core and that range, including a range change with an unchanged anchor. Anchor changes also reach the panel through Core snapshots. Main publishes range after its strip state listener and on settle; the viewport-owner guard prevents replica echoes. Repeated full snapshots now apply state before notifying the range consumer. Focused module checks and 308 Mocha tests passed; their boundaries and the E2E result are recorded in the group verification above. Disposition: fixed, accepted by user.

7. [ ] **F07, P2. Synchronize the active Library provider with its visible panel.**

   Source: `.agents/08-synthesis.txt:366`. Owner and anchors: `src/js/shared/workspaceSession.js:201`, `src/js/filepanel/libraryStore.js:113`, `src/js/filepanel/libraryStore.js:124`, `src/js/filepanel/filePanel.js:2757`, `src/js/menubar.js:717`.

   Deliver `quivit-library-active-changed` to the affected owner and ensure the receiver reads the updated provider state before repainting. Preserve the explicit-choice latch, the All selection, and automatic import activation semantics. Keep provider persistence in the existing store.

   Acceptance: Choosing a provider or All from either window updates the visible Library panel and menu selection consistently. An explicit choice still controls subsequent auto-activation.

   Verification: Review provider writes, shared store reads, notification delivery, panel/menu repaint, and the explicit-choice latch from both windows. Establish that the receiver reads the current provider and cannot echo indefinitely. Use E2E only if shared-storage timing or the visible result remains uncertain.

   Evidence and disposition: pending.

8. [ ] **F08, P2. Route detached deletion failure feedback to the visible status bar.**

   Source: `.agents/08-synthesis.txt:386`. Owner and anchors: `src/js/filepanel/filePanel.js:1319`, `src/js/shared/workspaceSession.js:129`, `src/js/shared/workspaceSession.js:183`, `src/js/menubar/statusbar.js:99`. Detached chrome rules: `src/js/menubar/chrome.js:59`, `src/css/main.css:497`.

   Add a narrowly scoped replica-to-main notification path for `quivit-status-flash`. Keep status rendering in its existing owner and preserve the detached status bar's disabled/hidden behavior. Avoid a general unrestricted event relay.

   Acceptance: A failed deletion restores the row and displays the existing explanatory message once in main's status bar. Combined mode still produces one message, and success produces no failure feedback.

   Verification: Trace the deletion rejection through rollback, notification transport, and the sole visible status-bar writer. Review source/target restrictions, duplicate delivery, the success branch, and detached chrome rules. If E2E is needed, inject a controlled IPC failure instead of asking a person to find a locked file.

   Evidence and disposition: pending.

9. [x] **F09, P2. Reveal the parent row in the visible File List and preserve boundary holds.**

   Source: `.agents/08-synthesis.txt:404`. Owner and anchors: `src/js/main/main.js:259`, `src/js/shared/workspaceControls.js:32`, `src/js/shared/workspaceControls.js:62`, `src/js/filepanel/filePanel.js:3097`, `src/js/viewer/manhwaStrip.js:2376`, `src/js/viewer/manhwaStrip.js:3130`, `src/js/viewer/viewer.js:31`.

   Route reveal requests to the window hosting the File List. Preserve the meaning of `revealListTop()` returning whether the list was already at the top. Its callers currently branch synchronously on that boolean; returning an RPC Promise or an unconditional `true` would change boundary navigation. Define the remote acknowledgement/state behavior before wiring it into those callers. Depend on current strip synchronization from F06 where needed.

   Acceptance: The first boundary gesture reveals `..` in the visible detached list and holds navigation when the list was scrolled down. Subsequent input follows the existing already-at-top behavior. Pan, keyboard navigation, and jump-to-start behave consistently in combined and detached mode, without scrolling hidden main-window DOM as a substitute.

   Verification: Review the boolean contract and all pan, navigation, and jump callers for initially scrolled and already-at-top lists. Trace delayed acknowledgement, repeated input, and docking changes to establish correct boundary holds. Use E2E with delayed replies only if that state/ordering argument remains incomplete.

   Evidence and disposition: Independent review confidence: high after V03 repair. `src/js/main/main.js:262` routes the strip reveal callback through the workspace owner. `src/js/shared/workspaceControls.js:47` preserves the combined synchronous return and routes detached work to the visible panel. An unknown or scrolled-down remote state returns `false`; repeated input stays held while one reveal awaits acknowledgement. Success confirms the top only when no newer scroll report supersedes it. Docking invalidates old pending ownership, and rejection does not release the hold. `src/js/filepanel/filePanel.js:3111` remains the sole scroll writer for reveal; `reportScrollTop()` also reports programmatic selection/clamp changes. Pan, page, and jump callers retain their boolean contract, with delayed detached input conservatively held. Focused module checks and 308 Mocha tests passed. Evidence is asynchronous coordination using the latest delivered state, not a synchronous read of remote DOM. Disposition: fixed, accepted by user.

10. [x] **F10, P2. Route prompt focus to the owner and restore the initiating window.**

    Source: `.agents/08-synthesis.txt:427`. Owner and anchors: `src/js/main/passwordOverlay.js:19`, `src/js/main/passwordOverlay.js:95`, `src/js/main/passwordOverlay.js:108`, `src/js/main/urlOverlay.js:19`, `src/js/main/urlOverlay.js:43`, `src/js/shared/workspaceControls.js:55`, `src/js/services/actions.js:264`.

    Track the initiating window through the existing action/open flow, including state-driven password prompts. Request native focus before DOM input focus, and restore the initiator on cancellation through its owner API. Keep prompt DOM with its owner. Preserve deliberate `restoreFocus: false` paths and sibling-navigation rules that avoid stealing focus. Investigate R05 alongside this work.

    Acceptance: A detached archive open directs immediate typing to the password field, and cancelling password or URL input returns to the initiating window. The same flows from main retain main focus. A successful open, retry, or backdrop dismissal keeps its intended focus behavior.

    Verification: Review source-window identity, prompt ownership, native-before-DOM focus ordering, cancellation branches, and deliberate no-restore paths. Record confidence in routing separately from confidence that Windows grants foreground access. Use E2E/native focus queries where useful; WebDriver targeting a webview alone does not establish real OS input routing. Keep only unresolved foreground-policy behavior in the conditional manual check below.

    Evidence and disposition: Independent review confidence: high for JS initiator, focus routing, and replica focus-steal prevention after V05/V06/V07 repair; Windows foreground focus transfer and Escape restoration confirmed by user runtime testing (Checks 1 and 2 passed). `src/js/services/actions.js:264` forwards `payload` in `cmd-use-url` to `ctx.UrlLoader?.openPrompt(payload)` (`src/js/urlLoader.js:2676`). `src/js/shared/workspaceControls.js:43, 91, 124, 134` tags forwarded actions with `initiator: 'workspace-file-list'`, records `'main'` on local actions and imports, and implements `restoreFocus(target)` with local fallback when docked and `plugin:window|set_focus` + `filePanel.focus` RPC when detached. `src/js/shared/workspaceSession.js:44, 121` updates `lastInitiator` only on user-initiated `action`, `core`, `fs`, and `import` requests from `workspace-file-list` and returns `'main'` when combined. `src/js/main/main.js:268, 288` passes `Core: ViewportCore` to `initPasswordOverlay` and `initUrlOverlay` so only the viewport owner (`main`) activates viewport overlays or calls `getCurrentWindow().setFocus()`. `src/js/main/passwordOverlay.js:24, 45, 60, 125, 139` tracks `_initiatingWindow`, `_lockedMode`, and `_submitting`, requests native focus before DOM focus on archive open and retry, preserves sibling-navigation and directory-preview non-stealing rules, and restores `_initiatingWindow` on `Escape`. `src/js/filepanel/filePanel.js:1720, 2293, 2501, 3101` and `src/js/core.js:264` prevent `workspace-file-list` from calling `fileListUl.focus()` on incoming archive-prompt or unfocused snapshots. `src/js/main/urlOverlay.js:22, 44, 58, 163` requests native focus before DOM focus, restores `_initiatingWindow` on `Escape`, retains `main` on submit, and preserves `restoreFocus: false` dismissals. Syntax checks, 308 Mocha tests, focused module checks, replay diagnostics (`detached-password-focus`), `--agent` E2E runs (`04-archives.e2e.js` and `08-url-loader.e2e.js`), and manual runtime checks passed. Disposition: fixed, accepted by user.

## Conditional risks

Review each risk to confirm or rule out its causal path, recording confidence and supporting references. A runtime reproduction is not a prerequisite when code review settles the issue. Use targeted E2E only for material uncertainty left by review. Keep the audit classification until the evidence and disposition are recorded. These investigations may run beside related findings without changing their IDs.

11. [ ] **R01, P2. Bound visible-range synchronization during rapid gallery scrolling.**

    Source: `.agents/08-synthesis.txt:457`. Anchors: `src/js/filepanel/filePanel.js:2115`, `src/js/urlLoader.js:2660`, `src/js/shared/workspaceSession.js:59`.

    Review range-send frequency, deduplication/coalescing, pending-request creation, reply settlement, and timeout cleanup. Determine whether sustained scrolling can accumulate requests while replies lag. If needed, coalesce superseded range updates at the existing sender owner; do not raise the pending limit to hide the problem.

    Acceptance and verification: Establish bounded in-flight work, delivery of the final visible range, and no starvation of ordinary workspace commands by tracing the sender/settlement logic. Record any load assumptions. Use delayed-reply E2E and measured pending counts only if needed to resolve those assumptions. No manual stress-scroll checklist.

    Evidence and disposition: pending.

12. [ ] **R02, P3. Establish consistent replica download-status path keys on Windows.**

    Source: `.agents/08-synthesis.txt:464`. Anchors: `src/js/urlLoader.js:2639`, `src/js/urlLoader.js:2794`. Existing related coverage: `mocha/urlLoader.test.js`, `mocha/urlLoaderFlows.test.js`, `e2e/specs/08-url-loader.e2e.js`.

    Trace event, initial snapshot, and row-query paths, comparing key construction and lookup for both Windows path separators and any required case normalization. Reuse an existing normalizer if a mismatch is established.

    Acceptance and verification: Review that pending/downloading/error/completed states and placeholder checks use equivalent keys on attachment and later updates. Record representative path examples and the normalization argument. Use existing URL-loader tests or E2E only for uncertainty about actual payloads or row state. No manual icon inspection.

    Evidence and disposition: pending.

13. [ ] **R03, P3. Invalidate Library thumbnails in the window that owns them after relocation.**

    Source: `.agents/08-synthesis.txt:471`. Anchors: `src/js/main/main.js:296`, `src/js/main/main.js:341`, `src/js/filepanel/filePanel.js:85`.

    Establish whether the replica misses invalidation when the Library root changes. If so, notify the owning file panel through the existing relocation/session flow. Retain main's import, history, and watcher responsibilities; do not run those independently on the replica.

    Acceptance and verification: Trace relocation notification to ordinary and Favorites cache invalidation/remapping in the visible owner, then follow subsequent source-path construction. Review split/portable config paths. Use a populated-cache relocation E2E only if invalidation order remains uncertain. No manual thumbnail comparison.

    Evidence and disposition: pending.

14. [x] **R04, P3. Seed the initial visible strip range without waiting for another gesture.**

    Source: `.agents/08-synthesis.txt:478`. Anchors: `src/js/shared/workspaceControls.js:7`, `src/js/shared/workspaceControls.js:20`, `src/js/shared/workspaceControls.js:65`, `src/js/shared/workspaceSession.js:114`.

    Review the idle-strip attachment path to determine whether initial connection obtains the current range without a new scroll or state change. If needed, seed it during the existing ready/state exchange after the viewport owner is available. Coordinate with F06, including reconnects and delayed initialization.

    Acceptance and verification: Trace initial range availability, listener registration, and first repaint to establish that visible-range classes and Favorites markers match main before another gesture. Review repeated detach/recombine and delayed ready delivery. Use E2E only for any remaining initialization-order question. No manual initial-highlight check.

    Evidence and disposition: Independent review confidence: high after V04 repair. Main registers the current viewport range provider at `src/js/shared/workspaceControls.js:21`; a ready request includes it in the full snapshot at `src/js/shared/workspaceSession.js:133`. Replica receipt caches the seed before UI import. Live range receipt at line 163 now replaces that seed even before controls subscribe. `createWorkspaceControls` reads the latest cached range at line 13 before file-panel initialization and its first render. Repeated full snapshots apply Core state before range notification. Empty ranges clear old data, and fresh detached documents obtain a new ready snapshot. Focused module checks and 308 Mocha tests passed; rendered first-frame behavior was reviewed rather than observed. Disposition: fixed, accepted by user.

15. [x] **R05, P3. Establish native foreground behavior for URL and file/folder dialogs.**

    Source: `.agents/08-synthesis.txt:485`. Anchors: `src/js/shared/workspaceControls.js:58`, `src/js/services/actions.js:258`, `src/js/services/actions.js:261`, `src/js/services/actions.js:264`, `src-tauri/src/windows.rs:113`.

    Trace action ownership, focus requests, and native dialog parenting for Open URL, Open Directory, and Open File from the detached File List. Fix missing ownership/focus coordination if established. Do not assume a successful focus request proves Windows granted foreground access.

    Acceptance and verification: Review the owner, focus-request ordering, and dialog parent. Use E2E/native focus queries where review leaves a platform question. Record any environment-dependent foreground restriction separately from a routing defect. Only a remaining real user-input/foreground-policy uncertainty may use the conditional manual check below.

    Evidence and disposition: Independent review confidence: high for `cmd-open-dir` and `cmd-open-file` native dialog parenting; OS foreground behavior on `cmd-use-url` cross-window `setFocus()` confirmed by user runtime testing (Check 2 passed). `src/js/services/actions.js:258, 261` sets `owner: 'window'` for `cmd-open-dir` and `cmd-open-file`. When invoked from the detached File List, the action runs locally in `workspace-file-list`, parenting `pick_folder` (`src-tauri/src/commands/shell.rs:64` via `window.hwnd()`) and `window.__TAURI__.dialog.open` (`tauri-plugin-dialog` 2.7.2 `set_parent(&window)`) directly to the active `workspace-file-list` window without cross-window focus transfer. Selected paths forward via `FsUtils.loadFile` replica RPC. `cmd-use-url` remains owned by `main` with `focusOwner: true` because `#url-overlay` lives in `#viewport` on `main`, requesting native focus on `main` before DOM input focus via F10. Syntax checks, 308 Mocha tests, focused module checks, `--agent` E2E runs (`04-archives.e2e.js` and `08-url-loader.e2e.js`), and manual runtime checks passed. Disposition: fixed, accepted by user.

16. [x] **R06, P2. Finish preview reversion before native Options close destroys its webview.**

    Source: `.agents/08-synthesis.txt:492`. Anchors: `src/js/options/options.js:338`, `src/js/options/options.js:346`, `src/js/options/options.js:361`, `src/js/shared/configPreview.js:10`, `src-tauri/src/windows.rs:202`.

    Review native close-request handling, default destruction behavior, and asynchronous preview reversion. If destruction can win the race, defer close in the existing lifecycle owner until reversion finishes, then close once. Preserve the explicit Close button, force-close escape, and saved-state behavior. Coordinate with F03/F04.

    Acceptance and verification: Trace native close separately from the Close button helper. Establish that reversion precedes destruction for unsaved previews and that saved/forced close cannot recurse, hang, or double-destroy. Use delayed-delivery E2E if lifecycle semantics remain uncertain. No repeated manual X-button race test.

    Evidence and disposition: Independent review confidence: high that the original single-close premise is ruled out. Tauri 2.11.5 is pinned at `src-tauri/Cargo.lock:4643`. Its installed `src/manager/window.rs:170` prevents native default close when a JS close-request listener exists. Installed `@tauri-apps/api` 2.11.1 at `node_modules/@tauri-apps/api/window.js:1632` awaits that callback before destroying the window. Both `a473a5c` and `35f38e9` already awaited `revertPreviewChanges()` in that callback. The current handler at `src/js/options/options.js:365` additionally prevents default and closes again after reversion. A second close can still encounter `!previewing` while reversion is in progress, but this also existed in both baseline versions and is excluded from findings on this diff. Disposition: ruled out by dependency/source review, accepted by user. No manual single-X check is required on the original premise; the passing configuration E2E spec uses the Close button and does not exercise this native close handler.

17. [ ] **R07, P3. Restore the minimized detached File List on single-instance handoff.**

    Source: `.agents/08-synthesis.txt:499`. Anchors: `src-tauri/src/lib.rs:44`, `src-tauri/src/windows.rs:378`.

    Trace the single-instance callback through the native restore owner for both minimized workspace windows. Establish whether showing a detached window also restores it. If needed, extend that owner without adding window-management logic to bootstrap. Preserve tray restore behavior.

    Acceptance and verification: Review that handoff opens the file in the original process and restores both workspace windows, including hide-to-tray/restore and combined mode. If native show/restore semantics remain uncertain, use a second-process E2E with the single-instance path explicitly enabled. An E2E mode bypassing that callback cannot establish its behavior. No manual Explorer double-click check.

    Evidence and disposition: pending.

## Exclusions retained from the synthesis

These are not additional tasks. Report 06's missing `directory_sort` preservation is covered by F02. Report 03's password/URL focus findings are covered by F10.

Keep the synthesis's four rejected issues outside this scope: legacy metadata-window clearing when navigating to a container without metadata, the untraced submenu DPI clipping hypothesis, legacy config-watcher rebinding between roaming and portable modes, and the presentational duplicate `workspace-keybind-note` ID. Reopen one only with new evidence and an explicit scope change.

## Verification and acceptance tracking

Run the smallest checks reaching each slice's consumers. Existing entry points include `mocha/core.test.js`, `mocha/actions.test.js`, `mocha/metadata.test.js`, `mocha/urlLoader.test.js`, `mocha/urlLoaderFlows.test.js`, and `mocha/diagnosticsContract.test.js`; E2E navigation, viewer, archive, persistence, configuration, OS integration, and URL loader specs live in `e2e/specs/`. Choose by the actual diff. These are runner/coverage starting points, not claims that all task assertions already exist.

1. [ ] Review each changed owner and affected consumers against the task's acceptance criteria. Record confidence, file:line references, the causal argument, and remaining assumptions. A criterion established by this review does not need a duplicate runtime demonstration.
2. [ ] Run the normal implementation checks: `node --check <changed-js-file>` for touched JS modules and `cargo check --tests --manifest-path src-tauri/Cargo.toml` when Rust changes. Run relevant existing regression tests. Record failures before continuing.
3. [ ] For F02 and persistence changes, review split/portable read/write paths, defaults, unknown keys, restart loading, and preview non-persistence. Use isolated configuration for any runtime follow-up. Do not use ordinary `tauri dev` against roaming data.
4. [ ] For shared session/event changes, review ordering, bounded work, single delivery, source/target ownership, and reconnect behavior. Check affected replay probes/scenario contracts if selectors or actions change. Record material timing or platform assumptions that inspection cannot settle.
5. [ ] Use targeted E2E for unresolved behavior where it will add useful evidence. Run it through `npm run e2e -- --spec <file>`; retry with `--agent` only if the runner reports an elevated shell. Use targeted Rust filters when relevant. Run `npm run mocha` for the applicable slice verification. The current `package.json` has no `npm test` script. Reserve the full Rust suite for final signoff or required core-contract verification.
6. [ ] Review regressions reached by the diff, including relevant attach/detach/recombine, view/index retention, metadata access, title synchronization, local chrome, native drops, and shutdown paths. Run E2E for unresolved paths rather than requiring the entire list to be exercised. Do not recreate the synthesis's broad manual baseline/shutdown checklist.
7. [ ] Review the final diff against ownership, CSS/HTML, performance, duplicate-helper, stale-reference, and diagnostics rules in `validate-changes`. Record findings here. Preserve the synthesis fingerprint and limit changes to the listed gaps and justified downstream repairs.
8. [ ] Resolve or explicitly record the conditional manual remainder below, present review confidence, any tests actually run, and remaining uncertainty, and await user signoff before marking the implementation slice accepted. Run architecture/README update skills only on explicit request.

For each task, replace its pending evidence line with review confidence, implementation references, the reasoning supporting the criterion, remaining assumptions, any commands/results, and disposition. A risk may be ruled out by a sufficiently supported code trace; label test evidence separately when it exists. A deferred risk stays visibly unresolved until the user agrees to its disposition.

## Conditional manual remainder

F04's explicit theme/background-before-show order is established by code review and focused delayed-promise checks. A duplicate manual check of that ordering is removed. Actual compositor appearance has not been observed; this is not a runtime or pixel-level verification claim. Do not add routine manual checks for behavior established by review or E2E.

1. [x] **F10/R05, only for Windows foreground focus transfer on the Password and Open URL prompts.** Native file and folder dialogs now open directly inside the active window and do not require this check. Confirmed passing by user runtime testing for both prompts.
   1. Open **Windows → File List → Detached**, click the detached **File List** window, double-click a password-protected archive, and type a few letters without clicking the viewer window. Confirm the letters appear inside the password box in the viewer window, then press the `Esc` key and press the Up or Down arrow key to confirm selection moves in the detached **File List** window.
   2. Click the detached **File List** window, press `Ctrl+I` to open the **Open URL** prompt, and type a few letters without clicking the viewer window. Confirm the letters appear inside the URL box in the viewer window, then press the `Esc` key and press the Up or Down arrow key to confirm selection moves in the detached **File List** window.
