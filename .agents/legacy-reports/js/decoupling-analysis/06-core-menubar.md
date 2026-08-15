# core.js & menubar.js — Decoupling Analysis

> Files: `src/js/core.js` (~386 lines) and `src/js/menubar.js` (~150 lines).

## Part 1 — core.js

### Exports (Core API — 17 members)
| Method | Purpose |
|---|---|
| `onStateChange(fn)` | Registers listener; receives shallow snapshot on every `_notify()` |
| `getState()` | Returns `{ ..._state }` (shallow copy) |
| `persistConfig({immediate, debounceMs})` | Debounced or immediate config save |
| `flushConfig()` | Forces pending save if dirty |
| `setListAndIndex(newList, newIndex)` | Bulk-set list + index |
| `setState(partial)` | Shallow merge partial state |
| `setFileListVisible(visible, {notify})` | UI-state flag for file panel |
| `toggleTransparentBg()` | Flips transparent_bg, schedules flush |
| `setFitMode(mode, {persist})` | Fit state, optional persistence |
| `setScalingMode(mode, {persist})` | Scaling state, optional persistence |
| `navigate(delta)` | Wrap-around selection move |
| `jumpToIndex(index)` | Activating jump (opens dirs/archives/parents) |
| `selectIndex(index)` | Passive select |
| `loadConfig()` | Pulls config, merges, applies theme, notifies |
| `saveConfig(portable_mode, frontend_data)` | Full config write |
| `init()` | Startup orchestration |

### Imports
- `./keybinds.js` → DEFAULT_FIT_MODE, DEFAULT_KEYBINDS, DEFAULT_SCALING_MODE, mergeConfig
- `./fsUtils.js` → FsUtils (navigation, path building, prefetch)
- Global: `window.__TAURI__.core.invoke` (destructured at module top)

**Core imports no UI modules.** Dependency direction strictly one-way (UI imports Core).

### DOM access — the "no DOM" claim is VIOLATED
- **L306–308:** `document.documentElement.removeAttribute/setAttribute('data-theme')` — direct DOM mutation (theme application).
- **L309–311:** `localStorage.setItem/removeItem('quivit-theme')`.
- **L322:** `window.dispatchEvent(new CustomEvent('quivit-config-loaded'))`.
- Everything else is DOM-free. **~90% pure; the theme-application block is the single contract violation.**

### Responsibility clusters
1. State machine — `_state`, `_listeners`, `_notify`, getState, onStateChange, setState, setListAndIndex.
2. Selection / navigation — `_selectEntry`, navigate, jumpToIndex, selectIndex, incl. last-active-image tracking, object-URL revocation, archive prefetch dispatch.
3. Config persistence — `_persistConfig`, `_flushConfig`, `_scheduleConfigFlush`, persistConfig, flushConfig, loadConfig, saveConfig.
4. Fit / scaling modes — setFitMode, setScalingMode.
5. Transparent background — toggleTransparentBg.
6. File list visibility — setFileListVisible (state flag only; main.js handles DOM with {notify:false}).
7. Last-active-image tracking — in `_selectEntry`.
8. Startup orchestration — `init()`.

### Coupling
- **Callback surface:** `_listeners` consumed by exactly two subscribers — main.js and viewer.js.
- **Second channel:** `window.dispatchEvent('quivit-config-loaded')` — an untyped pub/sub parallel to `_listeners`.
- **Shared-reference leak:** getState()/notify() snapshots are shallow; `state.config`/`state.list` are live references. Consumers mutate config through them: main.js (status_visible, emergency reset), menubar.js (menu_visible), filePanel.js (favorites), shortcuts.js (scroll_zoom_latched). Invisible coupling.
- **Mutual import with fsUtils.js** — deliberate bidirectional pair (fsUtils calls Core.setState/persistConfig; Core calls FsUtils.loadFile). Acceptable.

### Code smells
- **toggleFileList is NOT in core.js** — it lives in main.js; core's setFileListVisible is actively used. The smell is that main.js re-implements a parallel setFileListVisible/toggleFileList wrapping Core's.
- **Dead public API:** `saveConfig(portable_mode, frontend_data)` exported but never called anywhere in src/.
- **Duplicate persistence paths:** `_persistConfig()` direct (immediate) in `_selectEntry` vs debounced `_scheduleConfigFlush` everywhere else.
- **Shallow-copy mutation risk** — biggest design smell.
- **Theme DOM block in loadConfig** violates the module's own stated contract.
- **init() overreach** — mixes config load, startup path resolution, file loading, show_window timing.
- **Overlapping selection API** — jumpToIndex, selectIndex, setListAndIndex all funnel into `_selectEntry` with different flags.

### Decoupling verdict
Already well-decoupled. Single-direction callback flow, no UI imports, clear cluster separation, debounced persistence owned here. **Three blemishes:** (1) move the theme-application DOM block out of loadConfig (dispatch a `theme-changed` event or delegate to main.js), (2) delete or wire up saveConfig, (3) make getState() deep-clone or freeze config so consumers stop mutating shared state.

## Part 2 — menubar.js

### Exports (8)
| Export | Kind | Used by |
|---|---|---|
| `menuBarVisible` | mutable `let` | main.js reads directly |
| `initMenuBar()` | fn | main.js |
| `closeMenus()` | fn | main.js imports but **never calls it**; internal use only |
| `setMenuBarVisible(visible, {persist})` | fn | main.js |
| `toggleMenuBar({persist})` | fn | main.js |
| `saveUIState()` | fn | internal use only (not imported anywhere) |
| `getPreFullscreenState()` | fn | main.js |
| `setPreFullscreenState(state)` | fn | main.js |

### Imports
- `Core` from `./core.js`
- **`Viewer` from `./viewer.js` — DEAD IMPORT** (grep confirms single match at L7).

**DOM access: Heavy — entirely DOM-coupled.** `document.getElementById('menubar')` at module scope, querySelectorAll, addEventListener on triggers/items/document, classList toggling, focus() calls. Zero pure logic beyond a boolean flag and the `_preFullscreenState` box.

### Responsibility clusters
1. Menubar open/close — `activeMenu` tracking, closeMenus(), outside-click close.
2. Dropdown menu logic — mousedown/mouseenter on triggers, keyboard nav (Enter/Space/Arrow/Escape/Left/Right).
3. Menu visibility toggle — setMenuBarVisible/toggleMenuBar, `menuBarVisible` export, `.hidden` class, close-on-hide.
4. Visibility persistence — saveUIState() writes `config.frontend_data.menu_visible` + Core.persistConfig({debounceMs:1500}).
5. Pre-fullscreen state storage — get/setPreFullscreenState wrapping `_preFullscreenState`.

### Coupling / overlap with main.js (fullscreen chrome)
- Fullscreen chrome handling lives in **main.js**, but supporting state is split across both files:
- **`menuBarVisible`** — mutable module-level `let` exported, main.js reads/writes directly — no accessor.
- **`statusBarVisible`** — entirely separate `let` in main.js — same concept, different home.
- **`_preFullscreenState`** stored in menubar.js but owned/consumed entirely by main.js — wrong module.
- **Persistence duplication:** menubar.js writes menu_visible + main.js writes status_visible using the identical pattern. Two debounce timers; since `_scheduleConfigFlush` clears the prior timer, rapid toggling cancels each other's pending flush (last writer wins) — latent correctness smell.
- **main.js pokes menubar DOM** menubar.js owns: updateViewToggleMenu toggles `cmd-toggle-menubar` checkmark; startup restore calls setMenuBarVisible.

### Code smells
1. Dead import `Viewer`.
2. Exported-but-unused-in-main `closeMenus`.
3. Exported-but-internal `saveUIState`.
4. Mutable `let` export for menuBarVisible — no notification on change.
5. `_preFullscreenState` in the wrong module.
6. Direct mutation of Core.getState() config in saveUIState() — shallow-copy leak.
7. `initMenuBar` is a trivial wrapper around bindMenus().
8. Synthetic KeyboardEvent re-dispatch for Left/Right arrow hand-off — fragile.

### Decoupling recommendations
1. Remove the dead `Viewer` import.
2. Move `_preFullscreenState` (get/set) into main.js (or a future `chrome.js`).
3. Un-export `saveUIState`; keep closeMenus exported only if a future module needs it.
4. Convert `menuBarVisible` to an accessor (`isMenuBarVisible()`) or push visibility into Core state.
5. Consolidate the two parallel persistence blocks (menu_visible + status_visible) into one `saveChromeState()` in a single owner.
6. Move the `cmd-toggle-menubar` checkmark sync (updateViewToggleMenu) into menubar.js, or pass a callback.

## Part 3 — Cross-file overlap

**Q: Is menu/status bar visibility duplicated between menubar.js and main.js? Yes — substantially.**

| Concept | Owned in menubar.js | Owned in main.js |
|---|---|---|
| Menubar visibility flag | `menuBarVisible` (exported let) | reads/writes it directly |
| Statusbar visibility flag | — | `statusBarVisible` (L90), setStatusBarVisible (L368) |
| Persist menu_visible | saveUIState() | startup restore |
| Persist status_visible | — | setStatusBarVisible persist block |
| Pre-fullscreen snapshot | storage | read/write logic |
| Toggle handlers | toggleMenuBar | toggleStatusBar |
| Checkmark sync | — | updateViewToggleMenu |

**Q: Should menubar.js own all menubar DOM? Yes** — it should own `#menubar`, dropdowns, and visibility class. Gaps: updateViewToggleMenu in main.js reaches into menubar DOM; setMenuBarVisible called from main.js fullscreen chrome (fine, cross-module API use). The recommended consolidation: a small `chrome.js` module owning *both* menuBarVisible + statusBarVisible (flags, `.hidden` toggles, saveChromeState() persistence, fullscreen hide/restore), leaving menubar.js with pure dropdown interaction.

## Part 4 — Pure vs UI-coupled

| Module | Purity | Notes |
|---|---|---|
| core.js | ~90% pure | One impurity: theme-application DOM block in loadConfig. Platform boundary via invoke is legitimate. |
| menubar.js | 0% pure | All DOM + events. |

**Bottom line:** core.js is already a proper pure state machine; fix its three blemishes rather than rearchitect. menubar.js is a pure DOM module with ownership leaks (pre-fullscreen storage, menu visibility flag, persistence) bleeding into main.js. The single highest-value move is consolidating menu/status visibility + fullscreen chrome state into one owner.