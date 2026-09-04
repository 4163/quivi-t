# Slice 3: Spread Mode & Navigation Ergonomics Plan

## Goal Description

This slice implements **Spread Mode** (half-width fit-to-width and 2-step navigation for 2-page scanned spreads) in the QuiviT viewer engine, while resolving two desktop application regressions (Windows dotfile visibility and file panel keyboard navigation).

Key achievements in this slice:
1. **Unified Spread Mode (`'rtl' | 'ltr' | 'off'`)**: Unifies spread mode and reading direction into a single setting, defaulting to `'rtl'` (Manga reading order).
2. **Half-Width Fit-to-Width**: Automatically detects wide landscape scans (`naturalWidth / naturalHeight >= 1.2`). When in Fit-to-Width mode, scales the image using `width / 2` so panels and text match the zoom scale of single portrait pages.
3. **Two-Step Spread Navigation (Reading Steps)**:
   - `Spread 1/2` means **Reading Step 1 of 2** (the first page of the spread in your chosen reading order).
   - `Spread 2/2` means **Reading Step 2 of 2** (the second page of the spread).
   - **RTL (Manga, Default)**: Step 1 (`Spread 1/2`) is the **Right half**. Pressing `Next` pans to Step 2 (`Spread 2/2`), which is the **Left half**. Pressing `Next` again advances to the next file.
   - **LTR (Western)**: Step 1 (`Spread 1/2`) is the **Left half**. Pressing `Next` pans to Step 2 (`Spread 2/2`), which is the **Right half**. Pressing `Next` again advances to the next file.
   - **Reversing (`Prev`)**: Moving backward into a spread enters on the opposite step and pans symmetrically.
4. **Dual Indicator Architecture**:
   - **Status Bar Indicator (`.status-spread`)**: When `#statusbar` is visible, displays `[Spread 1/2]` or `[Spread 2/2]` in a dedicated span in the status bar.
   - **Overlay Indicator (`#spread-indicator`)**: When `#statusbar` is hidden (via `cmd-toggle-statusbar` or in fullscreen), displays `[Spread 1/2]` or `[Spread 2/2]` on an unstyled `#spread-indicator` element placed directly inside `#viewport` for the user to style manually via CSS.
5. **Desktop Shell Bug Fixes**:
   - **Dotfile Visibility**: Fixes `src-tauri/src/platform/attributes.rs` so files starting with `.` (e.g. `.filename`, `.gitignore`) are not treated as hidden on Windows unless `FILE_ATTRIBUTE_HIDDEN` is set.
   - **File List Space/Enter Regression**: Fixes `keyboardNav.js` and `filePanel.js` so virtualized list keyboard navigation uses `dataset.index` instead of DOM pool slot indices, and updates `shortcuts.js` so file panel focus is treated as an interactive target.
6. **Backlog Scope Alignment**: Marks simultaneous 2-file dual-page rendering, cover isolation, and dual-node DOM pooling as `[OUT OF SCOPE / REJECTED]` in tracking docs.

---

## User Review Required

> [!IMPORTANT]
> ## Indicator & Styling Rules
> 1. **Indicator Elements**:
>    - Status bar: `<span class="status-spread"></span>` inserted into `footer#statusbar`.
>    - Viewport overlay: `<div id="spread-indicator" class="spread-indicator"></div>` inserted inside `#viewport`.
> 2. **Overlay Visibility Logic**:
>    - When `#statusbar` is visible: `.status-spread` shows `[Spread 1/2]` or `[Spread 2/2]`; `#spread-indicator` remains empty/hidden.
>    - When `#statusbar` is hidden (has `.hidden` class): `#spread-indicator` receives text `[Spread 1/2]` or `[Spread 2/2]`.
> 3. **Styling Invariant**: The `#spread-indicator` DOM element will have **zero aesthetic styling** added in our CSS (no colors, borders, fonts, or padding); it is placed strictly as an unstyled DOM hook for user customization.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until explicitly verified and approved at runtime.

---

## Proposed Changes

### Component 1: Viewport Mathematics & Spread Geometry (`services/viewerMath.js`)
Extend `createViewportState` to support half-width scaling and step alignment.

#### [MODIFY] [viewerMath.js](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js)
```javascript
// Inside createViewportState:
let _spreadMode = 'rtl'; // 'rtl' | 'ltr' | 'off'
let _spreadStep = 1; // 1 = first reading step, 2 = second reading step

function checkIsSpread(w, h) {
  if (!w || !h) return false;
  return (w / h) >= 1.2;
}

// In applyFitMode:
// When _spreadMode !== 'off' && checkIsSpread(_naturalW, _naturalH) && ['width', 'width-if-larger'].includes(_currentFitMode):
// effectiveScaleX = (vw - padding * 2) / (_naturalW / 2);
// Pan offset _tx based on reading step and mode:
// RTL (Manga):   Step 1 => _tx = -maxX (Right half); Step 2 => _tx = +maxX (Left half)
// LTR (Western): Step 1 => _tx = +maxX (Left half);  Step 2 => _tx = -maxX (Right half)
```

---

### Component 2: State Machine & Step Navigation (`core.js`)
Coordinate stepping across spread halves on `selectNext()` / `selectPrev()`.

#### [MODIFY] [core.js](file:///E:/Projects/QuiviT/src/js/core.js)
```javascript
// State extensions:
_state.spreadMode = 'rtl';
_state.spreadStep = 1;

// Spread step navigation logic in selectNext() / selectPrev():
// selectNext():
//   If active image is a spread and _state.spreadStep === 1:
//     _state.spreadStep = 2; update viewport pan (no file reload).
//   Else:
//     Advance to next file index; _state.spreadStep = 1.
// selectPrev():
//   If active image is a spread and _state.spreadStep === 2:
//     _state.spreadStep = 1; update viewport pan.
//   Else:
//     Move to previous file index; if that file is a spread, set _state.spreadStep = 2.
// selectIndex():
//   Always resets _state.spreadStep = 1 (the first reading step).
```

---

### Component 3: Status Bar, Viewport Overlay & Menubar Chrome (`index.html`, `menubar/statusbar.js`, `menubar/chrome.js`, `menubar.js`)
Expose Spread Mode controls, display `.status-spread` in `#statusbar`, and toggle `#spread-indicator` when the status bar is hidden.

#### [MODIFY] [index.html](file:///E:/Projects/QuiviT/src/index.html)
- Add `<div id="spread-indicator" class="spread-indicator"></div>` inside `#viewport`.
- Add `<span class="status-spread"></span>` inside `footer#statusbar`.
- Add Spread Mode menu item under **View**, below Full Screen and Opaque Canvas.

#### [MODIFY] [menubar/statusbar.js](file:///E:/Projects/QuiviT/src/js/menubar/statusbar.js)
- Maintain and update both `.status-spread` and `#spread-indicator`:
  - If image is a spread:
    - Text is `[Spread 1/2]` on step 1, `[Spread 2/2]` on step 2.
    - If `#statusbar.classList.contains('hidden')`: text goes to `#spread-indicator`; `.status-spread` is cleared.
    - If `#statusbar` is visible: text goes to `.status-spread`; `#spread-indicator` is cleared.
  - If not a spread or Spread Mode off: both are cleared (`''`).

#### [MODIFY] [menubar/chrome.js](file:///E:/Projects/QuiviT/src/js/menubar/chrome.js)
- When status bar visibility changes, re-sync spread indicator between `#statusbar` and `#spread-indicator`.

---

### Component 4: Rust Backend Windows Dotfile Visibility (`src-tauri/src/platform/attributes.rs`)
Remove hardcoded dotfile hiding so only actual Windows `FILE_ATTRIBUTE_HIDDEN` hides files.

#### [MODIFY] [attributes.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/attributes.rs)
```rust
pub fn is_hidden_path(name: &str, metadata: Option<&fs::Metadata>) -> bool {
    // Removed: if name.starts_with('.') { return true; }

    #[cfg(windows)]
    {
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Some(meta) = metadata {
            return meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }

    false
}
```

---

### Component 5: File List Keyboard Navigation Fix (`keyboardNav.js`, `filePanel.js`, `shortcuts.js`)
Fix index mapping in virtualized list and prevent canvas shortcuts from intercepting list keys.

#### [MODIFY] [keyboardNav.js](file:///E:/Projects/QuiviT/src/js/keyboardNav.js) & [filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- Read `activeEl.dataset.index` to determine true data index rather than position in the 50-node DOM pool.
- Pass resolved data index to `onAction` and `onSelectionChange`.

#### [MODIFY] [shortcuts.js](file:///E:/Projects/QuiviT/src/js/shortcuts.js)
```javascript
function isInteractiveKeyTarget(e) {
  const target = e.target;
  return !!(target && (
    target.tagName === 'BUTTON'
    || target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT'
    || target.closest?.('button, input, textarea, select, #file-panel')
  ));
}
```

---

### Component 6: Documentation & Backlog Tracking
Update backlog tracking to mark dual-page simultaneous 2-file rendering as rejected/out-of-scope.

#### [MODIFY] [.agents/cl-refactor-report.md](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md) & [.agents/additions.md](file:///E:/Projects/QuiviT/.agents/additions.md)
- Update "Double Page View" entries to reflect that QuiviT uses Half-Width Spread Mode for single scanned 2-page images.
- Mark simultaneous 2-image DOM rendering, cover isolation, and dual-node LRU mounting as `[OUT OF SCOPE / REJECTED]`.

---

## Verification Plan

### Automated Tests
1. **Spread Mathematics Unit Tests**:
   - Add tests to `src/js/tests/viewerMath.test.mjs` for:
     - `checkIsSpread` threshold (`>= 1.2`).
     - Half-width scale calculation in `fitMode: 'width'`.
     - Pan offset calculation for RTL (step 1 = -maxX [Right], step 2 = +maxX [Left]) and LTR (step 1 = +maxX [Left], step 2 = -maxX [Right]).
     - Full-width scale preserved in `fitMode: 'window'`.
   - Run: `npm test`
2. **Backend Attributes Unit Tests**:
   - Run: `cargo test --manifest-path src-tauri/Cargo.toml`
   - Run: `cargo check --manifest-path src-tauri/Cargo.toml --tests`
3. **Static Syntax Checks**:
   - Run: `node --check src/js/services/viewerMath.js`
   - Run: `node --check src/js/core.js`
   - Run: `node --check src/js/filepanel/filePanel.js`

### Manual Verification
1. **Spread Mode (Manga RTL - Default)**:
   - Open a folder/archive with a wide landscape image (`>= 1.2`).
   - In Fit-to-Width mode with Status Bar visible:
     - Initial view shows the Right half with status bar indicator `[Spread 1/2]`.
     - Press `Next`: Pans to the Left half with status bar indicator `[Spread 2/2]`.
     - Press `Next` again: Advances to the next file.
     - Press `Prev`: Returns to the Left half (`[Spread 2/2]`), then `Prev` goes to Right half (`[Spread 1/2]`).
2. **Hidden Status Bar Indicator**:
   - Press `3` to hide the status bar (or enter fullscreen without status bar):
     - Verify `#spread-indicator` in `#viewport` displays `[Spread 1/2]` or `[Spread 2/2]`.
     - Verify `#spread-indicator` has zero custom aesthetic styles.
3. **Spread Mode (Western LTR)**:
   - Switch Spread Mode to LTR: Step 1 shows Left half (`[Spread 1/2]`), Step 2 shows Right half (`[Spread 2/2]`).
4. **Fit-to-Window Parity**:
   - In Fit-to-Window (`3`): The full 2-page spread fits the window without cropping.
5. **Dotfile Visibility**:
   - Verify files starting with `.` (e.g. `.filename`) appear in the file list on Windows without toggling hidden files.
6. **File List Space & Enter Navigation**:
   - Focus file list, navigate past item 50 with Arrow keys, press `Enter` or `Space`: Active item opens immediately without triggering canvas pan.
