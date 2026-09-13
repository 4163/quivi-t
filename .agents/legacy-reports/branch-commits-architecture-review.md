# Branch commits architecture review

Comprehensive architectural and feature review of all 46 commits on branch `refactor/backend-cl-prep`.

This document contains two distinct sections:
1. **Latest branch state (squashed analysis):** The net architectural and user-facing delta of `main..HEAD` (`5dc42a5`). This resolves all intermediate commit churn (such as temporary cache sizes, pool size adjustments, and flipped defaults) to the final code state currently active on the branch.
2. **Individual commit reports (chronological history):** The historical audit trail of each of the 46 commits evaluated individually against `update-architecture-state` and `update-readme-features`.

---

# Part 1: Latest branch state (squashed analysis)

Evaluating individual commits in isolation can produce stale recommendations when earlier commits are modified or superseded by later commits. The squashed analysis evaluates the net working tree delta between `main` and `HEAD` (`5dc42a5`) across 106 changed files (+15,780, -1,133 lines).

### Superseded intermediate commit states

The following intermediate states appeared in earlier commits but were modified or superseded by later commits on this branch:

1. **Viewer image pool capacity:**
   - Commit `5a11459` expanded the image pool to 10 nodes.
   - Commit `e21b185` reduced the pool to 2 nodes.
   - Commit `c209bf7` settled on **4 nodes** (`VIEWER_IMAGE_POOL_CAPACITY = 4`), retaining neighbor bridge nodes to eliminate WebGL filter flickering during rapid navigation.
   - *Final branch state:* 4 reusable DOM image nodes in [`viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js).
2. **Archive cache working set and memory budget:**
   - Commit `5a11459` lowered the fallback memory budget from 512 MB to 128 MB.
   - Commit `72ef3a3` replaced the multi-archive cache with a **two-archive sliding buffer** (`MAX_OPEN_ARCHIVES = 2`) that retains only the active archive and the immediately preceding archive, paired with PID-scoped temp folders (`%TEMP%\QuiviT\pid-<PID>\<hash>`) and startup/exit cleanup.
   - *Final branch state:* Up to 2 recently opened archives in [`cache.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs).
3. **Spread mode default:**
   - Commit `b46b07b` initially set spread mode default to enabled.
   - Commit `ef2887f` changed spread mode default to **disabled** (`DEFAULT_SPREAD_ENABLED = false`, `DEFAULT_SPREAD_MODE = 'off'`), with reading order `rtl` when toggled on.
   - *Final branch state:* Spread mode is off by default in [`keybinds.js`](file:///E:/Projects/QuiviT/src/js/keybinds.js).
4. **File panel hover preloading:**
   - Commit `5a11459` gated hover preloads with a 15 MB threshold and 150ms debounce.
   - Commit `8e0ea5a` completely deleted speculative hover preloading from [`filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) to eliminate background memory spikes.
   - *Final branch state:* No hover preloading.
5. **Archive protocol caching:**
   - Commit `b80977e` added `Cache-Control: public, max-age=86400` to archive entry protocol responses.
   - Commit `9a779ca` replaced this with `Cache-Control: no-store` in [`protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs) so WebView2 never retains uncompressed archive pages in browser disk or memory caches.
   - *Final branch state:* `no-store` on archive entries.
6. **Thumbnail viewport queue:**
   - Commit `c861544` added an archive-only thumbnail viewport queue.
   - Commit `ac5e3a5` generalized the queue to all constrained heavy-decode thumbnails (`quivit://` and `asset://` 1:1 image assets) in [`filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js).
   - *Final branch state:* Generalized viewport queue sequencing heavy decodes while letting lightweight shell thumbnails (`/thumb/`) load concurrently.

---

### Squashed documentation updates by target

#### 1. Target: `.agents/architecture-state.md`

- **Config & Persistence:**
  - Add newly persisted user preferences to the `quivit_config.json` list:
    - `hide_cursor_delay_sec` (number, inactivity seconds before auto-hiding pointer over viewport; default 2, 0 disables).
    - `file_list_view_mode` (`"list"` or `"thumbnail"`; default `"list"`).
    - `spread_enabled` (boolean; default `false`).
    - `spread_direction` (`"rtl"` or `"ltr"`; default `"rtl"`).
    - `spread_mode` (`"off"`, `"rtl"`, or `"ltr"`; default `"off"`).
  - Document bounded in-memory session caches:
    - `fsUtils.js`: unlocked archive passwords (capacity 50) and encryption statuses (capacity 100) via `BoundedMap`.
    - `filePanel.js`: rendered thumbnail cache (capacity 250) via `BoundedMap`.
    - `cache.rs`: two-archive sliding buffer (`MAX_OPEN_ARCHIVES = 2`) and `zip_index_map` central directory index.
- **CSS:**
  - Document that menubar flyout submenu positioning complies with CSS Source of Truth via CSS custom properties (`--submenu-top`, `--submenu-left`, `--submenu-max-height`) on the submenu host element rather than direct inline style assignments.
- **JavaScript:**
  - `services/`: Add `cache.js` (`BoundedMap`, `BoundedSet`) and `metadataFiles.js` (metadata file priority and exact basename matching) to pure domain services list.
  - `core.js`: Tracks `spreadEnabled`, `spreadDirection`, `spreadStep`, `fileListViewMode`, and `archiveEncryption`.
  - `viewerMath.js`: Handles spread ratio threshold calculation (`naturalWidth / naturalHeight >= 1.2`), half-width scaling, step pan alignment, and `handleViewportResize` retaining manual zoom and pan center across resizes.
  - `filepanel/filePanel.js`: Manages list and thumbnail view modes with card grid virtualization; exports `focusFileList()` and `isFileListFocused()` to maintain single-owner encapsulation.
  - `menubar/statusbar.js`: Dual indicator routing (`.status-spread` in statusbar when visible, `#spread-indicator` viewport overlay when hidden).
  - `main/`: Add `passwordOverlay.js` to single-surface UI modules list (`main/fullscreen.js, dropzone.js, lifecycle.js, metadataBadge.js, passwordOverlay.js: those surfaces only`).
- **Rust:**
  - `commands/`: Document that `list_archive` accepts `password: Option<String>`. Document new Tauri commands: `resolve_archive_temp_origin` and `drop_all_archives_cache`. Pre-existing `drop_archive_cache` unchanged.
  - `models.rs`: Document `FileEntry.size: u64`, `ArchiveEncryptionStatus`, `ArchiveReadResult.encryption`, and `TempArchiveOrigin`.
  - `platform/`: Document `platform/thumbnails.rs` extracting 96x96 Windows shell native thumbnails via `IShellItemImageFactory`, `platform/temp_archive.rs` resolving temporary file extractions from 7 external archivers (Explorer zipfldr, 7-Zip, NanaZip, WinRAR, Bandizip, WinZip, PeaZip), and `platform/attributes.rs` dotfile visibility rule (leading dot does not hide files on Windows unless `FILE_ATTRIBUTE_HIDDEN` is set).
  - `protocol.rs`: Document `quivit://thumb/<base64_path>` thumbnail route, `quivit://icon/...&size=large` 32x32 shell icon route, and `Cache-Control: no-store` response policy on archive entries.
  - `tests/`: Add `temp_archive` and `thumbnails` to in-tree test list.

#### 2. Target: `README.md`

- **`## Features`:**
  - *Archives:* Add support for password-protected archives (ZIP/CBZ, RAR/CBR, 7Z/CB7) with in-app password prompts and bounded session caching. Document JSON metadata support (`comicinfo.json`, `meta.json`, `comet.json`). Document automatic redirection of files opened from external archivers directly into archive mode.
  - *Archive Resilience:* Document microsecond header and boundary validation for ZIP, RAR, 7Z, and TAR archives, rejecting corrupted or truncated files without backward scans or UI freezes, and automatic bypass of locked containers during sibling navigation.
  - *Viewer Controls / Navigation:* Add Manga Spread Mode (two-page reading mode for landscape scans with aspect ratio >= 1.2, half-width fit-to-width, and two-step RTL/LTR reading navigation). Add idle cursor auto-hide after inactivity over viewport. Add thumbnail view mode in file panel with card grid layout.
  - *Windows Integration & Performance:* Document native 96x96 Windows shell thumbnails via `IShellItemImageFactory` and 32x32 shell icons, eliminating full image decodes during directory browsing.
- **`## Shortcuts & Controls`:**
  - Update table category header `Files & Folders` to `File Operations`.
  - Align action labels in table: `Open File / Archive`, `Rotate Counterclockwise`.
  - Document Spacebar behavior: opens directories and archives; no-op on regular files. Document pointer-aware arrow key routing between file list and viewport.
- **`## Documentation -> System Defaults`:**
  - Idle cursor auto-hide: defaults to 2 seconds over viewport (0 to disable). Configurable in **Options → General → Viewport**.
  - Spread View: defaults to `off` (`rtl` reading direction when enabled).
  - File list view mode: defaults to `list`.
  - Sibling navigation skips password-locked or corrupt archive containers without clearing view state or triggering error placeholders.
- **`## Documentation -> Configuration & Persistence`:**
  - Under `quivit_config.json`, add: `hide_cursor_delay_sec`, `file_list_view_mode`, `spread_enabled`, `spread_direction`, and `spread_mode`.
  - Under `In-memory state`:
    - Update `ArchiveCache`: change `up to 8 recently opened archives` to `up to 2 recently opened archives (active archive plus immediately preceding archive)`.
    - Update `#viewer-img-wrapper image bridge`: change `Two reusable DOM images` to `Four reusable DOM images (current target, decoded previous image, and adjacent preloads)`.
    - Add `thumbnailCache` (250 items in `filePanel.js`).
    - Add `fsUtils.js` archive password cache (50 items) and encryption status cache (100 items).
- **`## Documentation -> Architecture`:**
  - Add `cache.js` and `metadataFiles.js` to pure services list.
  - Note list and thumbnail modes in `filepanel/`.
  - Add `passwordOverlay.js` under `main/`.
  - Note native shell thumbnails and external archiver temporary extraction origin resolution under `platform/`.
  - Note dual indicator routing for spread mode between `#statusbar` and `#spread-indicator`.
- **`## Stack`:**
  - Update Windows APIs row to include native shell thumbnail extraction via `IShellItemImageFactory`.
- **`## Project Structure`:**
  - Add `cache.js` and `metadataFiles.js` under `src/js/services/`.
  - Add `passwordOverlay.js` under `src/js/main/`.
  - Update `src-tauri/src/platform/` comment to mention shell thumbnails and temporary archive origin resolution.
  - Update `src/js/metadata.js` comment to mention ComicInfo (XML/JSON), CoMet, OPF, and gallery meta.json parsing.

#### 3. Target: `.agents/skills/blast-radius/SKILL.md`

- **`## QuiviT surfaces to check`:**
  - *IPC commands:* Add `password` parameter on `list_archive`, `resolve_archive_temp_origin`, and `drop_all_archives_cache`. Pre-existing `drop_archive_cache` unchanged. Note `FileEntry.size: u64` and `TempArchiveOrigin` contract.
  - *Protocol URLs:* Add `quivit://thumb/<base64_path>`, `quivit://icon/...&size=large`, and `Cache-Control: no-store` header on archive responses.
  - *Platform & Windowing:* Add `platform/thumbnails.rs` and `platform/temp_archive.rs`.
  - *CSS tokens:* Add `--fs-169`.
  - *Action registry:* Add "Spread View" and "File Operations" categories. Add actions: `cmd-toggle-cursor-autohide`, `cmd-spread-off`, `cmd-spread-direction-rtl`, `cmd-spread-direction-ltr`, `cmd-filter-off`, `cmd-toggle-file-list-view-mode`.
  - *State machine:* Add `spreadEnabled`, `spreadDirection`, `spreadStep`, `fileListViewMode`, and `archiveEncryption`.
- **`### Surface to targeted test matrix`:**
  - `src/js/services/viewerMath.js` -> `node --test src/js/tests/viewerMath.test.mjs`
  - `src/js/core.js` (spread navigation) -> `node --test src/js/tests/coreSpread.test.mjs`
  - `src/js/services/cache.js` -> `node --test src/js/tests/boundedMap.test.mjs`
  - `src/js/services/metadataFiles.js` / `src/js/metadata.js` -> `node --test src/js/tests/metadata.test.mjs`
  - `src-tauri/src/platform/thumbnails.rs` -> `cargo test --manifest-path src-tauri/Cargo.toml thumbnails_`
  - `src-tauri/src/platform/temp_archive.rs` -> `cargo test --manifest-path src-tauri/Cargo.toml temp_archive_`
  - `src-tauri/src/platform/attributes.rs` -> `cargo test --manifest-path src-tauri/Cargo.toml test_is_hidden_path`

#### 4. Target: `.agents/AGENTS.md`

- **`## Architecture Rules`:**
  - No changes required. The branch changes conformed to all rules (pure domain modules, single ownership, HTML-first rendering, CSS source of truth, and modular Rust layering).
- **`## Code Guidelines`:**
  - Guidelines for targeted testing and explicit named cache limits were already directly added in commits `86c5439` and `0e28ee5`.

---

# Part 2: Individual commit reports (chronological history)

Audit trail of all 46 commits on branch `refactor/backend-cl-prep` in order from oldest to newest.

---

### 1. `f252e7e` Moved shelved 7z plan to legacy reports and simplified additions note
- **Files modified:**
  - [`.agents/additions.md`](file:///E:/Projects/QuiviT/.agents/additions.md)
  - [`.agents/legacy-reports/7z_implementation.md`](file:///E:/Projects/QuiviT/.agents/legacy-reports/7z_implementation.md) (renamed from `.agents/7z_implementation.md`)
- **Summary:** Moved archived 7-Zip sidecar plan into `.agents/legacy-reports/` and replaced sidecar text in `additions.md` with an out-of-scope note.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 2. `82566a2` Added CL refactor analysis and archive engine plan
- **Files modified:**
  - [`.agents/cl-refactor-report.md`](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md)
  - [`.agents/slice-1_archive-engine-plan.md`](file:///E:/Projects/QuiviT/.agents/slice-1_archive-engine-plan.md)
- **Summary:** Added component library refactor report and initial implementation plan for Slice 1.
- **Evaluation against update-architecture-state:** No change. Planning docs do not belong in architecture state.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 3. `b1e288a` Added session dbdb4c75 transcript and refined archive engine plan
- **Files modified:**
  - `.agents/session-dbdb4c75.jsonl`
  - [`.agents/slice-1_archive-engine-plan.md`](file:///E:/Projects/QuiviT/.agents/slice-1_archive-engine-plan.md)
- **Summary:** Committed familiarization session transcript and refined Slice 1 constraints.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 4. `7a4e35b` Slice 1: Archive engine optimization & password architecture
- **Files modified:**
  - [`src-tauri/src/models.rs`](file:///E:/Projects/QuiviT/src-tauri/src/models.rs)
  - [`src-tauri/src/commands/archives.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs)
  - [`src-tauri/src/archives/mod.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs)
  - [`src-tauri/src/archives/cache.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs)
  - [`src-tauri/src/archives/zip.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs)
  - [`src-tauri/src/archives/rar.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/rar.rs)
  - [`src-tauri/src/archives/sevenz.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs)
  - [`src-tauri/src/archives/tar.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/tar.rs)
  - [`src-tauri/src/tests/archive_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/archive_tests.rs)
  - [`src-tauri/src/tests/fixtures/make_test_archives.py`](file:///E:/Projects/QuiviT/src-tauri/src/tests/fixtures/make_test_archives.py)
  - [`src/js/core.js`](file:///E:/Projects/QuiviT/src/js/core.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/menubar/statusbar.js`](file:///E:/Projects/QuiviT/src/js/menubar/statusbar.js)
  - `test-files/_archives/encrypted_tests/*`
- **Summary:** Added password decryption across ZIP, RAR, and 7Z archives. Added `ArchiveEncryptionStatus` enum and updated `list_archive` IPC command with optional password parameter. Added O(1) central directory lookup map in `SingleArchiveCache`. Added microsecond header and boundary validation across ZIP, RAR, 7Z, and TAR archives. Added sibling navigation bypass for locked archives.
- **Evaluation against update-architecture-state:** Update `architecture-state.md` with IPC contract changes and `SingleArchiveCache` fields. Update `README.md` System Defaults and Configuration & Persistence. Update `blast-radius/SKILL.md` check surfaces.
- **Evaluation against update-readme-features:** Update `README.md` Features under Archives and Archive Resilience.
- **Warrants doc update:** Yes.

---

### 5. `614bda8` Updated documentation for Slice 1 completion
- **Files modified:**
  - [`.agents/additions.md`](file:///E:/Projects/QuiviT/.agents/additions.md)
  - [`.agents/cl-refactor-report.md`](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`.agents/slice-1_archive-engine-plan.md`](file:///E:/Projects/QuiviT/.agents/slice-1_archive-engine-plan.md)
- **Summary:** Recorded completed Slice 1 tasks in internal agent trackers.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 6. `803bf4d` Added targeted test matrix to blast-radius and verification skills
- **Files modified:**
  - [`.agents/skills/blast-radius/SKILL.md`](file:///E:/Projects/QuiviT/.agents/skills/blast-radius/SKILL.md)
  - [`.agents/skills/update-architecture-state/SKILL.md`](file:///E:/Projects/QuiviT/.agents/skills/update-architecture-state/SKILL.md)
  - [`.agents/skills/verify-implementation/SKILL.md`](file:///E:/Projects/QuiviT/.agents/skills/verify-implementation/SKILL.md)
- **Summary:** Added targeted test matrix directly to skill documents.
- **Evaluation against update-architecture-state:** Direct update already applied in commit.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 7. `86c5439` Added targeted testing guideline to agent rules
- **Files modified:**
  - [`.agents/AGENTS.md`](file:///E:/Projects/QuiviT/.agents/AGENTS.md)
- **Summary:** Added targeted testing rule under `## Code Guidelines` in `AGENTS.md`.
- **Evaluation against update-architecture-state:** Direct update already applied in commit.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 8. `6f86d86` Added Slice 2 viewer core plan and marked CL items as pending
- **Files modified:**
  - [`.agents/cl-refactor-report.md`](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md)
  - [`.agents/slice-2_viewer-core-plan.md`](file:///E:/Projects/QuiviT/.agents/slice-2_viewer-core-plan.md)
- **Summary:** Outlined Slice 2 plan for viewport stability, config decoupling, and cursor auto-hide.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 9. `5a11459` Slice 2: Viewer engine core - transform stability, config decoupling & viewport lifecycle
- **Files modified:**
  - `package.json`
  - [`src-tauri/src/models.rs`](file:///E:/Projects/QuiviT/src-tauri/src/models.rs)
  - [`src-tauri/src/commands/directory.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands/directory.rs)
  - [`src-tauri/src/archives/rar.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/rar.rs), [`sevenz.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs), [`tar.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/tar.rs), [`zip.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs)
  - [`src-tauri/src/lib.rs`](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)
  - [`src/css/main.css`](file:///E:/Projects/QuiviT/src/css/main.css), [`options.css`](file:///E:/Projects/QuiviT/src/css/options.css)
  - [`src/options.html`](file:///E:/Projects/QuiviT/src/options.html), [`src/js/options/options.js`](file:///E:/Projects/QuiviT/src/js/options/options.js)
  - [`src/js/core.js`](file:///E:/Projects/QuiviT/src/js/core.js)
  - [`src/js/services/viewerMath.js`](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js)
  - [`src/js/viewer/viewer.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewer.js), [`viewerGestures.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js), [`viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/services/actions.js`](file:///E:/Projects/QuiviT/src/js/services/actions.js), [`keybinds.js`](file:///E:/Projects/QuiviT/src/js/keybinds.js)
  - [`src/js/tests/viewerMath.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/viewerMath.test.mjs)
- **Summary:** Added idle cursor auto-hide timer (`hide_cursor_delay_sec`) and action `cmd-toggle-cursor-autohide`. Retained manual zoom/pan across resize events via `handleViewportResize`. Exposed `size: u64` on `FileEntry`. Added native Node test suite for `viewerMath.js`. Expanded image pool to 10 nodes (superseded by `c209bf7`). Lowered archive cache budget fallback to 128 MB (superseded by `72ef3a3`).
- **Evaluation against update-architecture-state:** Update `architecture-state.md` with `hide_cursor_delay_sec` and `FileEntry.size`. Update `README.md` System Defaults, Configuration & Persistence, and Project Structure. Update `blast-radius/SKILL.md` test matrix with `npm test`.
- **Evaluation against update-readme-features:** Update `README.md` Features under Viewer Controls with idle cursor auto-hide.
- **Warrants doc update:** Yes.

---

### 10. `6273dc9` Updated documentation for Slice 2 completion
- **Files modified:**
  - [`.agents/additions.md`](file:///E:/Projects/QuiviT/.agents/additions.md)
  - [`.agents/cl-refactor-report.md`](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`.agents/slice-2_viewer-core-plan.md`](file:///E:/Projects/QuiviT/.agents/slice-2_viewer-core-plan.md)
- **Summary:** Recorded Slice 2 completion in internal agent trackers.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 11. `a86c27e` Added Slice 3 spread mode plan and backlog reorganization
- **Files modified:**
  - [`.agents/additions.md`](file:///E:/Projects/QuiviT/.agents/additions.md)
  - [`.agents/cl-refactor-report.md`](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md)
  - [`.agents/slice-3_spread-mode-plan.md`](file:///E:/Projects/QuiviT/.agents/slice-3_spread-mode-plan.md)
- **Summary:** Created specification for manga spread mode and navigation ergonomics.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 12. `b46b07b` Slice 3: Manga spread mode & navigation ergonomics
- **Files modified:**
  - [`src-tauri/src/platform/attributes.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/attributes.rs)
  - [`src/css/main.css`](file:///E:/Projects/QuiviT/src/css/main.css), [`options.css`](file:///E:/Projects/QuiviT/src/css/options.css)
  - [`src/index.html`](file:///E:/Projects/QuiviT/src/index.html)
  - [`src/js/core.js`](file:///E:/Projects/QuiviT/src/js/core.js)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/keybinds.js`](file:///E:/Projects/QuiviT/src/js/keybinds.js), [`shortcuts.js`](file:///E:/Projects/QuiviT/src/js/shortcuts.js), [`services/actions.js`](file:///E:/Projects/QuiviT/src/js/services/actions.js)
  - [`src/js/main/main.js`](file:///E:/Projects/QuiviT/src/js/main/main.js)
  - [`src/js/menubar.js`](file:///E:/Projects/QuiviT/src/js/menubar.js), [`menubar/chrome.js`](file:///E:/Projects/QuiviT/src/js/menubar/chrome.js), [`menubar/statusbar.js`](file:///E:/Projects/QuiviT/src/js/menubar/statusbar.js)
  - [`src/js/options/options.js`](file:///E:/Projects/QuiviT/src/js/options/options.js), [`options.html`](file:///E:/Projects/QuiviT/src/options.html)
  - [`src/js/services/viewerMath.js`](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js)
  - [`src/js/viewer/viewerGestures.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js), [`viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
  - [`src/js/tests/coreSpread.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/coreSpread.test.mjs), [`viewerMath.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/viewerMath.test.mjs)
  - [`test-files/spread_test_white.png`](file:///E:/Projects/QuiviT/test-files/spread_test_white.png)
- **Summary:** Added Manga Spread Mode (aspect ratio >= 1.2 detection, half-width scaling, two-step RTL/LTR reading navigation, dual status indicators). Updated Windows hidden path check in `attributes.rs` so leading dot does not hide files. Added desktop navigation ergonomics (Space opens containers, no-ops on files; pointer-aware navigation).
- **Evaluation against update-architecture-state:** Update `architecture-state.md` with spread state, geometry, dual indicator routing, and dotfile rules. Update `README.md` Features, Shortcuts & Controls, System Defaults, Configuration & Persistence, Architecture, and Project Structure. Update `blast-radius/SKILL.md`.
- **Evaluation against update-readme-features:** Update `README.md` Features with Manga Spread Mode and desktop navigation ergonomics. Update Shortcuts & Controls.
- **Warrants doc update:** Yes.

---

### 13. `b350ee3` Updated documentation for Slice 3 completion
- **Files modified:**
  - [`.agents/additions.md`](file:///E:/Projects/QuiviT/.agents/additions.md)
  - [`.agents/cl-refactor-report.md`](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`.agents/slice-3_spread-mode-plan.md`](file:///E:/Projects/QuiviT/.agents/slice-3_spread-mode-plan.md)
- **Summary:** Updated internal slice tracking and recorded verification passes.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 14. `f16de31` Refactored menubar with split View/Image menus and flyout submenus
- **Files modified:**
  - [`src/index.html`](file:///E:/Projects/QuiviT/src/index.html)
  - [`src/css/main.css`](file:///E:/Projects/QuiviT/src/css/main.css)
  - [`src/js/main/passwordOverlay.js`](file:///E:/Projects/QuiviT/src/js/main/passwordOverlay.js)
  - [`src/js/menubar.js`](file:///E:/Projects/QuiviT/src/js/menubar.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/core.js`](file:///E:/Projects/QuiviT/src/js/core.js)
  - [`src/js/main/main.js`](file:///E:/Projects/QuiviT/src/js/main/main.js)
  - [`src/js/services/actions.js`](file:///E:/Projects/QuiviT/src/js/services/actions.js), [`shortcuts.js`](file:///E:/Projects/QuiviT/src/js/shortcuts.js)
  - [`src-tauri/src/tests/archive_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/archive_tests.rs)
  - `test-files/_archives/encrypted_tests/*`
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/validation-report.md`
- **Summary:** Added pure CSS flyout submenus with mouse-aim safe triangle algorithm and keyboard navigation. Created `passwordOverlay.js` module for in-app password prompts. Registered actions `cmd-spread-off`, `cmd-spread-direction-rtl`, `cmd-spread-direction-ltr`, and `cmd-filter-off`.
- **Evaluation against update-architecture-state:** Update `architecture-state.md` under `main/` with `passwordOverlay.js`. Update `README.md` Architecture and Project Structure. Update `blast-radius/SKILL.md` action list.
- **Evaluation against update-readme-features:** Update `README.md` Features with password-protected archive prompt support and flyout submenus.
- **Warrants doc update:** Yes.

---

### 15. `6139fc0` Cleanup and refinements for menubar and validation documentation
- **Files modified:**
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`.agents/slice-3_spread-mode-plan.md`](file:///E:/Projects/QuiviT/.agents/slice-3_spread-mode-plan.md)
  - `.agents/validation-report.md`
  - [`src/css/main.css`](file:///E:/Projects/QuiviT/src/css/main.css)
  - [`src/js/menubar.js`](file:///E:/Projects/QuiviT/src/js/menubar.js)
  - [`src/js/options/options.js`](file:///E:/Projects/QuiviT/src/js/options/options.js)
- **Summary:** Cleaned up dead CSS selector, removed unused export alias, and updated validation notes.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 16. `3e9b6e0` Password-protected archive UI and architectural hardening
- **Files modified:**
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/main/passwordOverlay.js`](file:///E:/Projects/QuiviT/src/js/main/passwordOverlay.js)
  - [`src/js/main/main.js`](file:///E:/Projects/QuiviT/src/js/main/main.js)
  - [`src/js/menubar.js`](file:///E:/Projects/QuiviT/src/js/menubar.js)
  - [`src/css/main.css`](file:///E:/Projects/QuiviT/src/css/main.css)
  - [`src/js/tests/boundedMap.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/boundedMap.test.mjs)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`.agents/legacy-reports/archive-password-menubar-validation.md`](file:///E:/Projects/QuiviT/.agents/legacy-reports/archive-password-menubar-validation.md)
  - `.agents/validation-report.md`
- **Summary:** Added `BoundedMap` with FIFO eviction in `fsUtils.js` for unlocked passwords (capacity 50) and encryption statuses (capacity 100). Encapsulated file list focus with callbacks (`focusFileList`, `isFileListFocused`) in `filePanel.js`. Bound submenu positioning to CSS custom properties (`--submenu-top`, `--submenu-left`, `--submenu-max-height`). Added unit tests for `BoundedMap`.
- **Evaluation against update-architecture-state:** Update `architecture-state.md` with `fsUtils.js` session caches, CSS custom properties rule for submenus, and focus encapsulation. Update `README.md` In-memory state and Project Structure (`boundedMap.test.mjs`). Update `blast-radius/SKILL.md`.
- **Evaluation against update-readme-features:** Update `README.md` Features under Archives noting bounded in-memory password caching.
- **Warrants doc update:** Yes.

---

### 17. `ef2887f` Spread mode refinements and Slice 4 thumbnail view plan
- **Files modified:**
  - `.agents/slice-4_thumbnail-view-plan.md`
  - [`src/index.html`](file:///E:/Projects/QuiviT/src/index.html)
  - [`src/js/core.js`](file:///E:/Projects/QuiviT/src/js/core.js)
  - [`src/js/keybinds.js`](file:///E:/Projects/QuiviT/src/js/keybinds.js)
  - [`src/js/menubar.js`](file:///E:/Projects/QuiviT/src/js/menubar.js), [`menubar/statusbar.js`](file:///E:/Projects/QuiviT/src/js/menubar/statusbar.js)
  - [`src/js/options/options.js`](file:///E:/Projects/QuiviT/src/js/options/options.js)
  - [`src/js/services/viewerMath.js`](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js)
  - [`src/js/tests/coreSpread.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/coreSpread.test.mjs), [`viewerMath.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/viewerMath.test.mjs)
- **Summary:** Switched spread mode default from enabled to disabled (`off`, reading order `rtl` when enabled). Added dynamic readout label `#spread-current-label` in View menu.
- **Evaluation against update-architecture-state:** Update `README.md` System Defaults for spread mode.
- **Evaluation against update-readme-features:** Update `README.md` Features to list Spread View.
- **Warrants doc update:** Yes.

---

### 18. `851f884` Slice 4: File panel thumbnail view mode & high-resolution shell icons
- **Files modified:**
  - `.agents/slice-4_thumbnail-view-plan.md`
  - [`src-tauri/src/commands/registry.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands/registry.rs)
  - [`src-tauri/src/platform/icons.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/icons.rs)
  - [`src-tauri/src/protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
  - [`src-tauri/src/tests/protocol_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/protocol_tests.rs)
  - [`src/css/main.css`](file:///E:/Projects/QuiviT/src/css/main.css)
  - [`src/index.html`](file:///E:/Projects/QuiviT/src/index.html)
  - [`src/js/core.js`](file:///E:/Projects/QuiviT/src/js/core.js)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/keybinds.js`](file:///E:/Projects/QuiviT/src/js/keybinds.js)
  - [`src/js/menubar.js`](file:///E:/Projects/QuiviT/src/js/menubar.js)
  - [`src/js/services/actions.js`](file:///E:/Projects/QuiviT/src/js/services/actions.js)
  - [`src/js/tests/fileListViewMode.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/fileListViewMode.test.mjs)
- **Summary:** Added thumbnail view mode to file panel with toggle button, card grid layout, and action `cmd-toggle-file-list-view-mode`. Added 32x32 shell icon extraction via `quivit://icon/...&size=large`.
- **Evaluation against update-architecture-state:** Update `README.md` System Defaults (`file_list_view_mode: "list"`), Configuration & Persistence, and Architecture. Update `blast-radius/SKILL.md` check surfaces.
- **Evaluation against update-readme-features:** Update `README.md` Features with thumbnail view mode and 32x32 shell icons.
- **Warrants doc update:** Yes.

---

### 19. `a072f06` Slice 4.1: File list virtualization optimization
- **Files modified:**
  - [`.agents/legacy-reports/cl-prep/slice-4.1_file-list-virtualization-plan.md`](file:///E:/Projects/QuiviT/.agents/legacy-reports/cl-prep/slice-4.1_file-list-virtualization-plan.md)
  - [`src/css/main.css`](file:///E:/Projects/QuiviT/src/css/main.css)
  - [`src/index.html`](file:///E:/Projects/QuiviT/src/index.html)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/tests/fileListViewMode.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/fileListViewMode.test.mjs)
- **Summary:** Refactored file list virtualization to an on-demand RowCache pool with overscan and pre-allocated icon elements.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 20. `402bf53` Slice 4.2: View menu, keybinds and refresh UX
- **Files modified:**
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`src-tauri/src/commands/archives.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs)
  - [`src-tauri/src/lib.rs`](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)
  - [`src/css/global.css`](file:///E:/Projects/QuiviT/src/css/global.css), [`main.css`](file:///E:/Projects/QuiviT/src/css/main.css)
  - [`src/index.html`](file:///E:/Projects/QuiviT/src/index.html)
  - [`src/js/core.js`](file:///E:/Projects/QuiviT/src/js/core.js)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/menubar.js`](file:///E:/Projects/QuiviT/src/js/menubar.js), [`menubar/statusbar.js`](file:///E:/Projects/QuiviT/src/js/menubar/statusbar.js)
  - [`src/js/services/actions.js`](file:///E:/Projects/QuiviT/src/js/services/actions.js), [`shortcuts.js`](file:///E:/Projects/QuiviT/src/js/shortcuts.js)
  - [`src/js/tests/coreSpread.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/coreSpread.test.mjs), [`menubarShortcuts.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/menubarShortcuts.test.mjs), [`refresh.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/refresh.test.mjs), [`statusbar.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/statusbar.test.mjs)
  - [`src/js/viewer/viewerGestures.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js), [`viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
  - [`src/options.html`](file:///E:/Projects/QuiviT/src/options.html)
  - Test archive fixtures
- **Summary:** Added `drop_archive_cache` Tauri command (pre-existing, not new). Added CSS token `--fs-169`. Reorganized action categories: created "Spread View", renamed "Files & Folders" to "File Operations", and aligned action labels. Added refresh sweep animation.
- **update-architecture-state:** Update `blast-radius/SKILL.md` with `drop_archive_cache` (pre-existing, not new), `--fs-169`, and updated action category names.
- **update-readme-features:** Update `README.md` Shortcuts & Controls table header `Files & Folders` to `File Operations` and align action labels.
- **Warrants doc update:** Yes.

---

### 21. `4bbf220` Added Slice 4.3 thumbnail optimization plans
- **Files modified:**
  - `.agents/legacy-reports/cl-prep/slice-4.3.1_scroll-debounce-and-placeholders-plan.md`
  - `.agents/legacy-reports/cl-prep/slice-4.3.2_windows-shell-thumbnails-plan.md`
  - `.agents/legacy-reports/cl-prep/slice-4.3.3_archive-thumbnails-plan.md`
  - `.agents/legacy-reports/cl-prep/slice-4.3_thumbnail-optimization-plan.md`
- **Summary:** Added planning roadmap documents for thumbnail optimization passes.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 22. `1edb637` Slice 4.3.1: Scroll debouncing, placeholders and thumbnail cache
- **Files modified:**
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/legacy-reports/cl-prep/slice-4.3.1_scroll-debounce-and-placeholders-plan.md`
  - `.agents/legacy-reports/cl-prep/slice-4.3_thumbnail-optimization-plan.md`
  - [`src-tauri/src/protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
  - [`src/css/main.css`](file:///E:/Projects/QuiviT/src/css/main.css)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/services/cache.js`](file:///E:/Projects/QuiviT/src/js/services/cache.js)
  - [`src/js/tests/boundedMap.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/boundedMap.test.mjs), [`fileListViewMode.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/fileListViewMode.test.mjs), [`refresh.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/refresh.test.mjs)
- **Summary:** Created reusable service module `src/js/services/cache.js` exporting `BoundedMap`. Added in-memory `thumbnailCache` (capacity 250) in `filePanel.js`. Added 100ms scroll settling debounce. Added pre-allocated SVG skeleton placeholders for row icons. Added `Cache-Control` header to `protocol.rs`.
- **update-architecture-state:** Update `architecture-state.md` with `cache.js` under `services/`. Update `README.md` Project Structure, Architecture, and Configuration & Persistence. Update `blast-radius/SKILL.md`.
- **update-readme-features:** No change.
- **Warrants doc update:** Yes.

---

### 23. `3477d00` Added Playwright directories to .gitignore
- **Files modified:**
  - [`.gitignore`](file:///E:/Projects/QuiviT/.gitignore)
- **Summary:** Added Playwright artifact folders to `.gitignore`.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 24. `c69bbb7` Slice 4.3.2: Windows shell native thumbnails
- **Files modified:**
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/legacy-reports/cl-prep/slice-4.3.2_windows-shell-thumbnails-plan.md`
  - `.agents/legacy-reports/cl-prep/slice-4.3_thumbnail-optimization-plan.md`
  - [`src-tauri/src/lib.rs`](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)
  - [`src-tauri/src/platform/mod.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/mod.rs), [`thumbnails.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/thumbnails.rs)
  - [`src-tauri/src/protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
  - [`src-tauri/src/tests/protocol_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/protocol_tests.rs), [`thumbnails_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/thumbnails_tests.rs)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/tests/fileListViewMode.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/fileListViewMode.test.mjs)
- **Summary:** Added `src-tauri/src/platform/thumbnails.rs` extracting 96x96 Windows shell native thumbnails via `IShellItemImageFactory`. Added `quivit://thumb/<base64_path>` protocol route. Added universal format routing in `FsUtils.buildShellThumbnailSrc`. Added unit tests in `thumbnails_tests.rs`.
- **update-architecture-state:** Update `architecture-state.md` (`platform/thumbnails.rs` and `quivit://thumb/`). Update `README.md` Architecture, Project Structure, and Stack. Update `blast-radius/SKILL.md` surfaces list and test matrix.
- **update-readme-features:** Update `README.md` Features under Windows Integration and Performance.
- **Warrants doc update:** Yes.

---

### 25. `c821b1f` Cleaned up punctuation and wording in comments and docs
- **Files modified:**
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/legacy-reports/*`
  - [`src-tauri/src/platform/thumbnails.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/thumbnails.rs)
  - [`src/js/options/keybindUi.js`](file:///E:/Projects/QuiviT/src/js/options/keybindUi.js), [`options.js`](file:///E:/Projects/QuiviT/src/js/options/options.js)
  - [`src/js/services/filters/anime4k/chains.js`](file:///E:/Projects/QuiviT/src/js/services/filters/anime4k/chains.js)
  - [`src/js/viewer/viewerPipelines.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerPipelines.js)
- **Summary:** Replaced em dashes with periods and colons in code comments and planning documents.
- **Evaluation against update-architecture-state:** No change.
- **Evaluation against update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 26. `0e28ee5` Updated slice plans and documented cache limits
- **Files modified:**
  - [`.agents/AGENTS.md`](file:///E:/Projects/QuiviT/.agents/AGENTS.md)
  - `.agents/legacy-reports/cl-prep/slice-4.3.3_archive-thumbnails-plan.md`
  - `.agents/legacy-reports/cl-prep/slice-4.3_thumbnail-optimization-plan.md`
  - `.agents/legacy-reports/cl-prep/slice-4.4_thumbnail-viewer-cache-plan.md`
- **Summary:** Added rule 6 ("Explicit Named Cache Limits") to `AGENTS.md` Code Guidelines and updated planning files.
- **update-architecture-state:** Direct update already applied in commit.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 27. `b80977e` Slice 4.4: Thumbnail polish and viewer cache
- **Files modified:**
  - [`.agents/cl-refactor-report.md`](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md)
  - `.agents/legacy-reports/cl-prep/slice-4.4_thumbnail-viewer-cache-plan.md`
  - [`src-tauri/src/platform/thumbnails.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/thumbnails.rs)
  - [`src-tauri/src/protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
  - [`src-tauri/src/tests/thumbnails_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/thumbnails_tests.rs)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/shared/blobImage.js`](file:///E:/Projects/QuiviT/src/js/shared/blobImage.js)
  - [`src/js/viewer/viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
- **Summary:** Bypassed shell extraction for animated GIFs. Inspected headers for PNG/GIF/ICO transparency to reject black-matted shell thumbnails. Bound `blobImage.js` cache capacity to 6. Shared 1:1 archive thumbnail blob URLs between file panel and viewer.
- **update-architecture-state:** No change. Internal rendering polish and cache sharing.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 28. `066b05c` Added package and bundle metadata for publishing
- **Files modified:**
  - [`src-tauri/Cargo.toml`](file:///E:/Projects/QuiviT/src-tauri/Cargo.toml)
  - [`src-tauri/tauri.conf.json`](file:///E:/Projects/QuiviT/src-tauri/tauri.conf.json)
- **Summary:** Added package license, repository, homepage, and bundle metadata for release builds.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 29. `1f3553d` Fixed ZIP header validation to allow offset archives
- **Files modified:**
  - [`src-tauri/src/archives/zip.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs)
- **Summary:** Allowed opening self-extracting (SFX) archives and archives with prepended headers by checking EOCD records first.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 30. `39dd0f9` Removed em dashes from slice-4.4, fsUtils, filePanel and viewerRender
- **Files modified:**
  - `.agents/legacy-reports/cl-prep/slice-4.4_thumbnail-viewer-cache-plan.md`
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/viewer/viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
- **Summary:** Replaced em dashes with commas and periods in source comments and planning text.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 31. `bfe1057` Fixed PowerToys FancyZones snapping support
- **Files modified:**
  - [`src-tauri/capabilities/default.json`](file:///E:/Projects/QuiviT/src-tauri/capabilities/default.json)
  - [`src/index.html`](file:///E:/Projects/QuiviT/src/index.html)
- **Summary:** Added `data-tauri-drag-region` to menubar spacer and enabled native window dragging capability so FancyZones can snap windows.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 32. `d131378` Slice 5: Additional metadata formats
- **Files modified:**
  - [`src/js/services/metadataFiles.js`](file:///E:/Projects/QuiviT/src/js/services/metadataFiles.js) (new)
  - [`src-tauri/src/platform/temp_archive.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/temp_archive.rs) (new)
  - [`src-tauri/src/tests/temp_archive_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/temp_archive_tests.rs) (new)
  - [`src/js/tests/metadata.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/metadata.test.mjs), [`sorting.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/sorting.test.mjs)
  - [`src-tauri/src/models.rs`](file:///E:/Projects/QuiviT/src-tauri/src/models.rs)
  - [`src-tauri/src/commands/archives.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs)
  - [`src-tauri/src/lib.rs`](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)
  - [`src/js/metadata.js`](file:///E:/Projects/QuiviT/src/js/metadata.js), [`fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js), [`services/sorting.js`](file:///E:/Projects/QuiviT/src/js/services/sorting.js)
  - [`src-tauri/src/archives/mod.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs)
  - [`src/js/core.js`](file:///E:/Projects/QuiviT/src/js/core.js)
  - [`src/js/viewer/viewerPipelines.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerPipelines.js), [`viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
- **Summary:** Added `metadataFiles.js` service defining metadata priority. Extended `metadata.js` to parse JSON metadata payloads (`comicinfo.json`, `meta.json`, `comet.json`). Added `platform/temp_archive.rs` detecting temporary extraction directories from 7 external archivers (Explorer, 7-Zip, NanaZip, WinRAR, Bandizip, WinZip, PeaZip). Added `resolve_archive_temp_origin` IPC command and `TempArchiveOrigin` model. Centralized root-before-nested entry sorting in `archives/mod.rs`.
- **update-architecture-state:** Update `architecture-state.md` with `metadataFiles.js`, `temp_archive.rs`, `resolve_archive_temp_origin`, and `TempArchiveOrigin`. Update `README.md` Project Structure and Architecture. Update `blast-radius/SKILL.md` check surfaces and test matrix.
- **update-readme-features:** Update `README.md` Features under Archives with expanded metadata formats and external archiver temp file redirection.
- **Warrants doc update:** Yes.

---

### 33. `4f73aa2` Documented memory leak investigation findings
- **Files modified:**
  - `.agents/legacy-reports/performance/memory-leak-investigation-2026-09-12.md`
  - `.agents/legacy-reports/performance/memory-leak-technical-facts-2026-09-12.md`
- **Summary:** Added technical investigation notes regarding WebView2 memory behavior.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 34. `f551d84` Fixed frontend memory leaks in thumbnails and viewer
- **Files modified:**
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/services/cache.js`](file:///E:/Projects/QuiviT/src/js/services/cache.js)
  - [`src/js/services/pipelines/glRuntime.js`](file:///E:/Projects/QuiviT/src/js/services/pipelines/glRuntime.js)
  - [`src/js/services/scaling/lanczos.js`](file:///E:/Projects/QuiviT/src/js/services/scaling/lanczos.js)
  - [`src/js/shared/blobImage.js`](file:///E:/Projects/QuiviT/src/js/shared/blobImage.js)
  - [`src/js/viewer/viewerPipelines.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerPipelines.js), [`viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
  - [`src/js/tests/blobImage.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/blobImage.test.mjs), [`boundedMap.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/boundedMap.test.mjs), [`fileListViewMode.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/fileListViewMode.test.mjs)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/legacy-reports/performance/*`
- **Summary:** Added `onEvict` callback in `cache.js` to revoke object URLs. Added `AbortController` in-flight archive fetch cancellation. Budgeted archive thumbnail generation. Added `getCleanImageCrop` in `blobImage.js` and cropped bitmaps before Lanczos scaling.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 35. `35ed9c0` Archived completed slice plans to legacy-reports/cl-prep
- **Files modified:**
  - 14 markdown files moved to `.agents/legacy-reports/cl-prep/`
  - [`.agents/skills/familiarize/SKILL.md`](file:///E:/Projects/QuiviT/.agents/skills/familiarize/SKILL.md)
- **Summary:** Moved completed slice plans into legacy reports and cleaned up `familiarize` skill.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 36. `8e0ea5a` Removed hover preload from file panel
- **Files modified:**
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/legacy-reports/performance/*`
- **Summary:** Deleted speculative hover preload state and listeners from `filePanel.js` to eliminate background decode memory spikes.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 37. `9a779ca` Set archive responses to no-store cache control
- **Files modified:**
  - [`src-tauri/src/protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
  - [`src-tauri/src/tests/protocol_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/protocol_tests.rs)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/legacy-reports/performance/*`
- **Summary:** Served archive entries with `Cache-Control: no-store` header to prevent WebView2 memory and disk caching of uncompressed pages.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 38. `e21b185` Reduced viewer pool to two DOM nodes
- **Files modified:**
  - [`src/js/viewer/viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/legacy-reports/performance/*`
- **Summary:** Reduced `VIEWER_IMAGE_POOL_CAPACITY` from 4 to 2 (superseded by `c209bf7`).
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 39. `f1335c3` Streamed header reads and bounded metadata caches
- **Files modified:**
  - [`src-tauri/src/archives/mod.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs)
  - [`src/js/core.js`](file:///E:/Projects/QuiviT/src/js/core.js)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/services/cache.js`](file:///E:/Projects/QuiviT/src/js/services/cache.js)
  - [`src/js/viewer/viewerPipelines.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerPipelines.js)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/legacy-reports/performance/*`
- **Summary:** Streamed temporary file header reads via `take()` in `archives/mod.rs` to eliminate full-file memory spikes during animation detection. Added `BoundedSet` to `cache.js`. Bounded `_animMemo` in `core.js` and `animatedSvgSrcs` in `filePanel.js` to 512 entries. Zeroed staging canvas dimensions in `_stopLivePump()`.
- **update-architecture-state:** No change. Internal streaming reads and cache capacity bounds.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 40. `c209bf7` Restored viewer bridge retention and 4-node pool
- **Files modified:**
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/viewer/viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
- **Summary:** Restored `VIEWER_IMAGE_POOL_CAPACITY` to 4 and retained neighbor entries in `desiredSrcs` to prevent filter flickering. Removed animation state reload trigger from `activeChanged`.
- **update-architecture-state:** No change. Settled the DOM pool at 4 nodes.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 41. `9ccdb04` Added archive refactor tracker and archived investigation docs
- **Files modified:**
  - [`.agents/legacy-reports/performance/archive-resource-refactor.md`](file:///E:/Projects/QuiviT/.agents/legacy-reports/performance/archive-resource-refactor.md)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - `.agents/legacy-reports/performance/*`
- **Summary:** Created archive refactor implementation tracker and archived memory leak investigation writeups.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 42. `7619fb8` Added scratch directory to ignore list
- **Files modified:**
  - [`.gitignore`](file:///E:/Projects/QuiviT/.gitignore)
- **Summary:** Added `scratch/` to `.gitignore`.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 43. `72ef3a3` Added two-archive sliding buffer and PID temp cleanup
- **Files modified:**
  - [`.agents/legacy-reports/performance/archive-resource-refactor.md`](file:///E:/Projects/QuiviT/.agents/legacy-reports/performance/archive-resource-refactor.md)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`.gitignore`](file:///E:/Projects/QuiviT/.gitignore)
  - [`src-tauri/src/archives/cache.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs)
  - [`src-tauri/src/commands/archives.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs)
  - [`src-tauri/src/lib.rs`](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)
  - [`src-tauri/src/tests/archive_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/archive_tests.rs)
- **Summary:** Capped `MAX_OPEN_ARCHIVES = 2` in `cache.rs`, establishing a two-archive sliding window (active archive plus preceding archive) to eliminate back-navigation 404 races. Added `drop_all_archives_cache` IPC command. Scoped extraction to `%TEMP%\QuiviT\pid-<PID>\<hash>` with process liveness lock. Added startup cleanup of orphaned temp folders and exit cleanup. Added unit test `temp_lock_lifecycle_cleans_on_exit`.
- **update-architecture-state:** Update `README.md` under `Configuration & Persistence` -> `In-memory state` from 8 archives to 2 archives. Update `blast-radius/SKILL.md` with `drop_all_archives_cache`.
- **update-readme-features:** No change.
- **Warrants doc update:** Yes.

---

### 44. `c861544` Added viewport-bound archive thumbnail queue
- **Files modified:**
  - [`.agents/legacy-reports/performance/archive-resource-refactor.md`](file:///E:/Projects/QuiviT/.agents/legacy-reports/performance/archive-resource-refactor.md)
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
  - [`src/js/tests/fileListViewMode.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/fileListViewMode.test.mjs)
- **Summary:** Confined archive thumbnail generation to visible rows plus a 1-item safety margin in `filePanel.js`. Cleared off-screen row image sources while retaining queued sources for re-entry.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 45. `ac5e3a5` Generalized viewport queue to 1:1 thumbnails
- **Files modified:**
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`.agents/legacy-reports/performance/archive-resource-refactor.md`](file:///E:/Projects/QuiviT/.agents/legacy-reports/performance/archive-resource-refactor.md)
  - [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
  - [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- **Summary:** Added `FsUtils.isConstrainedThumbnailSrc` distinguishing heavy decodes from lightweight shell thumbnails. Generalized viewport queue to all constrained thumbnail sources in thumbnail view mode.
- **update-architecture-state:** No change.
- **update-readme-features:** No change.
- **Warrants doc update:** No.

---

### 46. `5dc42a5` Showed restart notice when single-instance option changed
- **Files modified:**
  - [`.agents/implemented.md`](file:///E:/Projects/QuiviT/.agents/implemented.md)
  - [`src/js/options/options.js`](file:///E:/Projects/QuiviT/src/js/options/options.js)
- **Summary:** Compared single-instance checkbox against initial state on save and displayed `"Options applied successfully. Restart required."` when changed.
- **update-architecture-state:** No change. Restart requirement is already documented in `System Defaults` and `CLI`.
- **update-readme-features:** No change.
- **Warrants doc update:** No.
