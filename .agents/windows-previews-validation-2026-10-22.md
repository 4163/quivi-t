Validation comparison performed against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before presenting this report.

# Validation report

**Target:** `experimental/windows-previews`, merge base `40674baaf78f29a81ddd81f903b9896daa1e63bf` through HEAD `fa111d6840e39dc19556091bd201056c32fd6a67`.

**Date:** 2026-10-22, Asia/Shanghai.

**Summary:** The branch adds Explorer archive and image previews, native image thumbnails through a COM proxy, staged helper updates, file registration removal, and build selection for external file opens. The review covers all 39 touched non-Markdown files across the 19 branch commits, including the accepted changes outside the previews work.

**Verdict: Pass.** The user confirmed all blocking runtime checks, W1/W4 checks, and the final W2, W3, and N1 runtime checks passed on 2026-10-22. B1 through B5, W1 through W4, and N1 are resolved with user runtime acceptance. The later version-9 finite raster replay follow-up also has passing automated checks and user runtime acceptance, recorded below.

The findings and reproduction results below record the original review. The resolution notes and checked runtime list record the subsequent fixes and user acceptance.

## Scope and method

The initial working tree was clean. The comparison was:

```powershell
git diff origin/main...HEAD -- . ':(exclude)*.md'
```

Every changed non-Markdown file and its changed lines were read. Supporting consumers were inspected where the change crosses a boundary, including archive readers, startup target selection, the single-instance event listener, sorting, config isolation, shell icon helpers, and existing tests. Markdown changes were excluded from the review targets. Repository guidelines supplied the review criteria.

The accepted extra commits are included in the review. Their presence on this branch is not a finding.

## AGENTS.md violations

### B1. [Blocking] Concurrent staging can publish a helper with the wrong version sidecar

- [x] Fixed and runtime accepted on 2026-10-22. A cross-process lock now covers the staging decision and publication sequence. The follow-up probe passed 30 concurrent process pairs with zero errors or inconsistent sidecars.

**Location:** [host.rs:215](E:/Projects/QuiviT/src-tauri/src/platform/previews/host.rs:215), particularly the writes at [host.rs:229](E:/Projects/QuiviT/src-tauri/src/platform/previews/host.rs:229) and [host.rs:265](E:/Projects/QuiviT/src-tauri/src/platform/previews/host.rs:265).

`ensure_previews_host_from` has no serialization around its read, decision, helper replacement, proxy replacement, and sidecar replacement. All callers share the same `.tmp` paths. One caller can replace the EXE, another can replace it again, and the first can then write its own hash and version into the sidecar. The EXE and metadata no longer describe the same build. Competing renames can also fail even when Explorer has not locked either target.

This is reachable through the background launch sync and File Types registration or repair, as well as separate debug and release app processes. Those callers converge on one global helper directory. The later image registration gate reads the sidecar version and proxy health without comparing the helper EXE hash, so it can trust the mismatched version until another staging pass repairs it.

**Evidence:** A scratch executable included the actual `host.rs` module and embedded proxy. Thirty pairs of simultaneous staging calls used two different source byte sequences and embedded versions, both through the supported debug staging path. They operated only in temporary directories and produced:

```text
host staging 30 concurrent pairs: errors=1 inconsistent_sidecars=4
```

An inconsistent sidecar means the final helper's SHA-256 differed from the sidecar's `sha256`. No Explorer process or file lock was involved in the probe.

**Rule:** One owner per concern, deliberate changes to shared behavior, and executable proof for shared persistence contracts.

**Recommendation:** Hold a per-user, cross-process staging lock over the entire decision and publication sequence. Recheck the staged state after acquiring it. Unique temporary names alone do not make the EXE, proxy, and sidecar a consistent update.

### B2. [Blocking] A suffix match can open the wrong archive page

- [x] Fixed and runtime accepted on 2026-10-22. Exact entry identity takes priority across the full list, and ambiguous fallback matches are rejected. Fourteen archive-target probe cases passed.

**Location:** [fsUtils.js:724](E:/Projects/QuiviT/src/js/fsUtils.js:724), especially [fsUtils.js:734](E:/Projects/QuiviT/src/js/fsUtils.js:734), reached through the changed composite-path branch at [fsUtils.js:889](E:/Projects/QuiviT/src/js/fsUtils.js:889).

`loadFile` now passes the inner entry name to `loadArchive`. Its `findIndex` predicate accepts an exact match and a suffix match in the same pass. A nested entry encountered earlier can therefore win before the exact requested entry is examined. This affects Explorer preview opens and existing favorites that use the same composite path.

**Reproduction:** Put `001.jpg` and `chapter/001.jpg` in one archive, choose descending name sort, and request `<archive>|001.jpg`.

**Evidence:** A Node probe imported the real `Core` and `FsUtils` modules, stubbed the archive IPC response, and called `FsUtils.loadFile`. It returned:

```json
{
  "requested": "001.jpg",
  "sort": "name descending",
  "selected": "chapter/001.jpg",
  "list": ["..", "chapter/001.jpg", "001.jpg"]
}
```

**Rule:** Preserve the meaning of shared path contracts and fix downstream consumers in the same change.

**Recommendation:** Resolve exact full or normalized entry identity across the whole list first. Use a suffix fallback only if no exact match exists, with explicit handling for ambiguity.

### B3. [Blocking] A partial File Types failure leaves a stale baseline that can suppress a needed retry

- [x] Fixed and runtime accepted on 2026-10-22. Failure recovery refreshes the actual registration baseline while preserving the requested checkboxes. If that refresh fails, touched extensions remain eligible for retry. All three partial-failure probe scenarios passed.

**Location:** [associationsUi.js:50](E:/Projects/QuiviT/src/js/options/associationsUi.js:50), particularly the all-or-nothing baseline update at [associationsUi.js:58](E:/Projects/QuiviT/src/js/options/associationsUi.js:58).

Unregistration and registration are separate IPC operations. If unregistration succeeds and registration fails, `initialState` still describes the state before either operation. A user who restores the original checkboxes can then save and receive success without restoring the associations that were already removed.

**Reproduction:** Begin with GIF registered and AVIF unregistered. Uncheck GIF and check AVIF. Let unregistration succeed, then make registration fail with the helper-update error. Restore GIF checked and AVIF unchecked, then save again.

**Evidence:** A Node probe imported the real associations UI module, supplied minimal DOM objects, and modeled successful unregistration followed by the helper-update failure. The second save returned:

```json
{
  "first": false,
  "second": true,
  "checked": ["gif"],
  "actualRegistered": []
}
```

The second call performed no repair because both checkboxes matched the stale baseline. The registry operations were mocked; no real file associations were changed.

**Rule:** One authoritative state per concern and stable cross-boundary behavior when an operation fails.

**Recommendation:** Reconcile the baseline from the actual registration state after an error, while preserving the user's requested checkbox state. Updating only after both calls succeed cannot represent a partial result.

### B4. [Blocking] Collapsing an archive folder can leave the preview viewport empty

- [x] Fixed and runtime accepted on 2026-10-22. Mouse down, double-click, and keyboard handlers now clamp scroll before repainting. The native-client-rectangle probe retained ten visible rows after collapse.

**Location:** [com_server.rs:1109](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:1109), the keyboard collapse at [com_server.rs:2218](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:2218), and row painting at [com_server.rs:2585](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:2585).

Folder collapse reduces the visible row count without clamping `archive.scroll`. Painting continues to skip the old number of rows. `clamp_scroll` is called for `WM_SIZE`, but neither the mouse collapse paths nor the keyboard collapse path calls it.

**Reproduction:** Use an archive with 20 root images and a folder containing 100 images. Select the expanded folder, scroll down into its contents without changing the selection, then press Left to collapse that selected folder. The selected folder can be above the viewport when the key is pressed.

**Evidence:** A scratch executable compiled the unmodified archive model and tree functions extracted from this file. Collapsing the selected folder with a ten-row viewport produced:

```text
collapse: rows=21 scroll=50 painted=0 legal_max=11
```

The source-derived probe confirms the invalid model state and the empty paint iterator. The visual result was not reproduced inside Explorer.

**Rule:** Maintain view-local state invariants when the UI changes its own layout.

**Recommendation:** Reconcile scroll bounds after every expansion-state change, before hit testing or painting the resulting row list.

### B5. [Blocking] The preview gate rejects valid legacy TAR files accepted by the archive reader

- [x] Fixed and runtime accepted on 2026-10-22. Archive previews now use the existing archive reader's validation path. Follow-up probes accepted legacy TAR, CBT, and empty TAR inputs and rejected invalid TAR input.

**Location:** [formats.rs:171](E:/Projects/QuiviT/src-tauri/src/formats.rs:171), especially the `ustar` test at [formats.rs:181](E:/Projects/QuiviT/src-tauri/src/formats.rs:181), consumed by [com_server.rs:681](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:681).

The new archive sniffer recognizes TAR only by `ustar`. The existing TAR validator also accepts checksum-valid legacy headers and zero-filled empty archives. `DoPreview` uses the narrower sniffer as a gate, so these supported `.tar` and `.cbt` files never reach the reader. They fall through to the message claiming that the preview is available only for archive types.

**Evidence:** A checksum-valid legacy TAR header without `ustar` was passed to the actual `formats.rs` module and the unmodified existing TAR header validator compiled in a scratch probe:

```text
legacy_tar: reader_accepts=true preview_sniff=None
```

The actual preview dispatch was traced in source; Explorer was not used for this reproduction.

**Rule:** Preserve the domain facade's supported-format contract across a new consumer and reuse existing validation rules.

**Recommendation:** Dispatch file-initialized archive previews through the existing archive-kind and validation path, or share a complete TAR recognition helper. Do not add a second, narrower definition of valid TAR input.

### W1. [Warning] Archive hover and painting allocate and traverse the full expanded tree

- [x] Fixed and runtime accepted on 2026-10-22. Each archive now builds its visible-row cache on the listing worker and reuses its storage when folder expansion changes. Hover, scrolling, selection, and drawing borrow the cache. In the follow-up diagnostic, 100 cached hover and row-read calls on 100,000 entries made zero Rust allocations.

**Location:** [com_server.rs:1103](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:1103), called by [com_server.rs:2085](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:2085) and [com_server.rs:2575](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:2575).

`visible_rows` allocates a new vector and recursively walks every expanded node for every mouse movement. A hover change then invalidates the pane, and painting repeats the same work. Wheel input, selection, and scrollbar handling also rebuild it. Only the final drawing loop is limited to the viewport.

**Evidence:** The unmodified tree functions were compiled with optimization and an allocation-counting global allocator. One hundred `visible_rows` calls for 100,000 flat entries produced 1,600 allocation or reallocation calls and 419,424,000 cumulative allocated bytes. The two probe runs took 148 ms and 203 ms. These are local model measurements, not Explorer frame timings or peak retained memory.

**Rule:** Performance first. Avoid allocations and dynamic work in mousemove and scroll handlers; cache aggressively.

**Recommendation:** Cache the flattened visible rows and invalidate them when archive content or expansion state changes. Hover, hit testing, scrolling, and drawing should reuse that list.

### W2. [Warning] Item initialization leaks the shell-allocated display-name buffer

- [x] Fixed and runtime accepted on 2026-10-22. Item initialization now frees the shell-allocated `PWSTR` via `CoTaskMemFree` on both successful conversion and conversion failure.

**Location:** [com_server.rs:513](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:513) through [com_server.rs:525](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:525).

`IShellItem::GetDisplayName` returns a `PWSTR`. The code converts it into an owned Rust string but never frees the original allocation, including when string conversion fails. The Windows binding's `PWSTR` has no freeing destructor. Each use of `IInitializeWithItem` therefore retains one path buffer until the helper exits.

Microsoft documents the caller's responsibility to release this result with `CoTaskMemFree`. See [IShellItem::GetDisplayName](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishellitem-getdisplayname).

**Evidence limit:** This is a source and API ownership finding. Repeated shell initialization and process-memory growth were not measured.

**Rule:** Keep resource ownership and lifecycle explicit.

**Recommendation:** Use a small scoped owner for the returned task-memory buffer, or free it on every exit after converting it.

### W3. [Warning] The platform preview implementation depends on an IPC command module's asset table

- [x] Fixed and runtime accepted on 2026-10-22. The embedded `FORMAT_ICONS` table was moved to the domain format module (`formats.rs`) with `pub(crate)` visibility. Both `commands::registry` and `platform::previews::windows::com_server` now import it from `crate::formats`, eliminating the platform-to-command dependency.

**Location:** [com_server.rs:1385](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:1385), enabled by the changed visibility at [registry.rs:351](E:/Projects/QuiviT/src-tauri/src/commands/registry.rs:351).

The low-level preview implementation reaches into `commands::registry::FORMAT_ICONS` to obtain embedded format assets. This reverses the documented backend layering: commands adapt platform and domain functionality, while this platform code now depends on the command implementation. The dependency is new even though the asset table already existed.

**Evidence limit:** Static import and ownership review. No runtime failure is asserted.

**Rule:** Rust command files own IPC adaptation. Shared format data and platform behavior belong outside those command implementations.

**Recommendation:** Give the existing embedded format assets a neutral owner, such as the format module, and have both registration and previews use it. This does not require splitting the preview UI owner.

## Redundant code and shared helpers

### W4. [Warning] Archive hit testing repeats the same row and chevron geometry in three handlers

- [x] Fixed and runtime accepted on 2026-10-22. Mouse down, double-click, and mouse move share one hit-test function for rows, chevrons, and scrollbar parts. Painting and input also share indentation and viewport row-count calculations. Native handler diagnostics passed for nested rows, scrollbar controls, navigation, and client bounds.

**Location:** [com_server.rs:2011](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:2011), [com_server.rs:2053](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:2053), and [com_server.rs:2123](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:2123).

Mouse down, double-click, and mouse move independently calculate the row index, indentation, chevron bounds, and whether the node can expand. Scrollbar exclusion and viewport row counts are repeated around those calculations. The formulas currently agree, but later geometry changes must update all copies to keep hover and click targets aligned.

**Rule:** Search for existing helpers and extract an intuitive shared helper when identical operations repeat across callsites.

**Recommendation:** Keep one hit-test helper inside the existing preview owner. Return the row and chevron hit from the cached row list and shared geometry. Do not create sibling UI modules that write the same pane.

## Stale code and references

### N1. [Nit] Stream-materialization comments and ownership branches describe a removed input path

- [x] Fixed and runtime accepted on 2026-10-22. Removed `owns_source` boolean and obsolete temporary-source deletion branches from `Materialized::List` and `ArchivePreview`. Dropped unused `real_path` fallback. Updated documentation comments in `com_server.rs` and `host.rs` to describe file and item initialization plus launch-time staging, while retaining the `--preview-handler` compatibility alias and bumping `PREVIEW_HOST_VERSION` to 8.

**Location:** [com_server.rs:363](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:363), [com_server.rs:651](E:/Projects/QuiviT/src-tauri/src/platform/previews/windows/com_server.rs:651), [formats.rs:168](E:/Projects/QuiviT/src-tauri/src/formats.rs:168), and [host.rs:1](E:/Projects/QuiviT/src-tauri/src/platform/previews/host.rs:1).

The preview handler implements file and item initialization, but its comments still explain keeping a stream proxy on the calling thread and materializing stream data in `DoPreview`. The sniffer comment describes selecting an extension for a nameless stream's temporary file; its current caller already has a file path and uses only whether a signature was found.

The related `Materialized::List(PathBuf, bool)` is constructed only with `false`. The temporary-source deletion branches and separate source-versus-real-path fallback remain even though every current list request supplies the real path. The host module also says staging occurs on consent, although ordinary startup now stages the helper.

**Recommendation:** Remove the obsolete stream-only state and update the Rust comments to describe file and item initialization plus launch-time staging. Retain the old `--preview-handler` flag alias, which has an explicit compatibility purpose.

## Checks performed

| Check | Result | What it establishes |
| --- | --- | --- |
| `cargo check --tests --manifest-path src-tauri/Cargo.toml` | Pass | Current Windows Rust source and test signatures compile. |
| `cargo test --manifest-path src-tauri/Cargo.toml previews -- --nocapture` | 12 passed | Existing helper staging and version-decision tests pass. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --nocapture` | 108 passed | Existing backend library tests, including archives, config, formats, ICO, protocol, and helper tests, pass. |
| `npm run mocha` | 308 passed | Existing frontend tests and scenario/probe contracts pass. |
| `node --check` for all five touched JS files | Pass | Syntax checks pass for the dev launcher, file loader, associations UI, Options controller, and preview player. |
| `git diff --check origin/main...HEAD` with Markdown excluded | Pass | No whitespace errors in the reviewed diff. |
| Actual frontend archive-loader probe | Reproduced B2 | The selected entry can differ from the requested exact entry. |
| Actual associations UI probe with mocked IPC and DOM | Reproduced B3 | Partial failure can leave a silent no-op retry. |
| Actual helper staging module in temporary directories | Reproduced B1 | Concurrent staging can leave a mismatched helper hash and sidecar. |
| Unmodified archive model/tree functions in a scratch executable | Reproduced B4 and measured W1 | Collapse can leave an out-of-range scroll, and row flattening allocates on every call. |
| Actual format module plus unmodified TAR header validator | Reproduced B5 | The new signature gate is narrower than the existing validator. |
| Actual native thumbnail decoder modules | 12 fixtures passed | Four WebP, three APNG, three AVIF, and two SVG files decoded to bounded 256-pixel thumbnails. Still and animated fixtures were included where available. |

The Rust link step emitted `LNK4098`, reporting an `MSVCRTD` default-library conflict. It did not fail the build or tests. Runtime consequences of that linker warning were not established in this review.

The focused Rust probes lived under the system temporary directory. They included the actual modules where accessible; private archive UI functions were copied verbatim from the reviewed source into the probe. Those model probes do not establish native message delivery, focus behavior, or visual rendering in Explorer. No new repository test suite was added.

`e2e/replay-diagnostics/investigation.js` is absent. The existing Mocha diagnostics contract checks passed. No action IDs or viewer pipeline DOM IDs were changed by this branch.

## Touched-file coverage

All paths below are relative to `E:/Projects/QuiviT`.

| Area | Files read | Review focus and result |
| --- | --- | --- |
| Build and launch configuration, 7 files | `.quivit-open-dev`, `.taurignore`, `package.json`, `scripts/dev.js`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.dev.conf.json` | Build alias, embedded frontend launch, separate dev identifier, proxy compilation, and resource removal. No additional finding. |
| Dependencies, 2 files | `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` | New native decoder, SVG renderer, WebView, hashing, and Windows interface dependencies. Type checks and linked tests pass with the linker warning noted above. |
| Shared backend, 7 files | `src-tauri/src/archives/mod.rs`, `src-tauri/src/formats.rs`, `src-tauri/src/ico.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/src/models.rs`, `src-tauri/src/platform/mod.rs` | Archive facade, recognition parity, shared ICO decoding, bootstrap registration, process dispatch, and IPC diagnostics. B5; no additional finding from the ICO or model changes. |
| Registration and app selection, 3 files | `src-tauri/src/commands/registry.rs`, `src-tauri/src/platform/direct_open.rs`, `src-tauri/src/platform/previews/windows.rs` | Registration/unregistration, SVG handler preservation, version gates, launch sync, release/debug selection, and downstream consumers. B1 and W3 dependencies. Registry writes were traced, not exercised against the user's associations. |
| Preview facade and staging, 3 files | `src-tauri/src/platform/previews.rs`, `src-tauri/src/platform/previews/contract.rs`, `src-tauri/src/platform/previews/host.rs` | Stable paths, identifiers, helper/proxy publication, compatibility alias, and sidecar decisions. B1 and N1. |
| Native archive pane, 2 files | `src-tauri/src/platform/previews/windows/com_server.rs`, `src-tauri/src/platform/previews/windows/bitmap.rs` | COM factory lifetime, idle shutdown, deferred tasks, tree construction, selection, scrolling, painting, GDI cleanup, and app-open routing. B4, W1, W2, W3, W4, and N1. |
| Image preview pane, 4 files | `src-tauri/src/platform/previews/windows/image_pane.rs`, `src-tauri/src/platform/previews/windows/preview_player.html`, `src-tauri/src/platform/previews/windows/preview_player.css`, `src-tauri/src/platform/previews/windows/preview_player.js` | Bounded load queue, cancellation, window identity, nested message handling, WebView environment reuse, local protocol, CSP, static DOM, frame disposal, and animation visibility lifecycle. No additional confirmed finding; live WebView behavior remains untested. |
| Thumbnail path, 4 files | `src-tauri/src/platform/previews/thumb_decoders.rs`, `src-tauri/src/platform/previews/avif_sequence.rs`, `src-tauri/src/platform/previews/windows/thumb_proxy.rs`, `src-tauri/src/platform/previews/windows/thumb_server.rs` | Proxy ABI and reference counts, stream budgets, decoder serialization, AVIF sequence parsing, SVG resource restrictions, and pixel conversion. Twelve decoder fixtures pass; Explorer COM activation was not tested. |
| Frontend, 6 files | `src/css/options.css`, `src/index.html`, `src/js/fsUtils.js`, `src/js/options/associationsUi.js`, `src/js/options/options.js`, `src/options.html` | Static confirmation dialog, CSS state, error reporting, changed apply result, composite path routing, and diagnostics DOM contracts. B2 and B3. |
| New tests, 1 file | `src-tauri/src/tests/previews_tests.rs` | All 12 existing staging tests pass. They do not cover simultaneous staging calls or the native preview model. |

## Original review limits

This review did not register or unregister the user's handlers, replace the global staged helper, launch Explorer previews, or run the desktop E2E suite. The pure frontend tests, Rust library tests, and isolated probes do not establish those integration results.

The initial review identified these broader integration checks. The blocker-specific follow-up and user acceptance are recorded separately below:

1. Exercise archive preview selection, folder collapse, scrollbar position, keyboard focus, and opening the chosen page in an existing QuiviT instance. Confirm the requested entry is preserved under each supported sort.
2. Exercise image preview creation, rapid selection changes, cancellation, and resize in Explorer, including GIF/APNG/WebP/AVIF animation, SVG, and the ICO row. Confirm that repeated changes neither retain old panes nor stall the host.
3. Exercise first registration, legacy registration repair, a locked helper update, and removal, including an SVG installation that already has an external preview or thumbnail provider. Confirm partial failures remain visible and retryable.
4. Exercise dev/release switching and concurrent helper updates after B1 is addressed. Confirm EXE bytes, proxy bytes, sidecar hashes, and the advertised version agree after every successful publication.

## Blocking fixes and runtime acceptance

The updated debug application built successfully at `E:/Projects/QuiviT/src-tauri/target/debug/tauri-app.exe`. After the fixes, `cargo check --tests` passed, all 108 Rust library tests and 308 frontend tests passed, both modified JavaScript modules passed syntax checks, and `git diff --check` passed. The focused staging, archive-target, association-recovery, collapse, and archive-dispatch probes also passed.

The user confirmed every item below passed on 2026-10-22:

1. [x] Close Explorer windows and start the updated executable. Preview a registered archive and confirm the updated helper displays its contents.
2. [x] With descending sorting selected in QuiviT, open the root `001.png` and `folder/001.png` from the Explorer preview of `duplicate-pages-and-collapse.cbz`. Confirm the root page is red and the nested page is blue, then repeat with ascending sorting.
3. [x] In File Types, begin with GIF checked and AVIF unchecked. With an Explorer preview open, uncheck GIF, check AVIF, and apply. If a helper update fails, restore the original choices, close Explorer, and retry; confirm GIF registration is restored.
4. [x] In the CBZ preview, select the expanded folder and scroll it above the viewport. Press Left to collapse it and confirm rows remain visible and the scrollbar adjusts. Repeat collapse with Enter and the chevron.
5. [x] Preview the legacy TAR and CBT fixtures and confirm `001.png` appears. Confirm the empty TAR shows zero entries and the invalid TAR reports an error.

## W1 and W4 verification and runtime list

The follow-up changes are confined to the existing native archive pane and the helper version, now 7, so release staging also picks up the updated pane. `cargo check --tests`, all 12 preview tests, all 308 frontend tests, and the debug application build passed. `git diff --check` passed. The preview test link step still reported the previously noted `LNK4098` warning.

The existing temporary native diagnostic was refreshed from the current source. It exercised cache refresh through mouse and keyboard handlers, nested row and chevron hits, scrollbar arrows, track clicks and dragging, wheel input, selection navigation, empty and replacement archives, independent archive caches, and the accepted collapse regression. The app-open function was stubbed in this diagnostic; the user subsequently confirmed page opening in the runtime checks below.

For 100 calls on 100,000 flat entries, the original flattening algorithm made 1,600 allocations or reallocations totaling 419,424,000 cumulative bytes. Cached hover and row reads made zero Rust allocations. This measures the native diagnostic, not Explorer frame times or allocations made by GDI drawing. The actual archive reader also verified the new runtime fixture's 100,000 images and 1,100 folders, and nested collapse and re-expansion preserved the cached row list.

Use `E:/Projects/QuiviT/src-tauri/target/debug/tauri-app.exe`. The runtime fixtures were temporary local files and have since been removed. They are not part of the repository.

The user confirmed all five items passed on 2026-10-22.

1. [x] Close QuiviT and Explorer windows, start the updated executable, then preview `large-archive-tree.cbz` in Explorer. After its list appears, move the pointer over rows, use the wheel, and drag the scrollbar; confirm the pane responds and highlights follow the pointer.
2. [x] Expand and collapse nested folders using their chevrons, labels, double-click, Enter, and Left/Right. Repeat after scrolling and resizing the preview pane; confirm children appear or disappear correctly and rows stay visible.
3. [x] Use the scrollbar arrows, click the track above and below the thumb, and drag the thumb. Confirm these controls scroll the list without selecting or opening an archive entry, and row clicks still match their highlights afterward.
4. [x] Preview `duplicate-pages-and-collapse.cbz`, navigate with Up/Down, Page Up/Page Down, and Home/End, then open pages with Enter and double-click. Confirm root `001.png` opens the red image and `folder/001.png` opens the blue image, including after collapsing and reopening the folder.
5. [x] Keep two Explorer windows previewing different archives and collapse or scroll one list. Confirm the other list stays unchanged, then switch one window to `empty.tar` and back; confirm it shows the new contents without leftover rows.

## W2, W3, and N1 verification and runtime list

The final follow-up addressed the remaining preview findings. Item initialization in `com_server.rs` now releases the shell display-name buffer via `CoTaskMemFree` on all exit paths. The embedded `FORMAT_ICONS` table was relocated to `formats.rs` with `pub(crate)` visibility, removing the platform dependency on an IPC command module. Obsolete stream-materialization comments, the unused `owns_source` deletion flag, and `real_path` fallbacks were removed from `com_server.rs`, while `host.rs` comments were refreshed to reflect launch staging and the helper version was bumped to 8.

All automated checks passed: `cargo check --tests`, 12 preview tests, 12 format tests, 308 frontend tests, `git diff --check`, and the debug application build.

Use `E:/Projects/QuiviT/src-tauri/target/debug/tauri-app.exe`.

The user confirmed all five items passed on 2026-10-22:

1. [x] Close existing QuiviT and Explorer instances. Launch `E:/Projects/QuiviT/src-tauri/target/debug/tauri-app.exe`. Check `%LOCALAPPDATA%\QuiviT\bin\quivit-previews.version` and confirm `preview_version` is 8.
2. [x] Open Windows Explorer with the preview pane visible. Select an archive file (such as `duplicate-pages-and-collapse.cbz`). Confirm the preview displays the archive header and tree contents without delay.
3. [x] Rapidly select different archive and image files in Explorer (alternating 5 to 10 times). Confirm previews switch cleanly on every selection without crashing the preview host.
4. [x] In the archive preview pane, select an entry and press Enter or double-click it. Confirm QuiviT opens the archive, highlights the item in the file panel, and loads the image into the viewer.
5. [x] In QuiviT, press `5` to open Options and navigate to File Types. Confirm file format icons render beside each entry.

## Verdict

**Pass.** All five blocking findings (B1 through B5), all four warning findings (W1 through W4), and the cleanup finding (N1) have passing automated checks and user runtime acceptance.

## Finite raster replay follow-up, 2026-10-22

Validation-rule comparison performed for the later changes to `preview_player.js` and the capability constant in `host.rs`. This is a focused follow-up, not a repeat of the 39-file branch review above. The original verdict and runtime acceptance remain the baseline record.

The player now holds a finite raster track's final frame for at least two seconds before every replay, including its authored final-frame duration in that interval. Infinite tracks retain continuous playback. Loop-boundary deadlines start at actual paint time, and visibility resume waits for the first canvas frame to exist. Capability 9 distributes the embedded change through the existing staging owner. The comparison found no new ownership, IPC, persistence, CSS, or diagnostics-contract violation.

| Check | Result and scope |
| --- | --- |
| Player syntax, Rust type check, whitespace | Pass: `node --check`, `cargo check --tests`, and `git diff --check`. |
| Existing tests | All 308 frontend tests and 12 host staging tests pass. |
| Production-player diagnostic | 21 controlled-clock timing/lifecycle cases pass, including long endings, delayed decode, late callbacks, visibility, static/SVG routing, errors, and unload. |
| Native WebView2 | Eight animated fixtures, covering finite and infinite GIF/WebP/APNG/AVIF, pass two replays each with real decoding and canvas drawing. Four still-image fixtures decode as single frames. |
| Real-clock player timing | Finite WebP/APNG final frames measure 2,002.30/2,002.00 ms; infinite WebP retains its normal cadence. These use timer-driven callbacks in isolated WebView2, not Explorer observations. |
| Application builds | Development and release builds pass and embed the exact current player. Read-only diagnostics from both report capability 9 across 14 rows; isolated E2E launches stage no helper. |

The isolated checks did not change the user's associations or installed helper. The existing debug CRT linker warning remains. The [image spec](image-previews-spec.md#finite-raster-replay-follow-up-2026-10-22) records the automated evidence and both passed Explorer checks. The user confirmed the runtime checks passed on 2026-10-22 and requested documentation finalization.

**Follow-up verdict: Pass.** The finite raster end hold, continuous infinite playback, visibility resume, and file switching have user runtime acceptance. No acceptance checks remain open. This closes the focused follow-up without repeating the original branch-wide review.
