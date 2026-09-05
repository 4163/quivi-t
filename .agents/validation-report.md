# Validation Report

**Target:** Working tree on branch `refactor/backend-cl-prep` (post-commit `b350ee3`)  
**Summary:** Implements a password-protected archive prompt overlay with credential caching, reorganizes `#menu-view` with nested flyout submenus and safe-triangle cursor tracking, removes spread view controls from Options in favor of menubar controls, and updates test fixture passwords to `123`.

---

## AGENTS.md Violations

- [`menubar.js:106-108, 124-131, 160-162`](file:///E:/Projects/QuiviT/src/js/menubar.js#L106-L131) `[Observable change]`  
  **CSS Source of Truth.**  
  `menubar.js` directly sets inline styles on submenu DOM elements:
  ```javascript
  aimState.activeSubmenu.style.top = `${topPos}px`;
  aimState.activeSubmenu.style.left = `${rect.right}px`;
  aimState.activeSubmenu.style.maxHeight = `${Math.max(120, maxH)}px`;
  flyout.style.top = '';
  flyout.style.left = '';
  flyout.style.maxHeight = '';
  ```
  `AGENTS.md` explicitly forbids inline visual styling:
  > *CSS is the visual source of truth. JS must not set intrinsic visual values (`width`, `height`, `display`, `cursor`, `opacity`, `color`, `image-rendering`, etc.) via inline `style` or presentational HTML attributes. Allowed JS writes: CSS custom properties on `:root` or a host node, viewport / virtualization `transform` matrices, and `classList` / `data-*` state.*  
  **Remediation:** Set CSS custom properties on the submenu host (such as `--submenu-top`, `--submenu-left`, `--submenu-max-height`) and declare `top: var(--submenu-top); left: var(--submenu-left); max-height: var(--submenu-max-height);` in [main.css](file:///E:/Projects/QuiviT/src/css/main.css).

- [`passwordOverlay.js:85, 96-97`](file:///E:/Projects/QuiviT/src/js/main/passwordOverlay.js#L85-L97) `[Observable change]`  
  **Cross-module reach-in into `#file-list`.**  
  `passwordOverlay.js` directly queries and focuses the `#file-list` DOM element owned by `filePanel.js`:
  ```javascript
  document.getElementById('file-list')?.focus();
  const fileListUl = document.getElementById('file-list');
  const isFileListFocused = !!(fileListUl && document.activeElement && fileListUl.contains(document.activeElement));
  ```
  `AGENTS.md` mandates:
  > *One owner per concern. Each surface or responsibility has exactly one writer.*  
  > *Communicate across files via state callbacks, not reach-in. Module A updates shared state (or a dedicated owner API). Module B paints what it owns.*  
  According to [architecture-state.md](file:///E:/Projects/QuiviT/.agents/architecture-state.md#L51), `filepanel/filePanel.js` is the sole owner of `#file-panel`.  
  **Remediation:** Export a focus/state helper from [filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) (or pass callbacks via `initPasswordOverlay`) rather than reaching into the file list DOM directly.

- [`main.css:942-958`](file:///E:/Projects/QuiviT/src/css/main.css#L942-L958) `[Observable change]`  
  **Aesthetic styling on `#spread-indicator`.**  
  The diff adds decorative CSS rules (border, border-radius, background with `color-mix`, font-size, line-height, text color) to `#spread-indicator`.  
  In Slice 3 specifications ([implemented.md](file:///E:/Projects/QuiviT/.agents/implemented.md#L43) and [slice-3_spread-mode-plan.md](file:///E:/Projects/QuiviT/.agents/slice-3_spread-mode-plan.md#L21)), `#spread-indicator` is specified to have zero aesthetic declarations so that user custom CSS can theme it without fighting default rules.  
  **Remediation:** Remove aesthetic properties from `#spread-indicator`, keeping only functional layout rules (`position: absolute`, `bottom`, `left`, `display: none` when `:empty`, `pointer-events: none`).

- [`fsUtils.js:21-22`](file:///E:/Projects/QuiviT/src/js/fsUtils.js#L21-L22) `[Observable change]`  
  **Unbounded in-memory session caches.**  
  `_archiveEncryptionCache` and `_unlockedArchivePasswords` are plain `Map` instances without an upper bound or eviction policy. Navigating through large directory structures with hundreds of archives causes memory allocations to grow without an eviction cap.  
  `AGENTS.md` mandates:
  > *Performance first... Aggressive I/O Caching: Use header-only file reads and maintain in-memory LRU caches (`lru` crate) for fast virtual archive directory traversal.*  
  **Remediation:** Introduce a bound on `_archiveEncryptionCache` and `_unlockedArchivePasswords` (e.g. 50 entries with simple FIFO or LRU deletion).

---

## Stale Code and References

- [`.agents/implemented.md:11-24`](file:///E:/Projects/QuiviT/.agents/implemented.md#L11-L24) `[No observable change]`  
  **Documentation drift for menubar split.**  
  The changelog entry describes a full split into separate **View** (`#menu-view`) and **Image** (`#menu-image`) top-level dropdowns, including Fit and Panels flyout submenus. In [index.html](file:///E:/Projects/QuiviT/src/index.html#L50-L112), `#menu-image` was not created. All submenus (Scaling, Filter, Rotate & Flip, Spread View) remain inside `#menu-view`. Fit and Panels remain flat list items. The entry in `implemented.md` is inaccurate.

- [`menubar.js:501`](file:///E:/Projects/QuiviT/src/js/menubar.js#L501) `[No observable change]`  
  **Unused export alias.**  
  `export const syncImageMenu = syncViewMenu;` is exported for an Image menu that does not exist in markup. It is never imported or called anywhere in the codebase.

- [`main.css:135-136`](file:///E:/Projects/QuiviT/src/css/main.css#L135-L136) `[No observable change]`  
  **Dead selector.**  
  `#menu-image .menu-dropdown li[role="menuitem"]` is declared in CSS, but `#menu-image` does not exist in markup.

- [`options.js:316-318`](file:///E:/Projects/QuiviT/src/js/options/options.js#L316-L318) `[No observable change]`  
  **Dead form persistence logic.**  
  `buildConfigFromForm` still contains fallback preservation for `spread_enabled`, `spread_direction`, and `spread_mode` even though the controls were removed from [options.html](file:///E:/Projects/QuiviT/src/options.html#L24-L100).

---

## Verdict

**Pass with Warnings**

The core functionality operates cleanly, automated tests pass (`npm test` 13/13, `cargo check --tests`, and `cargo test _encrypted_`), and syntax checks succeed. However, four concrete architectural items should be addressed before committing:
1. Replace inline `.style.top` / `.style.left` / `.style.maxHeight` assignments in [menubar.js](file:///E:/Projects/QuiviT/src/js/menubar.js) with CSS custom properties.
2. Replace direct `#file-list` DOM queries in [passwordOverlay.js](file:///E:/Projects/QuiviT/src/js/main/passwordOverlay.js) with a dedicated API on [filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js).
3. Strip aesthetic declarations from `#spread-indicator` in [main.css](file:///E:/Projects/QuiviT/src/css/main.css) to restore the unstyled overlay invariant.
4. Correct the changelog text in [.agents/implemented.md](file:///E:/Projects/QuiviT/.agents/implemented.md) to reflect that submenus reside in `#menu-view` rather than a split `#menu-image` dropdown, and remove dead `#menu-image` selectors.
