# Archive Password & Menubar Validation Report

**Target:** Working tree on branch `refactor/backend-cl-prep` (post-commit `b350ee3`)  
**Summary:** Implements a password-protected archive prompt overlay with credential caching, reorganizes `#menu-view` with nested flyout submenus and safe-triangle cursor tracking, removes spread view controls from Options in favor of menubar controls, and updates test fixture passwords to `123`.

---

## AGENTS.md Violations

- [COMPLETED] [`menubar.js:106-108, 124-131, 155-161`](file:///E:/Projects/QuiviT/src/js/menubar.js#L106-L131) `[Observable change]`  
  **CSS Source of Truth.**  
  Migrated inline visual style assignments (`.style.top`, `.style.left`, `.style.maxHeight`) to CSS custom properties (`--submenu-top`, `--submenu-left`, `--submenu-max-height`) with `style.setProperty()` and `style.removeProperty()`. Declarative styling rules moved to [main.css](file:///E:/Projects/QuiviT/src/css/main.css#L161-L168).

- [COMPLETED] [`passwordOverlay.js:80, 93`](file:///E:/Projects/QuiviT/src/js/main/passwordOverlay.js#L80-L95) `[Observable change]`  
  **Cross-module reach-in into `#file-list`.**  
  Eliminated direct DOM reach-in by exporting `focusFileList()` and `isFileListFocused()` from [filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) and injecting them into `initPasswordOverlay` via [main.js](file:///E:/Projects/QuiviT/src/js/main/main.js).

- [COMPLETED] [`fsUtils.js:18-37`](file:///E:/Projects/QuiviT/src/js/fsUtils.js#L18-L37) `[Observable change]`  
  **Bounded in-memory session caches.**  
  Replaced unbounded `Map` instances with size-capped `BoundedMap` instances (50 max for unlocked passwords, 100 max for archive encryption statuses) with FIFO eviction on oldest keys. Verified via automated unit tests in [boundedMap.test.mjs](file:///E:/Projects/QuiviT/src/js/tests/boundedMap.test.mjs).

---

## Stale Code and References

- [COMPLETED] [`.agents/implemented.md:11-24`](file:///E:/Projects/QuiviT/.agents/implemented.md#L11-L24) `[No observable change]`  
  **Documentation drift for menubar split.**  
  Updated entry in `implemented.md` to accurately describe `#menu-view` nested flyout submenus (Scaling, Filter, Rotate & Flip, Spread View) instead of the nonexistent `#menu-image` split.

- [COMPLETED] [`menubar.js:501`](file:///E:/Projects/QuiviT/src/js/menubar.js#L501) `[No observable change]`  
  **Unused export alias.**  
  Removed dead export alias `syncImageMenu` from `menubar.js`.

- [COMPLETED] [`main.css:135-136`](file:///E:/Projects/QuiviT/src/css/main.css#L135-L136) `[No observable change]`  
  **Dead selector.**  
  Removed `#menu-image .menu-dropdown li[role="menuitem"]` selector from `main.css`.

- [COMPLETED] [`options.js:316-318`](file:///E:/Projects/QuiviT/src/js/options/options.js#L316-L318) `[No observable change]`  
  **Form persistence documentation.**  
  Documented that spread view settings in `buildConfigFromForm` are controlled via the View menu and preserved across Options saves.

---

## Verdict

**Pass**

All architectural standards and guidelines in `AGENTS.md` are met:
- CSS remains the visual source of truth via custom properties.
- Surface and DOM element ownership are strictly encapsulated.
- In-memory traversal caches are bounded against session memory leakage.
- Automated tests pass cleanly (16/16 Node unit tests, 9/9 archive tests, `cargo check --tests`, and `node --check`).
- Stale code, selectors, and documentation drift have been eliminated.
