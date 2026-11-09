# Zone 4 architectural and performance audit: chrome, options, html, and css

This report was compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`.

## Validate-changes compliance findings

### HTML-first rendering

- `src/js/options/keybindUi.js:321-386` `[Blocking]`
  `renderKeybinds` clears slot containers with `tagsContainer.innerHTML = ''` on every render pass. It then imperatively constructs tags with `document.createElement('button')`, label text spans with `document.createElement('span')`, deletion buttons with `document.createElement('span')`, and append buttons with `document.createElement('button')`. This runs repeatedly whenever a key is captured, deleted, or reset. `src/options.html:157-442` declares empty `.keybind-tags` slots without a `<template>` or recycled node pool, violating the HTML-first rendering and node recycling rules in `.agents/AGENTS.md`.
- `src/js/shared/themePrePaint.js:7-11` `[Warning]`
  `themePrePaint.js` creates a new `<style>` node using `document.createElement('style')`, assigns `s.id = 'custom-css'`, and appends it to `document.head`. All three entry points (`src/index.html:15`, `src/options.html:14`, and `src/metadata.html:10`) already declare `<style id="custom-css"></style>` in static markup. Creating an element at runtime produces duplicate `#custom-css` elements in `<head>`, violating the static placeholder rule.
- `src/js/options/options.js:398` `[Nit]`
  `highlightCode.innerHTML = window.Prism.highlight(...)` updates code tokens via innerHTML on every input event. While Prism produces formatted HTML token strings, this innerHTML write runs synchronously on every keystroke without sanitization or caching.
- `src/js/menubar.js:480-510, 647-705` `[Compliant]`
  `renderFavoritesMenu` and `renderImportsMenu` clone from `#loadout-row-template` (`src/index.html:181`) and `#import-provider-row-template` (`src/index.html:198`), recycling existing list elements by index and pruning excess nodes from the end.
- `src/js/menubar/statusbar.js:50-67` `[Compliant]`
  Statusbar caches DOM references on `init()` and mutates existing elements using `textContent` and `classList.toggle`. It performs zero runtime node creations.
- `src/js/options/associationsUi.js:18-36, 176-230` `[Compliant]`
  Format rows, checkboxes, and mascot boxes are declared statically in `src/options.html:457-591`. The module mutates only checkbox state, titles, and class attributes.

### CSS source of truth

- `src/js/options/keybindUi.js:330-331` `[Blocking]`
  `tag.style.color = conflictColor;` and `tag.style.borderColor = conflictColor;` write intrinsic visual color properties directly to element inline styles. `.agents/AGENTS.md` forbids JS from setting intrinsic visual values via inline `style.*`. Conflict coloring must be passed as a CSS custom property on the host tag element, such as `--conflict-color`, with rules in `src/css/options.css`.
- `src/js/shared/windowFit.js:15-18` `[Warning]`
  `fitContentWidth` mutates `tabs.style.width = 'fit-content'` directly, reads `getBoundingClientRect().width`, and restores `tabs.style.width = prev` to measure tab strip width. Writing inline style dimensions on `.tabs` violates the CSS source of truth rule.
- `src/js/menubar.js:131-133, 156-163, 194-196` `[Compliant]`
  Menubar flyout submenu positioning uses CSS custom properties (`--submenu-top`, `--submenu-left`, `--submenu-max-height`) on the submenu element, matching the permitted custom property exception in `.agents/AGENTS.md` and `.agents/architecture-state.md:47`.
- `src/index.html`, `src/options.html`, `src/metadata.html` `[Compliant]`
  None of the three HTML entry points contain inline `style="..."` attributes.

### Three-tier CSS scope and token discipline

- `src/css/main.css:2294-2297` `[Blocking]`
  `body.is-importing-url :is(#menubar, #file-panel) * { cursor: not-allowed; cursor: disabled; }` matches every descendant element under `#menubar` and `#file-panel`. This violates the global scope rule in `.agents/AGENTS.md` ("Global. html / body for window-wide modes. Direct rules only; never `body.foo *`"), forcing full subtree style invalidation on import state toggles.
- `src/css/main.css:1966-1969` `[Warning]`
  `#viewport.cursor-hidden, #viewport.cursor-hidden * { cursor: none !important; }` uses a broad universal selector across all viewport children. It should target `#viewport.cursor-hidden` directly or apply a dedicated cursor class.
- `src/css/main.css` hardcoded color literals `[Warning]`
  - `src/css/main.css:229, 252, 270`: `color: #fff;` hardcoded on dropdown item hover instead of using a token.
  - `src/css/main.css:557`: `color: #f5c518;` hardcoded favorite star gold instead of `var(--accent-gold)`.
  - `src/css/main.css:637`: `color: #999;` hardcoded toggle icon color instead of `var(--text-dim)`.
  - `src/css/main.css:2199`: `color: #fff;` hardcoded fullscreen exit button icon color.
  - `src/css/main.css:2267-2268`: `border-color: #d83b01; color: #d83b01;` hardcoded search error accent instead of `var(--danger)`.
  - `src/css/main.css:196, 201, 207, 211, 216, 220`: `rgba(0, 0, 0, 0.18)` and `rgba(0, 0, 0, 0.5)` hardcoded box shadows duplicated across light and dark queries instead of tokenized menu shadow custom properties.
- `src/css/options.css` hardcoded color literals `[Warning]`
  - `src/css/options.css:463`: `color: #999;` hardcoded keybind remove button color instead of `var(--text-dim)`.
  - `src/css/options.css:468`: `color: #e53935;` hardcoded keybind remove button hover color instead of `var(--danger)`.
  - `src/css/options.css:569, 579, 589`: `color: #fff;` hardcoded primary and danger button text color.
  - `src/css/options.css:717, 745`: `rgba(0, 0, 0, 0.45)` hardcoded modal backdrop color.
- Root token discipline across page sheets `[Compliant]`
  `src/css/main.css`, `src/css/options.css`, and `src/css/metadata.css` do not declare duplicate `:root` variable blocks. All tokens remain centralized in `src/css/global.css:5-90`.

### Single writer ownership

- `src/js/main/main.js:105, 194` `[Blocking]`
  `main.js` caches `const statusbar = document.getElementById('statusbar')` and executes `statusbar.classList.add('hidden')` when state mode is empty. `.agents/architecture-state.md:62` designates `menubar/statusbar.js` as the sole writer for `#statusbar`, and `menubar/chrome.js` as the manager for menu and status visibility. Reaching into `#statusbar` from `main.js` violates single-writer encapsulation.
- `src/js/main/main.js:115-126` `[Blocking]`
  `main.js` declares `setMenuItemMuted(id, muted)` and updates `#cmd-history-back` and `#cmd-history-forward` directly in `updateHistoryMenu`. Menu items belong to the menubar surface; `main.js` reaches across module boundaries into menubar DOM instead of delegating to menubar or chrome state sync.
- `src/js/menubar/chrome.js:48-51, 61-64` `[Warning]`
  `chrome.js` mutates `#cmd-toggle-menubar` and `#cmd-toggle-statusbar` directly, while `menubar.js:823-919` mutates `#cmd-toggle-filelist`, `#cmd-toggle-manhwa`, and all view options. Ownership of menu checkmark states is split between `chrome.js` and `menubar.js`.
- `src/js/menubar/statusbar.js:37-40, 60-63, 131-203` `[Compliant]`
  `statusbar.js` owns `#statusbar` inner elements, plus dual indicator routing for `.status-spread` / `#spread-indicator` and `.status-manhwa` / `#manhwa-indicator` in `#viewport`. This dual routing is documented and governed by `.agents/architecture-state.md:62`.

---

## Monolithic file decoupling and ownership plan

### Current file sizes

- `src/css/main.css`: 2,805 lines
- `src/js/menubar.js`: 920 lines
- `src/css/options.css`: 797 lines
- `src/options.html`: 704 lines
- `src/js/options/options.js`: 660 lines
- `src/index.html`: 537 lines
- `src/js/menubar/statusbar.js`: 426 lines
- `src/js/options/keybindUi.js`: 399 lines
- `src/css/global.css`: 278 lines
- `src/js/options/associationsUi.js`: 230 lines
- `src/css/metadata.css`: 126 lines
- `src/js/menubar/chrome.js`: 104 lines
- `src/js/shellBackground.js`: 81 lines
- `src/js/shared/configPreview.js`: 53 lines
- `src/metadata.html`: 44 lines
- `src/js/shared/windowFit.js`: 40 lines
- `src/js/shared/theme.js`: 32 lines
- `src/js/shared/themePrePaint.js`: 13 lines

### Single-owner split gate and architecture rules

`.agents/AGENTS.md` enforces three critical boundary constraints:
1. One sheet per HTML page: `main.css`, `options.css`, and `metadata.css` must remain single sheets. Do not break them into fragmented CSS files.
2. Pure domain modules have zero DOM imports: math, state transformations, and serialization must be separated from DOM manipulation.
3. Do not split a single DOM owner into coupled sibling files that all touch the same surface.

### Decoupling plan for menubar.js

`menubar.js` combines four distinct concerns that can be separated without splitting DOM ownership:

1. Pure geometric safe-triangle calculations (lines 41-112):
   Extract `AIM_DELAY`, `aimState` coordinate math, `isPointInTriangle`, and `isInSafeTriangle` into a pure service module: `src/js/services/menuAim.js`. It performs vector math and collision tests with zero DOM imports, accepting coordinate rectangles as plain numbers.
2. Imports menu data model derivation (lines 645-685):
   `renderImportsMenu` fetches the library tree and manifest, purges pending deletions, sorts providers, resolves active provider names, and generates display names. Extract this data aggregation logic into a pure domain function `resolveImportsMenuModel({ tree, manifest, pendingDeletions, activeProvider, providerOrder })` in `src/js/filepanel/libraryStore.js` or `src/js/services/importActions.js`. `menubar.js` then simply receives the resulting array and binds it to DOM rows.
3. View menu state mapping (lines 778-803, 823-919):
   `syncViewMenu` translates raw Core state into label strings and boolean checked flags for 15 actions. Extract this derivation into a pure helper `deriveViewMenuState(coreState)` in `src/js/services/actions.js` or a domain helper. `menubar.js` takes the resulting snapshot and updates element classes in one pass.
4. Menubar and Chrome boundary consolidation:
   Remove `#cmd-history-back` and `#cmd-history-forward` mutation from `src/js/main/main.js:122-126`. Move history menu item state syncing into `menubar.js:syncViewMenu`, where all other command states are maintained.

### Decoupling plan for options.js

`options.js` contains three large sub-features that should be extracted into focused siblings, mirroring the pattern of `keybindUi.js` and `associationsUi.js`:

1. Custom CSS editor module:
   Extract lines 386-485 (Prism live syntax highlighting, scroll synchronization, ResizeObserver, CSS import, CSS export, and local preview triggering) into `src/js/options/customCssEditor.js`. This isolates the editor DOM (`#opt-custom-css`, `#opt-custom-css-highlight`, `#btn-import-css`, `#btn-export-css`, `#btn-save-apply-css`) and removes Prism editor complexity from core options persistence.
2. Pure config form serialization:
   Extract `mergeFilterOptions` (lines 488-501) and `buildConfigFromForm` (lines 503-544) into a pure service function in `src/js/keybinds.js` or `src/js/services/keybindDomain.js`. This allows testing config serialization without instantiating the options window DOM.
3. Library relocation flow and error translation:
   Extract `saveErrorMessage` (lines 48-81), `relocationWarningMessage` (lines 83-91), and `pathsMatch` (lines 93-96) into a pure service in `src/js/services/libraryDomain.js` or `src/js/fsUtils.js`.

### CSS cleanup for `main.css` and `options.css`

1. Dead selectors:
   - `src/css/options.css:541-544`: `.scroll-mode-label` is unused. The HTML element uses `.keybind-name` (`src/options.html:310`).
   - `src/css/main.css:752-760`: `.lib-remove .lib-remove-box` is dead CSS. `filePanel.js:841, 1317` sets `removeBtn.innerHTML = EMPTY_BOX_HTML`, which injects an inline SVG icon (`MARU_O_SVG`), leaving `.lib-remove-box` orphaned.
2. Fragmented statusbar styles in `main.css`:
   Statusbar rules are split into two disjoint regions: `#statusbar.refreshing` pulse animation at lines 1382-1393, and `#statusbar` structure at lines 2694-2805. Move the refreshing animation down into lines 2694-2805 to keep all statusbar CSS together.
3. Submenu drop shadow redundancy in `main.css`:
   Lines 195-221 define submenu box shadows 4 separate times across light mode, `@media (prefers-color-scheme: dark)`, and `:root[data-theme="dark"]`. Replace these with single rules utilizing `var(--menu-shadow)` or tokenized custom properties.
4. Overly specific selector chains to simplify:
   - `body.is-importing-url :is(#menubar, #file-panel) *` (`src/css/main.css:2294`): Replace with `body.is-importing-url #menubar, body.is-importing-url #file-panel { pointer-events: none; }`.
   - `body.is-importing-url .menu-trigger:hover, body.is-importing-url #file-panel-favorites-header:hover...` (`src/css/main.css:2299-2305`): Eliminated once pointer-events are disabled on the container.
   - `#viewport.cursor-hidden, #viewport.cursor-hidden *` (`src/css/main.css:1966-1969`): Replace with `#viewport.cursor-hidden { cursor: none !important; }`.

---

## Performance, style invalidation, and window-fit behavior

### Statusbar update frequency and layout reads

- Forced synchronous layout on refresh pulse:
  `src/js/menubar/statusbar.js:101-103`:
  ```javascript
  statusbar.classList.remove('refreshing');
  if (statusbar) void statusbar.offsetWidth;
  statusbar.classList.add('refreshing');
  ```
  `void statusbar.offsetWidth` forces a synchronous style recalculation and layout reflow to restart the CSS animation. This can be replaced by resetting the animation via the Web Animations API (`statusbar.getAnimations()`) or removing and re-adding the class in a `requestAnimationFrame` callback.
- Unguarded DOM writes during state updates:
  In `src/js/menubar/statusbar.js:258-278`, during importing or downloading states:
  ```javascript
  if (statusDims) statusDims.textContent = 'N/A';
  if (statusZoom) statusZoom.textContent = 'N/A';
  if (statusName) {
    statusName.textContent = 'Importing...';
    statusName.title = 'Importing...';
  }
  ```
  Unlike lines 225, 237, 247, and 254 where `textContent` is guarded with `!== text`, these lines mutate DOM properties unconditionally on every state change event while importing or downloading.
- High-frequency calls during image rendering:
  `src/js/viewer/viewerRender.js` calls `Statusbar.setImage(...)` at lines 108, 250, 399, 544, 782, and 801. Every invocation executes `Statusbar.syncSpreadIndicator` and `Statusbar.syncManhwaIndicator` (`statusbar.js:400-401`). While `textContent` is checked before writing, reading class attributes on every frame adds minor overhead.
- Hot-path zoom updates:
  `src/js/menubar/statusbar.js:405-410` (`setZoom`) is called directly on zoom transforms. It checks `if (statusZoom.textContent !== text) statusZoom.textContent = text;`, which avoids layout thrashing during pan and zoom.

### Menubar flyout submenu positioning and dynamic rebuilding

- Forced layout thrashing in submenu positioning:
  `src/js/menubar.js:154-166`:
  ```javascript
  const rect = item.getBoundingClientRect(); // Layout read
  const topPos = Math.max(4, rect.top - 4);
  aimState.activeSubmenu.style.setProperty('--submenu-top', `${topPos}px`); // Style write
  aimState.activeSubmenu.style.setProperty('--submenu-left', `${rect.right}px`); // Style write
  aimState.activeSubmenu.dataset.side = 'right'; // DOM write
  const maxH = window.innerHeight - topPos - 8;
  aimState.activeSubmenu.style.setProperty('--submenu-max-height', `${Math.max(120, maxH)}px`); // Style write
  const subW = aimState.activeSubmenu.offsetWidth || 180; // Forced layout read!
  if (rect.right + subW > window.innerWidth) {
    aimState.activeSubmenu.style.setProperty('--submenu-left', `${Math.max(0, rect.left - subW)}px`); // Style write
    aimState.activeSubmenu.dataset.side = 'left'; // DOM write
  }
  ```
  Reading `aimState.activeSubmenu.offsetWidth` immediately after writing `--submenu-*` custom properties forces the browser to flush styles and compute layout synchronously before the next line can execute.
- Layout queries inside mousemove events:
  `src/js/menubar.js:63-112, 282-295`:
  `isInSafeTriangle` calls `submenu.getBoundingClientRect()` and `triggerItem.getBoundingClientRect()` inside the dropdown `mousemove` event handler whenever a submenu is open. If the user moves the mouse rapidly across dropdown items, bounding box queries run on every pointer event.
- Dynamic Imports menu network requests on open:
  `src/js/menubar.js:214, 224, 236, 645-660`:
  `renderImportsMenu` executes `fetchLibraryTree()` and `fetchManifest()` concurrently via `Promise.all` every time the Imports dropdown is opened. If the remote manifest or local tree read takes time, DOM rows render asynchronously after a delay.

### Custom CSS Prism live highlighting and theme preview messaging

- Synchronous Prism syntax highlighting on input:
  `src/js/options/options.js:392-410`:
  `syncHighlight` executes `window.Prism.highlight(text, window.Prism.languages.css, 'css')` synchronously on every `input` event on the textarea. There is no debounce or throttle. If a user pastes a large CSS stylesheet of several hundred lines, the syntax parser runs synchronously on the main UI thread on every keystroke, causing noticeable typing latency.
- Live theme preview messaging:
  `src/js/options/options.js:316-326` and `src/js/shared/configPreview.js:22-30`:
  Theme and CSS preview events (`theme-preview`, `css-preview`) emit Tauri events across windows without touching `localStorage`. `localStorage` writes occur only upon clicking Save (`src/js/options/options.js:580-583`). Canceling or closing the window triggers `revertPreviewChanges` (`src/js/options/options.js:355-383`), which reverts all windows to saved settings without leaving orphaned preview state in `localStorage`.

### Window-fit constants and measurement behavior

- Layout measurement in `windowFit.js`:
  `src/js/shared/windowFit.js:11-25`:
  `fitContentWidth` measures `document.querySelector('.tabs')` width, adds body padding, and invokes `fit_options_window`. The measurement assumes `.tabs` is the widest element. If any tab content, such as the keybinds list or custom CSS editor, requires more width, the content relies on horizontal shrinking or overflow scrolling.
- Window cap synchronization:
  - `src/js/shared/windowFit.js:4-5`: `OPTIONS_MAX_INITIAL_W = 560; META_MAX_INITIAL_H = 600;`
  - `src-tauri/src/windows.rs:51, 60`: `OPTIONS_MAX_W: f64 = 560.0; META_MAX_H: f64 = 600.0;`
  The JS caps and Rust constants are in exact numerical agreement.
- Metadata height measurement:
  `src/js/shared/windowFit.js:30-39` measures `document.getElementById('metadata-root').scrollHeight` and clamps to `META_MAX_INITIAL_H` (600px). If metadata contains lengthy notes or multiple credits, `metadata.css:3` enables `overflow-y: auto`, preventing content clipping.

---

## Detached workspace and multi-window chrome behavior

### Detached workspace with file list surface

When the file panel is detached into a secondary window, `src/index.html` loads with `?surface=fileList`:

1. Surface and role resolution:
   `src/js/shared/workspaceHost.js:10` parses `location.search` and exports `workspaceSurface = 'fileList'`. `src/js/menubar/chrome.js:17` resolves `windowRole = 'fileList'`.
2. Menubar visibility per window role:
   `src/js/menubar/chrome.js:27`:
   `setMenuBarVisible(fd.window_menu_visible?.[windowRole] ?? fd.menu_visible !== false);`
   Menubar visibility is stored separately in `frontend_data.window_menu_visible.main` and `frontend_data.window_menu_visible.fileList`. Toggling the menubar in the detached file list window persists only for that window role via `Core.setWindowMenuVisible(windowRole, visible)`.
3. Statusbar suppression in detached window:
   `src/js/menubar/chrome.js:59-64`:
   In `fileList` mode, `disabled = true`. `#statusbar` receives `.hidden`, the statusbar toggle command `#cmd-toggle-statusbar` receives `.muted` and `aria-disabled="true"`, and statusbar persistence is skipped.
4. Viewport suppression in detached window:
   `src/css/main.css:497`:
   `:root[data-workspace-surface="fileList"] #viewport { display: none; }` hides the viewport. Conversely, `:root[data-workspace-surface="main"] #workspace[data-file-list-position="detached"] > #file-panel { display: none; }` hides the file list in the main window.
5. Menu bar cross-window action routing:
   The detached file list window contains a complete copy of the menubar markup (`#menu-view`, `#menu-folder`, etc.). When a user clicks a viewport command (such as Fit, Zoom, or Filter) inside the detached file list menubar, `workspaceControls.js:34-45` catches the action and forwards it via `requestWorkspace('main', 'action', 'run', [id, forwarded])`.

### State flush and race conditions before Options save

`src/js/options/options.js:563-575`:
```javascript
let liveConfig = config;
if (invoke) {
  try {
    await initWorkspaceClient();
    await requestWorkspace('main', 'core', 'flushConfig');
  } catch {}
  try {
    liveConfig = mergeConfig(await invoke('load_config'));
  } catch {}
}
```

1. Swallowed timeout on main window flush:
   If the main window is minimized, suspended by the OS, or unresponsive, `requestWorkspace('main', ...)` fails silently. `options.js` proceeds to load whatever config is currently on disk, which may omit in-memory runtime updates.
2. Detached window state exclusion:
   `flushConfig` is requested exclusively from `'main'`. If the user performed actions in the detached `fileList` window that haven't synchronized to `main` before Options saves, those updates could be overwritten when `options.js` saves the merged config.
3. Config update broadcast handling:
   When Options emits `config-updated` (`src/js/options/options.js:609`), `src/js/main/main.js:345-352` catches the event. In the detached window (`workspaceSurface === 'fileList'`), it applies theme changes and exits early without reloading directory sort or library trees, leaving full state reconciliation to the primary session forwarder in `main`.

### Theme synchronization across windows

1. Live theme preview:
   `configPreview.js:22-30` emits `theme-preview` and `css-preview` events.
   - `src/js/main/main.js:319-338` listens to `theme-preview` and calls `applyTheme(theme)`.
   - `src/js/shellBackground.js:74-75` listens to `theme-preview` and re-queries `--surface` from `#measure-probe`, setting the native window background via `plugin:window|set_background_color`.
2. Saved theme application:
   When saved in Options, `theme.js:12-16` invokes `update_theme` with the new theme name. In `src-tauri/src/windows.rs:350-373`, Rust iterates over all open windows and calls `win.set_theme(tauri_theme)`. Simultaneously, `localStorage.setItem('quivit-theme', ...)` triggers the `storage` event in any background secondary windows (`src/js/shellBackground.js:77-79`), updating background colors window-wide.

---

## Redundant code, shared helpers, and stale references

### Duplicated DOM helpers and menu state toggling

1. Menu item muting duplication:
   - `src/js/main/main.js:115-120`:
     ```javascript
     function setMenuItemMuted(id, muted) {
       const item = document.getElementById(id);
       if (!item) return;
       item.classList.toggle('muted', muted);
       item.setAttribute('aria-disabled', muted ? 'true' : 'false');
     }
     ```
   - `src/js/menubar.js:805-821`:
     ```javascript
     function _setMenuItemDisabled(id, disabled, note = '') {
       const el = document.getElementById(id);
       if (!el) return;
       el.classList.toggle('muted', disabled);
       el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
       // title handling
     }
     ```
   Both functions perform the same class and attribute toggling. `setMenuItemMuted` in `main.js` should be deleted, with menu state delegated to `menubar.js`.
2. Path equality helper duplication:
   - `src/js/options/options.js:93-96`:
     ```javascript
     function pathsMatch(left, right) {
       return String(left || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
         === String(right || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
     }
     ```
   - `src/js/filepanel/filePanel.js:835-838`:
     ```javascript
     function _pathsEqual(a, b) {
       if (!a || !b) return false;
       return a.toLowerCase() === b.toLowerCase();
     }
     ```
   Path normalization and comparison should be unified in `src/js/fsUtils.js`.
3. Keyboard navigation duplication in dropdown menus:
   `src/js/menubar.js:603-617` (Favorites loadout navigation) and `src/js/menubar.js:751-762` (Imports provider navigation) duplicate identical arrow-key indexing logic:
   ```javascript
   const items = Array.from(dropdown.querySelectorAll('li[role^="menuitem"]'));
   const idx = items.indexOf(row);
   if (idx !== -1) {
     e.preventDefault();
     e.stopPropagation();
     const nextIdx = e.key === 'ArrowDown'
       ? (idx + 1) % items.length
       : (idx - 1 + items.length) % items.length;
     items[nextIdx].focus();
   }
   ```
   This duplicates logic that already exists in `src/js/keyboardNav.js`.

### Repeated config defaults across modules

`src/js/keybinds.js` defines authoritative constants:
- `DEFAULT_KEYBOARD_PAN_STEP = 72;`
- `DEFAULT_WHEEL_PAN_STEP = 120;`
- `DEFAULT_HIDE_CURSOR_DELAY_SEC = 2;`

`src/js/options/options.js:177-179` ignores these constants and hardcodes the raw numbers:
```javascript
document.getElementById('opt-hide-cursor-delay').value = typeof config.frontend_data.hide_cursor_delay_sec === 'number' ? config.frontend_data.hide_cursor_delay_sec : 2;
document.getElementById('opt-keyboard-pan-step').value = config.frontend_data.keyboard_pan_step || 72;
document.getElementById('opt-wheel-pan-step').value = config.frontend_data.wheel_pan_step || 120;
```
`options.js` also hardcodes the fallback theme `'system'` (line 197) and Anime4K variant `'fast'` (line 212) instead of reading from normalized config definitions.

### Unused and dead CSS rules

1. `src/css/options.css:541-544`:
   `.scroll-mode-label` is defined with `flex: 1; font-size: var(--fs-12);`. In `src/options.html:310`, the label uses class `.keybind-name`. The `.scroll-mode-label` rule is dead.
2. `src/css/main.css:752-760`:
   `.lib-remove .lib-remove-box` defines a circle border for library item deletion. The deletion button was refactored in `filePanel.js:1317` to render inline SVG (`MARU_O_SVG`), leaving `.lib-remove-box` unused.

### Pageobject selectors to preserve

The following selectors are queried by end-to-end pageobjects and must remain intact during refactoring:

#### Menubar selectors in menubar.page.js
- Containers and triggers: `#menubar`, `#menu-file`, `#menu-file .menu-trigger`, `#menu-folder`, `#menu-folder .menu-trigger`, `#menu-view`, `#menu-view .menu-trigger`
- File menu items: `#cmd-open-dir`, `#cmd-open-file`, `#cmd-options`, `#cmd-quit`
- Folder menu items: `#cmd-history-back`, `#cmd-history-forward`, `#cmd-next`, `#cmd-prev`, `#cmd-open-next-container`, `#cmd-open-prev-container`, `#cmd-parent`, `#cmd-refresh`
- View menu items: `#cmd-zoom-in`, `#cmd-zoom-out`, `#cmd-zoom-100`, `#cmd-fit-none`, `#cmd-fit-width`, `#cmd-fit-height`, `#cmd-fit-best`, `#cmd-fit-width-if-larger`, `#cmd-fit-height-if-larger`, `#cmd-fit-window-if-larger`
- Labels: `#scaling-current-label`, `#filter-current-label`, `#spread-current-label`
- Spread controls: `#cmd-spread-off`, `#cmd-spread-direction-rtl`, `#cmd-spread-direction-ltr`
- UI toggles: `#cmd-toggle-filelist`, `#cmd-toggle-menubar`, `#cmd-toggle-statusbar`, `#cmd-fullscreen`, `#cmd-toggle-manhwa`
- Filter selection items: `#cmd-filter-off`, `#cmd-toggle-anime4k-filter`, `#cmd-toggle-crt-filter`, `#cmd-toggle-phosphor-filter`, `#cmd-toggle-scanlines-filter`
- Scaling selection items: `#cmd-scale-lanczos`, `#cmd-scale-none`, `#cmd-scale-bilinear`

#### Options selectors in options.page.js
- Tab buttons: `.tab-btn[data-target="tab-general"]`, `.tab-btn[data-target="tab-keys"]`, `.tab-btn[data-target="tab-associations"]`, `.tab-btn[data-target="tab-customization"]`, `.tab-btn[data-target="tab-language"]`
- General inputs: `#opt-show-hidden`, `#opt-start-dir`, `#btn-browse-start`, `#opt-continue-last`, `#opt-remember-last-image`, `#opt-single-instance`, `#opt-hide-chrome-fullscreen`, `#opt-open-first-image`, `#opt-keyboard-pan-step`, `#opt-wheel-pan-step`, `#opt-hide-cursor-delay`, `#opt-portable-mode`
- Customization: `.theme-btn`, `.theme-btn[data-theme="..."]`, `#opt-custom-css`, `#btn-save-apply-css`
- Footer buttons and status: `#btn-save-options`, `#btn-cancel`, `#options-status`

#### Statusbar selectors in statusbar.page.js
- Container: `#statusbar`, `#statusbar.hidden`
- Readouts: `#statusbar .status-filename`, `#statusbar .status-scroll-zoom`, `#statusbar .status-spread`, `#statusbar .status-manhwa`, `#statusbar .status-dims`, `#statusbar .status-index`, `#statusbar .status-zoom`, `#statusbar .status-fit`, `#statusbar .status-scaling`, `#statusbar .status-filter`, `#statusbar .status-version`
