# QuiviT JS Refactoring & Decoupling — Final Passthrough Report

> **Date:** August 15, 2026  
> **Status:** Final Architectural Review & Decoupling Passthrough  
> **Scope:** Full-codebase audit across all 34 JavaScript scripts, shared services, window controllers, and HTML integrations.

---

## Executive Summary

Following the 9-slice JavaScript DOM Decoupling initiative outlined in `.agents/legacy-reports/js/js-dom-decoupling-plan.md`, a comprehensive multi-agent architectural audit was conducted across the entire frontend codebase.

The refactoring has successfully transitioned QuiviT from monolithic, cross-probing scripts into a modular, unidirectional architecture:
- **`core.js`** operates as a clean state machine with zero DOM manipulation.
- **`services/`** encapsulates pure domain logic (actions registry, viewport geometry, keybind safety rules, sorting, key combinations) with zero DOM dependencies.
- **`viewer/`** cleanly isolates mathematical viewport state, gesture inputs, and DOM image pool lifecycle / RAF transforms.
- **`menubar/`**, **`filepanel/`**, **`main/`**, **`options/`**, and **`shared/`** contain dedicated, single-owner UI controllers.

This final passthrough report documents all identified dead code, stale functions, unused imports/exports, selector discrepancies, hot-path performance opportunities, and provides an authoritative monolith evaluation across all modules.

---

## 1. Monolith & Architecture Granularity Audit

A key requirement of this audit is evaluating large modules (`fsUtils.js`, `filePanel.js`, `shortcuts.js`, `options.js`, `keybindUi.js`, `actions.js`, `viewerRender.js`) to determine whether further decoupling is warranted or would constitute counter-productive over-engineering.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             MODULE SIZING & COHESION MAP                         │
├───────────────────────┬────────────┬─────────┬───────────────────────────────────┤
│ Module                │ Size / LOC │ Status  │ Verdict                           │
├───────────────────────┼────────────┼─────────┼───────────────────────────────────┤
│ `fsUtils.js`          │ 25.6KB/705 │ Cohesive│ DO NOT SPLIT (Unified I/O & Nav)  │
│ `filepanel/filePanel` │ 25.2KB/778 │ Cohesive│ DO NOT SPLIT (Single DOM Owner)   │
│ `shortcuts.js`        │ 16.3KB/430 │ Cohesive│ DO NOT SPLIT (Input Normalizer)   │
│ `options/keybindUi`   │ 16.6KB/449 │ Cohesive│ DO NOT SPLIT (UI Capture Engine)  │
│ `options/options.js`  │ 13.4KB/336 │ Cohesive│ DO NOT SPLIT (Window Controller)  │
│ `services/actions.js` │ 13.4KB/320 │ Cohesive│ DO NOT SPLIT (Action Registry)    │
│ `core.js`             │ 12.2KB/386 │ Cohesive│ DO NOT SPLIT (Pure State Machine) │
│ `viewerRender.js`     │ 10.1KB/308 │ Cohesive│ DO NOT SPLIT (Pool & Render Sync) │
└───────────────────────┴────────────┴─────────┴───────────────────────────────────┘
```

### Module Breakdown & Decoupling Verdicts

1. **[`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js) (25.6 KB, 705 lines)**
   - **Role:** Centralized filesystem & archive traversal engine, path resolution, thumbnail prefetching, and navigation coordinator.
   - **Evaluation:** High cohesion. Navigation operations (`loadFile`, `loadArchive`, `applyDirectoryResult`, `openParent`, `openSibling`, `refresh`, `prefetchAhead`) share state-token generation (`_navigationGeneration`) and race-condition guards.
   - **Verdict: DO NOT DECOUPLE.** Splitting archive navigation from directory navigation would introduce artificial indirection and cross-file generation coordination for zero architectural benefit.

2. **[`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) (25.2 KB, 778 lines)**
   - **Role:** Sole DOM owner for the file panel (list rendering, column sizing via CSS variables, favorites list, breadcrumbs, resize drag handle).
   - **Evaluation:** Pure favorites state and persistence were already cleanly extracted to `favoritesStore.js` in Slice 6. The remaining code is exclusively DOM rendering and UI event listeners scoped to `#file-panel`.
   - **Verdict: DO NOT DECOUPLE.** Splitting a single DOM container into sibling sub-DOM files merely relocates DOM queries without eliminating coupling.

3. **[`src/js/shortcuts.js`](file:///E:/Projects/QuiviT/src/js/shortcuts.js) (16.3 KB, 430 lines)**
   - **Role:** Global window input listener, modifier latch manager, keyboard pan vector accumulator, and gesture normalizer.
   - **Evaluation:** High cohesion as the window-level input event pipeline preceding `services/actions.js`.
   - **Verdict: DO NOT DECOUPLE.** Single input owner; straightforward flow.

4. **[`src/js/options/keybindUi.js`](file:///E:/Projects/QuiviT/src/js/options/keybindUi.js) (16.6 KB, 449 lines) & [`src/js/options/options.js`](file:///E:/Projects/QuiviT/src/js/options/options.js) (13.4 KB, 336 lines)**
   - **Role:** Options window orchestrator and keybind table capture controller.
   - **Evaluation:** Pure domain logic (categories, locked bindings, conflict colors, menubar safety rules) was extracted into `services/keybindDomain.js` in Slice 7. What remains in `keybindUi.js` is strictly DOM rendering and interactive capture styling.
   - **Verdict: DO NOT DECOUPLE.** Clean separation between domain rules and UI presentation.

5. **[`src/js/services/actions.js`](file:///E:/Projects/QuiviT/src/js/services/actions.js) (13.4 KB, 320 lines)**
   - **Role:** Single declarative registry for all application actions, user labels, categories, default bindings, and handlers.
   - **Verdict: DO NOT DECOUPLE.** Serves as the single source of truth for the entire application.

---

## 2. Stale Functions, Dead Code & Inactive References

Across all analyzed modules, the following dead code, stale references, and uncalled functions were identified for surgical removal:

### 2.1 State & Method Remnants in `core.js`
- **Dead State — `decodedSrc` ([`core.js:L54`](file:///E:/Projects/QuiviT/src/js/core.js#L54)):** Written to in `viewerRender.js` (`Core.setState({ decodedSrc: state.src })`), but **never read** by any consumer. Crucially, calling `Core.setState({ decodedSrc })` causes `Core._notify()` to fire an extra full cascade of `onStateChange` listeners across all modules on every image decode.
- **Dead State — `parentDirectory` ([`core.js:L69`](file:///E:/Projects/QuiviT/src/js/core.js#L69)):** Assigned in `fsUtils.js`, but unread across the application (navigation uses `FsUtils.openParent()` / `parentOf()`).
- **Dead Method — `Core.saveConfig` ([`core.js:L330-343`](file:///E:/Projects/QuiviT/src/js/core.js#L330-L343)):** Uncalled across the codebase (Options saves directly via backend IPC; runtime saves use `Core.persistConfig()`).
- **Top-Level Destructuring Guard ([`core.js:L42`](file:///E:/Projects/QuiviT/src/js/core.js#L42)):** `const { invoke } = window.__TAURI__.core;` should use optional chaining (`window.__TAURI__?.core?.invoke;`) to prevent runtime errors in testing/headless environments.

### 2.2 Dead Functions & Path Inconsistencies in `fsUtils.js`
- **Dead Function — `FsUtils.openContainer` ([`fsUtils.js:L462-479`](file:///E:/Projects/QuiviT/src/js/fsUtils.js#L462-L479)):** Obsolete IPC wrapper superseded by client-side `FsUtils.openSibling(delta)`.
- **Duplicate Helper — `_basename` ([`fsUtils.js:L59-61`](file:///E:/Projects/QuiviT/src/js/fsUtils.js#L59-L61)):** Redundant internal duplicate of public `FsUtils.basename`.
- **Unused Destructure ([`fsUtils.js:L6`](file:///E:/Projects/QuiviT/src/js/fsUtils.js#L6)):** `convertFileSrc` destructured on line 6 is unused (invoked directly via `window.__TAURI__.core.convertFileSrc`).
- **Root-Drive Path Truncation ([`fsUtils.js:L366`](file:///E:/Projects/QuiviT/src/js/fsUtils.js#L366)):** `loadArchive` computes parent directory with an inline regex that fails on root Windows drives (`E:\` becomes `E:`). Should use `parentOf(result.archive_path)`.

### 2.3 Dead Code & Selectors in Input / Gestures
- **Unused Import — `PASSIVE_ACTIONS` ([`shortcuts.js:L5`](file:///E:/Projects/QuiviT/src/js/shortcuts.js#L5)):** Handled internally in `keyCombo.js`.
- **Unused Re-exports ([`shortcuts.js:L7`](file:///E:/Projects/QuiviT/src/js/shortcuts.js#L7)):** `normalizeCombo, formatKeyName, formatKeysCombo, normalizeList` re-exported but unneeded.
- **UI Selector Typos ([`shortcuts.js:L329`](file:///E:/Projects/QuiviT/src/js/shortcuts.js#L329) & [`viewerGestures.js:L164`](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js#L164)):** Checks for `.menubar, .dropdown-menu` instead of `#menubar, .menu-dropdown`, causing false negatives when filtering out UI clicks.
- **Gesture Initialization Sync ([`viewerGestures.js:L39`](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js#L39)):** `_updatePanKeysCache()` is only attached to `quivit-config-loaded` and not called immediately during `createViewerGestures()` creation.

### 2.4 Dead Code & Cleanup in UI Modules
- **Broken Fit Mode Lookup ([`statusbar.js:L29-37`](file:///E:/Projects/QuiviT/src/js/menubar/statusbar.js#L29-L37)):** `fitMap` defines keys as `'fit-window'`, `'fit-width'`, etc., whereas `state.fitMode` values are `'window'`, `'width'`, `'none'`. Consequently, `fitMap[mode]` is always `undefined` and creates heap allocation on every state tick.
- **Unused Exports ([`chrome.js:L18-24`](file:///E:/Projects/QuiviT/src/js/menubar/chrome.js#L18-L24)):** `isMenuBarVisible()` and `isStatusBarVisible()` are never imported or called.
- **Duplicate Dropzone Helper ([`dropzone.js:L5-7`](file:///E:/Projects/QuiviT/src/js/main/dropzone.js#L5-L7)):** Local `pathBasename` duplicates `FsUtils.basename`.
- **Ad-hoc Regex ([`metadataBadge.js:L40`](file:///E:/Projects/QuiviT/src/js/main/metadataBadge.js#L40)):** Uses inline regex instead of standard `FsUtils.isImageEntry(f)`.
- **Unused Variable ([`options.js:L14`](file:///E:/Projects/QuiviT/src/js/options/options.js#L14)):** `tauriConfirm` declared but never referenced.
- **Shadowed Parameters ([`options.js:L120, L169`](file:///E:/Projects/QuiviT/src/js/options/options.js#L120)):** `(btn, index, NodeList)` shadows native DOM `NodeList`.
- **Dead Computation ([`keybindUi.js:L330`](file:///E:/Projects/QuiviT/src/js/options/keybindUi.js#L330)):** Computes `getConflictColors(binds)` immediately before `renderTags` recomputes it.
- **Dead DOM Probe ([`associationsUi.js:L106-110`](file:///E:/Projects/QuiviT/src/js/options/associationsUi.js#L106-110)):** Probes for removed button `#btn-assoc-apply`.
- **Unused Variable & Mid-File Import ([`metadata-window.js:L18, L100`](file:///E:/Projects/QuiviT/src/js/metadata-window.js#L18)):** `const rootEl = ...` is unused; `import { fitContentHeight }` placed at line 100 in executable body instead of top of file.
- **HTML Script Cleanups ([`index.html:L122, L203`](file:///E:/Projects/QuiviT/src/index.html#L122) & [`metadata.html:L28`](file:///E:/Projects/QuiviT/src/metadata.html#L28)):** Stale comment on `file-list`, redundant `<script type="module" src="/js/core.js"></script>`, and missing `type="module"` on `shellBackground.js` in `metadata.html`.

---

## 3. Boundary Integrity & Service Purity

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SYSTEM BOUNDARY TOPOLOGY                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   [ Services (Pure) ] <─────── [ Core (State Machine) ]                    │
│   (actions, keyCombo,                 │                                     │
│    keybindDomain,                     ▼                                     │
│    sorting, viewerMath)     [ UI Subsystems ]                               │
│                                  ├── viewer/ (Render & Gestures)            │
│                                  ├── menubar/ (Chrome & Statusbar)          │
│                                  ├── filepanel/ (DOM & Favorites Store)     │
│                                  ├── main/ (Lifecycle, Drop, Badge)         │
│                                  └── options/ & metadata/                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **Service Purity Check:**
   - `services/viewerMath.js`, `services/keyCombo.js`, `services/keybindDomain.js`, and `services/sorting.js` are **100% pure (zero DOM, zero globals)**.
   - `services/actions.js` has minor DOM leaks on lines 9 & 15 (`document.activeElement?.closest('#favorites-list')`) and line 159 (`document.getElementById('cmd-toggle-filelist')`). These should be routed cleanly through injected `ctx` and `Core.onStateChange`.

2. **Multi-Window Preview Invariant (`shared/theme.js`):**
   - Currently, `applyTheme(theme)` writes directly to `localStorage.setItem('quivit-theme', theme)` on every call. During transient live previewing in the Options dialog (e.g., clicking "Dark" without saving), this triggers `storage` events across all secondary webviews.
   - **Fix:** Keep `localStorage` writes restricted to persisted saves/loads so transient previews remain in-memory until saved.

3. **Generic Keyboard Navigation (`keyboardNav.js`):**
   - `makeContainerNavigable` contained a domain-specific check (`button.fav-remove`). This should be generalized to verify if the active element is any interactive control (`button, input, select, textarea, [role="button"]`), preventing Enter/Space interception when interacting with child buttons.

4. **Eliminating Unnecessary Dynamic DI Boilerplate:**
   - `filePanel.js` and `favoritesStore.js` used mutable module-level `let Core = null;` initialized via handshake functions. Since there is zero circular dependency with `core.js`, these should use direct static ESM imports (`import { Core } from '../core.js';`).

---

## 4. Hot-Path & Performance Invariants

In accordance with `AGENTS.md` (*"Performance first. Avoid dynamic evaluations and allocations in hot paths. Cache aggressively"*), the following optimizations were identified:

1. **$O(1)$ Action Dispatch Lookup ([`services/actions.js:L314-320`](file:///E:/Projects/QuiviT/src/js/services/actions.js#L314-L320)):**
   - **Current:** `ACTION_REGISTRY.find(a => a.id === actionId)` performs an $O(N)$ linear array search across 46 entries on every keydown, mouse click, and wheel tick.
   - **Optimization:** Pre-compile `ACTION_REGISTRY` into an `ACTION_MAP = new Map(...)` on module load for instant $O(1)$ lookup with zero allocation.

2. **$O(1)$ Shortcut Action Matching ([`services/keyCombo.js:L88-98`](file:///E:/Projects/QuiviT/src/js/services/keyCombo.js#L88-L98)):**
   - **Current:** `findAction` calls `Object.entries(keybinds)` (allocating 40+ tuple arrays) on every keydown, keyup, and wheel event.
   - **Optimization:** Pre-compile keybindings into a normalized `Map<comboString, actionId>` on configuration load, making shortcut detection $O(1)$ with zero runtime garbage collection.

3. **Eliminate $O(K)$ Array Mutations in Natural Sort ([`services/sorting.js:L5-10`](file:///E:/Projects/QuiviT/src/js/services/sorting.js#L5-L10)):**
   - **Current:** `naturalCompare` calls `ax.shift()` and `bx.shift()`, forcing memory element shifts on every token comparison.
   - **Optimization:** Replace with an index pointer loop (`let i = 0; while (i < ax.length && i < bx.length)`), eliminating all intermediate array allocations when sorting large directories.

4. **Throttle IPC Persistence During Navigation ([`core.js:L175-181`](file:///E:/Projects/QuiviT/src/js/core.js#L175-L181)):**
   - **Current:** Holding down navigation keys (`Shift+S`, `ArrowRight`) calls `_persistConfig()` immediately for `last_active_image`, spamming Tauri IPC and writing to disk on every frame.
   - **Optimization:** Route through `_scheduleConfigFlush(1500)` to debounce disk writes during continuous navigation.

5. **Static Fit-Mode Label Table ([`menubar/statusbar.js:L29-37`](file:///E:/Projects/QuiviT/src/js/menubar/statusbar.js#L29-L37)):**
   - Move the fit label dictionary to a frozen module-level constant (`FIT_LABELS`) with correct keys (`'window'`, `'width'`, `'height'`, `'width-if-larger'`, `'height-if-larger'`, `'none'`).

---

## 5. Comprehensive Action Items Matrix

| Subsystem | File | Line(s) | Change Category | Exact Action Required |
| :--- | :--- | :--- | :--- | :--- |
| **Core** | `src/js/core.js` | 42 | Safe Destructuring | `const invoke = window.__TAURI__?.core?.invoke;` |
| **Core** | `src/js/core.js` | 54 | Dead State | Remove `decodedSrc: ''` from `_state` |
| **Core** | `src/js/core.js` | 69 | Dead State | Remove `parentDirectory: ''` from `_state` |
| **Core** | `src/js/core.js` | 179 | Performance / IPC | Change `_persistConfig()` to `_scheduleConfigFlush(1500)` |
| **Core** | `src/js/core.js` | 330–343 | Dead Code | Delete uncalled `saveConfig` method |
| **Viewer** | `src/js/viewer/viewerRender.js` | 95, 164 | Dead State Setters | Remove `Core.setState({ decodedSrc: ... })` (removes state cascade) |
| **Viewer** | `src/js/viewer/viewerGestures.js` | 39 | Initialization Bug | Call `_updatePanKeysCache()` in `createViewerGestures()` |
| **Viewer** | `src/js/viewer/viewerGestures.js` | 164 | Selector Typo | Change `.menubar, .dropdown-menu` to `#menubar, .menu-dropdown` |
| **Viewer** | `src/js/viewer/viewer.js` | 29–46 | Code Duplication | Extract `_getViewportCenter()` helper for `zoomCenter` & `setZoom` |
| **Services** | `src/js/services/actions.js` | 9, 15, 159 | Service Purity | Inject `isFavoritesFocused` in `actionCtx`; sync checkmark via `Core.onStateChange` |
| **Services** | `src/js/services/actions.js` | 314–320 | Performance | Replace `.find()` with pre-compiled `ACTION_MAP.get(actionId)` |
| **Services** | `src/js/services/keyCombo.js` | 88–98 | Performance | Cache keybindings in `Map<combo, actionId>` for $O(1)$ dispatch |
| **Services** | `src/js/services/keybindDomain.js` | 66–68 | Dead Code | Remove duplicate alias `canUseMenubarBinds` |
| **Services** | `src/js/services/sorting.js` | 5–10 | Performance | Replace `.shift()` with index loop in `naturalCompare` |
| **FS Utils** | `src/js/fsUtils.js` | 6 | Dead Destructuring | Remove unused `convertFileSrc` |
| **FS Utils** | `src/js/fsUtils.js` | 59–61 | Dead Helper | Remove duplicate `_basename`; use `basename` |
| **FS Utils** | `src/js/fsUtils.js` | 366 | Path Bug | Replace regex with `parentOf(result.archive_path)` |
| **FS Utils** | `src/js/fsUtils.js` | 462–479 | Dead Code | Delete obsolete `FsUtils.openContainer` |
| **Shortcuts**| `src/js/shortcuts.js` | 5, 7 | Dead Imports/Exports| Remove unused `PASSIVE_ACTIONS` and unneeded re-exports |
| **Shortcuts**| `src/js/shortcuts.js` | 329 | Selector Typo | Change `.menubar, .dropdown-menu` to `#menubar, .menu-dropdown` |
| **FilePanel**| `src/js/filepanel/filePanel.js` | 26, 44 | Code Quality | Replace `let Core/FsUtils = null` with direct static ESM imports |
| **FilePanel**| `src/js/filepanel/filePanel.js` | 189 | Sanitization | Use `CSS.escape(ext)` instead of `escapeAttr(ext)` in querySelector |
| **FilePanel**| `src/js/filepanel/favoritesStore.js` | 6–14 | Code Quality | Replace dynamic `Core` injection with direct static ESM import |
| **Keyboard** | `src/js/keyboardNav.js` | 99–112 | Decoupling Bug | Remove `fav-remove` check; skip `onAction` when focused on interactive controls |
| **Menubar**  | `src/js/menubar/chrome.js` | 18–24 | Dead Exports | Remove unused `isMenuBarVisible` and `isStatusBarVisible` |
| **Menubar**  | `src/js/menubar/statusbar.js` | 29–37 | Bug / Performance | Fix `FIT_LABELS` keys and extract to module-level constant |
| **Menubar**  | `src/js/menubar.js` | 3 | Stale Comment | Update comment regarding chrome visibility ownership |
| **Main**     | `src/js/main/main.js` | 216–263 | Code Duplication | Unify duplicate `quivit-config-loaded` blocks |
| **Main**     | `src/js/main/dropzone.js` | 5–7 | Code Duplication | Remove duplicate `pathBasename`; use `FsUtils.basename` |
| **Main**     | `src/js/main/metadataBadge.js` | 40 | Format Support | Replace ad-hoc regex with `FsUtils.isImageEntry(f)` |
| **Options**  | `src/js/options/options.js` | 4, 14, 120 | Dead Code & Types | Remove `tauriConfirm`, clean shadowed `NodeList`, import from `keybindDomain` |
| **Options**  | `src/js/options/options.js` | 87, 168 | Code Quality | Declare `let currentTheme = 'system';` at top level |
| **Options**  | `src/js/options/options.js` | 240 | Stale Comment | Remove `// We will implement this` |
| **Options**  | `src/js/options/keybindUi.js` | 330 | Dead Computation | Remove redundant `getConflictColors` call |
| **Options**  | `src/js/options/associationsUi.js` | 106–110 | Dead DOM Probe | Remove dead `#btn-assoc-apply` probe and comment |
| **Metadata** | `src/js/metadata-window.js` | 18, 100 | Cleanliness | Remove unused `rootEl`; move `import { fitContentHeight }` to top of file |
| **Shared**   | `src/js/shared/theme.js` | 5–10 | IPC Isolation | Do not write to `localStorage` during in-memory preview |
| **HTML**     | `src/index.html` | 122, 203 | HTML Cleanliness | Fix stale comment; remove redundant `<script type="module" src="/js/core.js">` |
| **HTML**     | `src/metadata.html` | 28 | Script Tag Syntax | Standardize `<script type="module" src="/js/shellBackground.js"></script>` |

---

## 6. Conclusion & Readiness

The frontend architecture of QuiviT is in an exceptionally robust state. The separation of concerns between state, domain services, and UI controllers has met all core design goals of the JS decoupling initiative.

Executing the consolidated matrix above will eliminate all remaining dead code, prevent redundant state notification cascades, resolve selector mismatches, and maximize runtime performance without introducing unnecessary architectural churn.
