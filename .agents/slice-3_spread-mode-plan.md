# Slice 3: Manga Spread Mode & Navigation Ergonomics Plan

## Goal

Implement **Spread Mode** (half-width fit-to-width and two-step navigation for two-page scanned spreads) in the QuiviT viewer engine, while resolving desktop application regressions in Windows dotfile visibility, file panel keyboard navigation, and drop-overlay pan isolation.

Key capabilities in this slice:
1. **Manga Spread Mode (`'rtl' | 'ltr' | 'off'`)**: Detects wide landscape scans (`naturalWidth / naturalHeight >= 1.2`), scales image width by half (`width / 2`) in Fit-to-Width mode so panel text matches single-page zoom, and supports configurable reading direction defaulting to `'rtl'` (Manga).
2. **Two-Step Spread Navigation (Reading Steps)**:
   - `Spread 1/2`: Reading Step 1 of 2 (first page of the spread in the active reading order).
   - `Spread 2/2`: Reading Step 2 of 2 (second page of the spread).
   - **RTL (Manga, Default)**: Step 1 displays the Right half; `Next` pans to Step 2 (Left half); `Next` again advances to the next file.
   - **LTR (Western)**: Step 1 displays the Left half; `Next` pans to Step 2 (Right half); `Next` again advances to the next file.
   - **Symmetrical Reverse (`Prev`)**: Moving backward into a spread enters at Step 2 and pans backward.
3. **Dual Indicator Architecture**:
   - Status bar: `<span class="status-spread"></span>` in `footer#statusbar` displays `[Spread 1/2]` or `[Spread 2/2]` when the status bar is visible.
   - Viewport overlay: `<div id="spread-indicator" class="spread-indicator"></div>` in `#viewport` displays `[Spread 1/2]` or `[Spread 2/2]` when `#statusbar` is hidden (via `cmd-toggle-statusbar` or fullscreen). Zero aesthetic CSS applied to ensure user customizability.
   - Supported fit gating: Indicators display only when spread mode is active, the image is a wide scan, and fit mode is set to `width` or `width-if-larger`.
4. **Desktop Navigation Ergonomics & Shell Fixes**:
   - **Windows Dotfile Visibility**: Verified and documented `attributes.rs` so leading-dot files on Windows are not treated as hidden unless the Win32 `FILE_ATTRIBUTE_HIDDEN` flag is set on filesystem metadata.
   - **Viewport Keyboard Gating**: When hovering over `#viewport` with an active loaded image, `#file-list` yields on `ArrowUp`, `ArrowDown`, and `Space` so they drive viewport keyboard panning (`cmd-pan-*`) and canvas pan drag.
   - **Space on Files No-Op**: Pressing <kbd>Space</kbd> on an image or regular file in the file list strictly does nothing (no index reset, no selection jump). <kbd>Space</kbd> continues to open container entries (`..`, folders, archives).
   - **Unselected Enter/Space No-Op**: When nothing is selected (`state.index === -1`), both <kbd>Enter</kbd> and <kbd>Space</kbd> strictly do nothing rather than jumping to item 0 (`..`).
   - **Initial Load Auto-Focus**: `#file-list` automatically acquires focus on initial boot or directory change when focus is unassigned or on `document.body`, with fallback <kbd>Enter</kbd> delegation.
   - **Tab Navigation Order**: Set `tabindex="-1"` on `#file-list` so sequential Tab navigation skips the list, jumping directly from the `Modified` column header (`.col-date`) to `#cmd-open-explorer`.
   - **Drop-Overlay Pan Isolation**: Disabled mouse-drag and Spacebar pan on `#drop-overlay` and empty states.
5. **Backlog Scope Alignment**: Marked simultaneous two-file dual-page rendering, cover isolation, and dual-node DOM pooling as `[OUT OF SCOPE / REJECTED]` in tracking docs.

> [!IMPORTANT]
> ## User Review Required
> - **Default Reading Direction**: Defaults to `'rtl'` (Right to Left Manga order).
> - **Indicator Styling Invariant**: `#spread-indicator` has **zero aesthetic styling** added in CSS (no colors, borders, fonts, or padding); it is placed strictly as an unstyled DOM hook for user customization.
> - **Fit Mode Gating**: Spread mode indicators and half-width scaling only activate in supported fit modes (`width` and `width-if-larger`). In Fit-to-Window (`window`), the entire spread displays without cropping.
> - **Viewport Gating Priority**: When hovering over `#viewport` with an active image, arrow keys and Space belong to the viewport. When hovering over `#file-panel` or when no image is loaded, arrow keys navigate the file list.

> [!CAUTION]
> ## Execution Rules
> All items in this plan have been implemented, tested via automated suites, and manually verified at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan follows [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and the architectural review standards of [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Frontend DOM & Architecture Boundaries:**
   - The state machine ([core.js](file:///E:/Projects/QuiviT/src/js/core.js)) and domain mathematics ([viewerMath.js](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js)) maintain zero DOM imports and communicate via state callbacks.
   - Single owner per surface: [statusbar.js](file:///E:/Projects/QuiviT/src/js/menubar/statusbar.js) owns status bar text and `#spread-indicator` textContent, [viewerMath.js](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js) owns pan offsets and fit scales, and [filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) owns file list DOM and keyboard selection.
   - HTML-first rendering: `#spread-indicator` is declared in [index.html](file:///E:/Projects/QuiviT/src/index.html). No runtime element creation or teardown.
   - CSS source of truth: `#spread-indicator` has zero custom aesthetic CSS declarations, leaving visual styling entirely to user custom CSS.

2. **Performance First & Hot Path Invariants:**
   - **Zero Re-Fetch Step Navigation**: Stepping between spread halves (`Spread 1/2` <-> `Spread 2/2`) updates the pan transform offset directly in memory via `viewportState.applyFitMode()` without re-fetching, re-decoding, or resetting image DOM nodes.
   - **O(1) Spread Detection**: Wide scan aspect ratio detection (`naturalWidth / naturalHeight >= 1.2`) executes once on image load in `_syncActiveImage` and caches the boolean flag on application state.
   - **Bounded DOM & Hit Testing**: Viewport hover detection uses element hit testing (`document.elementFromPoint()?.closest('#viewport')`), avoiding redundant event listeners or layout thrashing.

3. **Blast Radius & Downstream Safety:**
   - **Config Schema Backward Compatibility**: `spread_enabled` and `spread_direction` default safely to `true` and `'rtl'`, maintaining compatibility with older config files.
   - **Platform Independence**: Windows dotfile visibility checks in [attributes.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/attributes.rs) maintain Unix compatibility via `#[cfg(not(windows))]`.
   - **Tab Navigation Accessibility**: Changing `#file-list` to `tabindex="-1"` preserves programmatic focus via `.focus()` while restoring clean sequential Tab traversal across action buttons.

4. **Stale Code Prevention:**
   - Unified image dimension syncing into `_syncActiveImage` in [viewerRender.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js), eliminating duplicate dimension setting across cold and cached image load paths.

---

## Proposed Changes

### 1. Viewport Mathematics & Spread Geometry
#### [MODIFY] [services/viewerMath.js](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js)
- [COMPLETED] `[Observable change]` Add `checkIsSpread(w, h)` to detect scans with aspect ratio >= 1.2.
- [COMPLETED] `[Observable change]` Add `_spreadEnabled`, `_spreadDirection`, and `_spreadStep` state in `createViewportState`.
- [COMPLETED] `[Observable change]` In `applyFitMode()`, scale width by half (`_naturalW / 2`) in `width` and `width-if-larger` modes when `isSpreadActive()`.
- [COMPLETED] `[Observable change]` Compute pan offset `_tx` based on reading direction and step:
  - RTL: Step 1 => `-maxX` (Right half); Step 2 => `+maxX` (Left half).
  - LTR: Step 1 => `+maxX` (Left half); Step 2 => `-maxX` (Right half).
- [COMPLETED] `[Observable change]` Export getters and setters: `setSpreadEnabled`, `getSpreadEnabled`, `setSpreadDirection`, `getSpreadDirection`, `setSpreadMode`, `getSpreadMode`, `setSpreadStep`, `getSpreadStep`, and `isSpreadActive`.
- **Validation Notes:** Pure mathematical module with zero DOM dependencies. Verified via unit tests in `viewerMath.test.mjs`.

---

### 2. State Machine & Step Navigation
#### [MODIFY] [core.js](file:///E:/Projects/QuiviT/src/js/core.js)
- [COMPLETED] `[Observable change]` Add `spreadEnabled`, `spreadDirection`, and `spreadStep` fields to state machine.
- [COMPLETED] `[Observable change]` In `navigateBy()`, intercept forward and backward navigation on spread images:
  - Forward: If Step 1, advance to Step 2 without changing file index. If Step 2, advance to next file index and reset to Step 1.
  - Backward: If Step 2, return to Step 1. If Step 1, move to previous file index; if the previous file is a spread, enter at Step 2.
- [COMPLETED] `[Observable change]` Add `Core.setSpreadStep()`, `Core.setSpreadEnabled()`, `Core.setSpreadDirection()`, `Core.toggleSpread()`, and `Core.cycleSpreadMode()`.
- [COMPLETED] `[Observable change]` In `loadConfig()`, load and apply `spread_enabled` and `spread_direction` preferences.
- **Validation Notes:** Pure state machine module with zero DOM imports. Communicates state changes through `_notify()`.

---

### 3. Chrome, Status Bar & Viewport Overlay
#### [MODIFY] [index.html](file:///E:/Projects/QuiviT/src/index.html)
- [COMPLETED] `[Observable change]` Add unstyled `<div id="spread-indicator" class="spread-indicator"></div>` inside `#viewport`.
- [COMPLETED] `[Observable change]` Add `<span class="status-spread"></span>` in `footer#statusbar`.
- [COMPLETED] `[Observable change]` Add Spread View toggle and RTL/LTR direction controls to View menu in menubar.
- [COMPLETED] `[Observable change]` Set `tabindex="-1"` on `<ul id="file-list">` so sequential Tab navigation skips the list.

#### [MODIFY] [menubar/statusbar.js](file:///E:/Projects/QuiviT/src/js/menubar/statusbar.js)
- [COMPLETED] `[Observable change]` Query `.status-spread` and `#spread-indicator`.
- [COMPLETED] `[Observable change]` Add `syncSpreadIndicator()`:
  - Formats text as `[Spread ${s.spreadStep || 1}/2]`.
  - Gated to supported fits (`width` and `width-if-larger`) when spread mode is active and image is a wide scan.
  - When `#statusbar` is hidden, text is rendered to `#spread-indicator` and cleared from `.status-spread`.
  - When `#statusbar` is visible, text is rendered to `.status-spread` and cleared from `#spread-indicator`.

#### [MODIFY] [menubar/chrome.js](file:///E:/Projects/QuiviT/src/js/menubar/chrome.js)
- [COMPLETED] `[Observable change]` Trigger `syncSpreadIndicator` when status bar visibility toggles (`setStatusBarVisible`).

#### [MODIFY] [services/actions.js](file:///E:/Projects/QuiviT/src/js/services/actions.js)
- [COMPLETED] `[Observable change]` Register action `cmd-cycle-spread-mode` with label `Toggle Spread View (Cycle)` in category `View`.

---

### 4. Options Configuration UI
#### [MODIFY] [options.html](file:///E:/Projects/QuiviT/src/options.html)
- [COMPLETED] `[Observable change]` Add Spread Mode checkbox (`#opt-spread-enabled`) and RTL/LTR segmented button control (`#spread-direction-controls`) in Viewport Controls section.

#### [MODIFY] [options/options.js](file:///E:/Projects/QuiviT/src/js/options/options.js)
- [COMPLETED] `[Observable change]` Load `spread_enabled` and `spread_direction` on initialization and populate form controls.
- [COMPLETED] `[Observable change]` Make segmented buttons keyboard-navigable via `makeListNavigable`.
- [COMPLETED] `[Observable change]` Persist values to `config.frontend_data` on save.

---

### 5. Windows Dotfile Visibility
#### [MODIFY] [src-tauri/src/platform/attributes.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/attributes.rs)
- [COMPLETED] `[Observable change]` Remove hardcoded `name.starts_with('.')` check under Windows target.
- [COMPLETED] `[Observable change]` Check `meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0` so dotfiles are only hidden when the Win32 hidden flag is explicitly set.
- **Validation Notes:** Fully verified with tests in `attributes_tests.rs`.

---

### 6. File List Navigation, Focus & Viewport Gating
#### [MODIFY] [filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [COMPLETED] `[Observable change]` Add `isPointerOverActiveViewport()` to gate keyboard handling.
- [COMPLETED] `[Observable change]` When hovering over `#viewport` with an active loaded image, yield on `ArrowDown`, `ArrowUp`, and `Space` to allow viewport keyboard panning and drag pan.
- [COMPLETED] `[Observable change]` In `case ' ': `, make pressing <kbd>Space</kbd> on image or regular files strictly a no-op (no jump, no selection change).
- [COMPLETED] `[Observable change]` When nothing is selected (`state.index === -1`), make both <kbd>Enter</kbd> and <kbd>Space</kbd> strictly no-op.
- [COMPLETED] `[Observable change]` Auto-focus `#file-list` when focus is unassigned or on `document.body` in `renderFilePanel()` and `updateSelection()`.

#### [MODIFY] [shortcuts.js](file:///E:/Projects/QuiviT/src/js/shortcuts.js)
- [COMPLETED] `[Observable change]` Restore `isInteractiveKeyTarget()` so `#file-list` does not block keyboard pan when yielded.
- [COMPLETED] `[Observable change]` Add fallback on `document.body` to delegate <kbd>Enter</kbd> to `#file-list`.

#### [MODIFY] [css/main.css](file:///E:/Projects/QuiviT/src/css/main.css)
- [COMPLETED] `[Observable change]` Add `cursor: default;` to `#file-list` and ensure focus outline styles remain clean.

---

### 7. Drop-Overlay & Empty State Pan Isolation
#### [MODIFY] [viewer/viewerGestures.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js)
- [COMPLETED] `[Observable change]` Update `_isMouseOverViewportNow()` to return `false` if `!state.src`, if `state.mode === 'empty'`, if `#drop-overlay` is active, or if hit-test targets drop overlay or UI chrome.
- [COMPLETED] `[Observable change]` Completely disables mouse-drag pan and Spacebar pan on `#drop-overlay`.

---

### 8. Documentation & Backlog Tracking
#### [MODIFY] [.agents/cl-refactor-report.md](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md) & [.agents/implemented.md](file:///E:/Projects/QuiviT/.agents/implemented.md)
- [COMPLETED] `[Observable change]` Update report to mark Spread Mode completed and dual-file rendering rejected.
- [COMPLETED] `[Observable change]` Mark touched items in Host Application File List & Navigation.
- [COMPLETED] `[Observable change]` Port completed Slice 3 work to `implemented.md` and prune `additions.md`.

---

## Verification Plan

### Automated Tests
1. **Spread Mathematics & State Unit Tests**:
   - `src/js/tests/viewerMath.test.mjs`: Tests `checkIsSpread` aspect ratio threshold, half-width scaling, and RTL/LTR pan offsets.
   - `src/js/tests/coreSpread.test.mjs`: Tests spread state initialization, direction settings, step navigation, and window fit bypass.
   - Run: `npm test`
2. **Backend Attributes Unit Tests**:
   - `src-tauri/src/tests/attributes_tests.rs`: Tests `is_hidden_path` for dotfiles and hidden attributes.
   - Run: `cargo test --manifest-path src-tauri/Cargo.toml test_is_hidden_path`
3. **Rust Compilation & Static Syntax Checks**:
   - Run: `cargo check --tests --manifest-path src-tauri/Cargo.toml`
   - Run: `node --check src/js/filepanel/filePanel.js src/js/viewer/viewerGestures.js src/js/shortcuts.js`

### Manual Verification Hand-off
1. **Spread Mode (Manga RTL - Default)**:
   - Open a folder/archive with a wide landscape image (`>= 1.2`).
   - In Fit-to-Width mode with Status Bar visible:
     - Initial view shows Right half with status bar indicator `[Spread 1/2]`.
     - Press `Next`: Pans to Left half with status bar indicator `[Spread 2/2]`.
     - Press `Next` again: Advances to next file.
     - Press `Prev`: Returns to Left half (`[Spread 2/2]`), then `Prev` goes to Right half (`[Spread 1/2]`).
2. **Hidden Status Bar Indicator**:
   - Press `3` to hide status bar (or enter fullscreen without status bar):
     - Confirm `#spread-indicator` in `#viewport` displays `[Spread 1/2]` or `[Spread 2/2]`.
     - Confirm `#spread-indicator` has zero custom aesthetic styles.
3. **Spread Mode (Western LTR)**:
   - Switch Spread Mode to LTR: Step 1 shows Left half (`[Spread 1/2]`), Step 2 shows Right half (`[Spread 2/2]`).
4. **Fit-to-Window Parity**:
   - In Fit-to-Window: Full two-page spread fits the window without cropping and indicators clear.
5. **Dotfile Visibility**:
   - Confirm files starting with `.` appear in file list on Windows without toggling hidden files.
6. **File List Navigation & Viewport Gating**:
   - Hover over `#viewport` with image loaded: press arrow keys to pan viewport; file list does not move.
   - Hover over `#file-panel`: press arrow keys to move file list selection.
   - Press <kbd>Space</kbd> on an image file: confirms nothing happens (no jump, no selection change).
   - Press <kbd>Enter</kbd> or <kbd>Space</kbd> when nothing is selected: confirms no navigation occurs.
   - Tab navigation: confirms tabbing from `Modified` skips `#file-list` and focuses `#cmd-open-explorer`.
7. **Drop-Overlay Pan Isolation**:
   - With drop overlay visible, press <kbd>Space</kbd> or click-drag: confirms pan mode is disabled.

---

## Deviations, Violations & Runtime Fixes

During the implementation and manual testing of Slice 3, the following deviations and runtime issues were identified, audited, and resolved:

1. **Config Key Granularity (Deviation)**:
   - *Plan Proposal*: Store a single string `spread_mode: 'rtl' | 'ltr' | 'off'`.
   - *Shipped Implementation*: The Options UI uses an independent checkbox (Enabled/Disabled) alongside a segmented control (RTL/LTR). To support this cleanly while remaining backward-compatible with legacy presets, `quivit_config.json` stores `spread_enabled: bool` and `spread_direction: 'rtl' | 'ltr'`, while dynamically computing `spread_mode` on save.

2. **Fit Mode Spread Gating (Rule Invariant)**:
   - *Issue*: Early implementation displayed spread indicators in non-supported fit modes (such as Fit-to-Window).
   - *Resolution*: Added strict fit mode gating (`['width', 'width-if-larger'].includes(fitMode)`). In all other fit modes (Fit-to-Window, Fit-to-Height, None), spread stepping is bypassed and indicators are suppressed.

3. **Runtime API Mismatch in File Panel (Violation)**:
   - *Issue*: During focus handling updates, `filePanel.js` called `Core.getCurrentDirectory()`, which did not exist on `Core`, causing a `TypeError` on initial boot.
   - *Resolution*: Replaced with direct state derivation (`state.mode === 'archive' ? state.archivePath : state.directory`). Breadcrumb and favorite button synchronizations were restored.

4. **Keyboard Pan Blocking via Interactive Target (Violation)**:
   - *Issue*: Adding `#file-panel` to `isInteractiveKeyTarget()` in `shortcuts.js` prevented keyboard pan when the pointer hovered over the viewport while the file list was focused.
   - *Resolution*: Restored `isInteractiveKeyTarget()` and moved viewport gating to `filePanel.js`, cleanly hit-testing the hovered element so the file list yields when the pointer is over the viewport.

5. **Fallback Defaulting to Parent Directory (Violation)**:
   - *Issue*: In `filePanel.js`, <kbd>Enter</kbd> and <kbd>Space</kbd> defaulted to `activeIdx = 0` when nothing was selected (`state.index === -1`), causing the app to open the parent directory (`..`).
   - *Resolution*: Added an explicit guard (`if (state.index < 0 || state.index >= list.length) break;`) so both keys strictly no-op when nothing is selected.

6. **Tab Navigation Trapping on File List Container (Violation)**:
   - *Issue*: `#file-list` had `tabindex="0"`, causing sequential Tab navigation to land on the list container between the column headers and action buttons.
   - *Resolution*: Changed `#file-list` to `tabindex="-1"`. The list retains programmatic focus via `.focus()`, while sequential Tab navigation cleanly skips from `Modified` directly to `cmd-open-explorer`.
