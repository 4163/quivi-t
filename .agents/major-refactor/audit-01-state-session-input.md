This report was compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`.

# Zone 1 state, session, and input architectural audit

Audit of state management, session coordination, shortcuts, and startup inputs across Zone 1 files in QuiviT.

## Validate-changes compliance findings

### Pure module boundaries

- `src/js/core.js:45` `[Blocking]` Top-level reach-in to `window.__TAURI__?.core?.invoke`. Core is defined as a pure state machine without DOM or window dependencies, but directly binds to the global Tauri namespace at script load time.
- `src/js/core.js:738` `[Blocking]` Direct DOM window event dispatch via `window.dispatchEvent(new CustomEvent('quivit-config-loaded'))`. Pure state modules must communicate with subscribers through registered callbacks rather than dispatching DOM events on the window object.
- `src/js/core.js:754,761,767,775,777` `[Blocking]` Tauri window lifecycle orchestration in `Core.init`. Core queries `get_initial_args`, `get_default_dir`, invokes `FsUtils.loadFile`, and executes `invoke('show_window')` inside a 50 millisecond `setTimeout`. Startup process coordination belongs in the application bootstrap, not inside the state machine.
- `src/js/core.js:447,451` `[Warning]` Tauri IPC call inside `Core.checkIsAnimated` invoking `check_is_animated`. Header format sniffing is domain media inspection rather than state machine storage.
- `src/js/services/actions.js:219,247,252,255,261,264,288,293,297,308,317,321,331,343,362` `[Blocking]` Direct access to `window`, `window.__TAURI__`, `window.close()`, and `window.open()`. Pure domain service modules must have zero window or DOM queries. Operating system window management and shell reveal commands must be delegated to context handlers or window managers.
- `src/js/services/actions.js:8,16,33` `[Warning]` Action owner checks query active DOM elements through `ctx.isFavoritesFocused()` and `ctx.isLibraryFocused()`.
- `src/js/services/cache.js:1-51` `[Compliant]` Pure data structures `BoundedMap` and `BoundedSet` with zero DOM or window references.
- `src/js/services/importActions.js:1-145` `[Compliant]` Factory function with injected dependencies. No direct DOM or window queries.
- `src/js/services/keyCombo.js:1-108` `[Compliant]` Pure shortcut formatting, normalization, and lookup helpers.
- `src/js/services/keybindDomain.js:1-77` `[Compliant]` Pure keybind safety and conflict color calculation routines.
- `src/js/services/workspaceLayout.js:1-52` `[Compliant]` Pure layout calculation, docking resolution, and position normalization helpers.

### Bootstrap ownership

- `src/js/main/main.js:101-110` `[Warning]` Bootstrap queries DOM nodes across separate component boundaries, caching references to `#drop-overlay`, `#password-overlay`, `#url-overlay`, `#viewport`, `#statusbar`, `#file-panel`, `#file-panel-breadcrumb`, `#file-list`, `#panel-resize-handle`, and `#status-metadata-badge`.
- `src/js/main/main.js:115-126` `[Blocking]` `setMenuItemMuted` and `updateHistoryMenu` mutate menubar items directly via `document.getElementById('cmd-history-back')` and `document.getElementById('cmd-history-forward')`. Menubar chrome must own its own DOM updates.
- `src/js/main/main.js:192-230` `[Blocking]` Bootstrap reaches directly into foreign DOM surfaces on state changes:
  - Lines 193, 205, 207 mutate `#viewport` classes directly via `viewport.classList.add('empty')` and `viewport.classList.remove('empty')`.
  - Line 194 mutates `#statusbar` directly via `statusbar.classList.add('hidden')`, breaking the rule that `menubar/statusbar.js` is the sole writer for `#statusbar`.
  - Lines 195, 196, 215, 216, 223, 224 mutate `#img-grill` and `#img-grill-border` classes.
  - Lines 197, 217, 226 mutate `#manhwa-strip` classes directly via `stripEl.classList.toggle('grill-active')`.
  - Lines 221, 225 mutate `#viewer-img-wrapper` classes directly via `wrapperEl.classList.toggle('grill-active')`.
  - Lines 218, 227 mutate menubar command DOM directly via `document.getElementById('cmd-toggle-transparent').classList.toggle('checked')`.
- `src/js/main/main.js:314-334` `[Blocking]` `reloadConfigAndSyncLibrary` contains domain synchronization logic in the bootstrap script: it flushes configuration, reloads configuration, invokes `rebind_library_watcher`, reloads library roots through `UrlLoader`, detects path shifts, triggers `NavigationHistory.remapLibraryPaths`, and clears library path caches. This coordination belongs in a service module.
- `src/js/main/main.js:413-419` `[Blocking]` Bootstrap directly writes pre-paint theme and custom CSS caches to `localStorage` under `quivit-theme` and `quivit-custom-css`, bypassing the theme ownership module.

### HTML-first rendering and CSS source of truth

- `src/js/main/metadataBadge.js:53` `[Nit]` Imperative `document.createElement('canvas')` allocation for offscreen cover thumbnail generation. This is non-DOM data rendering, but allocates canvas elements dynamically.
- `src/js/shortcuts.js:14-16` `[Warning]` `updateMenuShortcuts` writes directly to `.textContent` of menubar DOM spans matching `#${id} .shortcut`. Menubar shortcut presentation belongs in the menubar module.
- `src/js/keyboardNav.js:174` `[Nit]` Calls `window.getComputedStyle(el).visibility !== 'hidden'` during tab navigation to filter navigable controls.
- `src/js/main/fullscreen.js:42` `[Nit]` Reads `getBoundingClientRect().height` on `#fullscreen-exit-region` to calibrate hover thresholds.
- No inline `element.style.*` assignments were found in the assigned Zone 1 files, preserving CSS source of truth.

### Three-tier CSS scope

- `src/js/main/fullscreen.js:90,96` paired with `src/css/main.css:2054` `[Blocking]` `fullscreen.js` adds and removes `fullscreen-exit-visible` on `document.body`, while `main.css:2054` styles `body.fullscreen-exit-visible #fullscreen-exit-btn`. This breaks the three-tier CSS scope model by invalidating styles across the document body to toggle one leaf element inside `#fullscreen-exit-region`. The class belongs directly on `#fullscreen-exit-region` or `#fullscreen-exit-btn`.
- `src/js/menubar/chrome.js:154,161` paired with `src/css/main.css:2288-2302` and `src/js/shortcuts.js:220,308,422,452,514` `[Warning]` `is-importing-url` class on `document.body` is matched via `body.is-importing-url :is(#menubar, #file-panel) *`. The three-tier model mandates direct rules only on global tier elements, never `body.foo *`.
- `src/js/main/fullscreen.js:101` `[Warning]` `document.body.classList.toggle('fullscreen-active', active)` controls child selectors through broad body descendant rules.

## Code ownership and monolithic file decoupling plan

### Core.js decoupling plan

`src/js/core.js` contains 801 lines mixing six distinct responsibilities: pure state transitions, configuration persistence timers, animation header inspection, startup orchestration, selection URL resolution, and list sorting.

1. Animation header probing and memoization
   - Lines 55-57, 304-341, 442-463: `ANIM_MEMO_CAPACITY`, `_animMemo`, `_animMemoGeneration`, `checkIsAnimated`, `clearAnimationMemo`.
   - Reason: Probing WebCodecs and ISOBMFF animated media headers via Tauri IPC is media inspection logic, not state machine transitions.
   - Target: Move to `src/js/services/animationDomain.js`.

2. Configuration persistence and debounce scheduling
   - Lines 60, 159-162, 179-210, 404-411, 465-469, 477-479, 488-490, 495-497, 532-534, 550-552, 585-587, 602-604, 629-631, 706-742: `_configDirty`, `_persistTimer`, `_persistPromise`, `_persistConfig`, `_flushConfig`, `_scheduleConfigFlush`, `persistConfig`, `flushConfig`, `loadConfig`.
   - Reason: Managing debounce timers, background IPC calls to `save_config` and `load_config`, and firing `quivit-config-loaded` DOM events couples state storage to persistence I/O.
   - Target: Move to `src/js/services/configDomain.js`.

3. Startup target resolution and initial window launch
   - Lines 747-801: `init`, `resolveStartupTarget`.
   - Reason: Processing CLI argument lists, querying `get_default_dir`, calling `FsUtils.loadFile`, and invoking `show_window` is bootstrap execution.
   - Target: Move to `src/js/main/startup.js`.

4. Entry selection and URL building coordination
   - Lines 212-354: `_selectEntry`, `_placeholderCheck`, `setPlaceholderCheck`, `isDownloading`, `isPlaceholder`.
   - Reason: Orchestrates media URL resolution, archive encryption checks, placeholder bridging, prefetching, and last active image tracking.
   - Target: Move the asynchronous selection coordinator to `src/js/services/navigationDomain.js`, leaving pure state setters in `src/js/core.js`.

5. List sorting coordination
   - Lines 170-177: `_sortCurrentList`.
   - Reason: Calls `DirectoryPrefs.getSortPrefs` and `DirectoryPrefs.sortList` directly inside the store.
   - Target: Delegate list sorting to `src/js/services/sorting.js`.

### Shortcuts.js decoupling plan

`src/js/shortcuts.js` contains 545 lines mixing input capture with menubar DOM mutation, statusbar indicator writes, manhwa hold gestures, and direct element focus management.

1. Menubar shortcut label DOM synchronization
   - Lines 11-17: `updateMenuShortcuts`.
   - Reason: Queries `#${id} .shortcut` DOM elements in the menubar directly.
   - Target: Move to `src/js/menubar.js`.

2. Statusbar scroll-wheel indicator state and modifier latching
   - Lines 19-125: `resetScrollLatch`, `syncScrollLatch`, `isToggleModifier`, `getScrollModifierKeys`, `_getToggleEventKeys`, `_updateScrollIndicator`.
   - Reason: Drives the statusbar readout directly and calls `Statusbar.setScrollIndicatorState`, violating the rule that `shortcuts.js` does not write the statusbar.
   - Target: Move modifier latch calculation to `src/js/services/scrollLatch.js` and subscribe from `src/js/menubar/statusbar.js`.

3. Manhwa hold-toggle state machine
   - Lines 251-267, 281-291, 371, 384-386: `_holdToggleAction`, `_holdPendingState`, `_commitHoldToggle`.
   - Reason: Implements mock state overrides on key repeat and reaches into `Statusbar.syncManhwaIndicator` and `syncViewMenu`.
   - Target: Move to `src/js/viewer/manhwaStrip.js`.

4. DOM boundary checks and active control detection
   - Lines 128-134, 195-208: `isWheelOverUI`, `isInteractiveKeyTarget`.
   - Reason: Queries DOM IDs across foreign panels: `#url-overlay`, `#password-overlay`, `#file-list`, `#file-panel`, `#menubar`, `#statusbar`, `[data-ui]`.
   - Target: Move to `src/js/shared/domUtils.js`.

5. File list Enter key interception
   - Lines 318-328: Focuses `#file-list` and dispatches synthetic Enter key events.
   - Reason: Injects synthetic events into foreign list elements.
   - Target: Move to `src/js/filepanel/filePanel.js`.

### Main.js decoupling plan

`src/js/main/main.js` contains 433 lines acting as a mixed bootstrap and feature controller.

1. Viewport, grill, and statusbar DOM class toggling
   - Lines 101-110, 192-230: Viewport empty states, statusbar visibility, viewer grill borders, and manhwa strip grill classes.
   - Reason: Violates single-owner rendering rules.
   - Target: Viewport and grill class updates belong in `src/js/viewer/viewer.js` and `src/js/viewer/viewerRender.js`. Statusbar visibility belongs in `src/js/menubar/statusbar.js`. Strip grill updates belong in `src/js/viewer/manhwaStrip.js`.

2. History menu DOM state
   - Lines 115-126: `setMenuItemMuted`, `updateHistoryMenu`.
   - Reason: Directly mutates menubar DOM elements.
   - Target: Move to `src/js/menubar.js`.

3. Library relocation and watcher domain logic
   - Lines 314-334: `reloadConfigAndSyncLibrary`.
   - Reason: Contains multi-module domain orchestration in the startup script.
   - Target: Move to `src/js/services/libraryDomain.js`.

4. Pre-paint theme cache persistence
   - Lines 413-419: Direct `localStorage` writes for `quivit-theme` and `quivit-custom-css`.
   - Reason: Bypasses the theme ownership module.
   - Target: Move to `src/js/shared/theme.js`.

5. Emergency reset and tab navigation listeners
   - Lines 66-75: Window keydown listener for `Ctrl+Shift+Alt+C` and Home/End.
   - Reason: Global key listeners in bootstrap.
   - Target: Move to `src/js/shared/configPreview.js` and `src/js/keyboardNav.js`.

### Actions.js decoupling plan

`src/js/services/actions.js` contains 403 lines mixing command metadata with platform IPC invocations and path parsing.

1. Window management commands
   - Lines 218-220, 246-248, 251-256, 259-266: `cmd-options`, `cmd-hide-to-tray`, `cmd-quit`, `cmd-github`.
   - Reason: Invokes `window.__TAURI__.core.invoke` and calls `window.close()` / `window.open()`.
   - Target: Route through injected context methods (`ctx.windowManager.openOptions()`, `ctx.windowManager.close()`).

2. Platform Explorer and folder reveal commands
   - Lines 286-366: `cmd-open-explorer`, `cmd-open-folder`.
   - Reason: Executes platform IPC, splits pipe-delimited paths, and strips trailing folder segments inside the registry.
   - Target: Move path resolution and shell execution to `src/js/fsUtils.js` or `src/js/services/platformActions.js`, invoked via `ctx.FsUtils.revealInExplorer(path)`.

### WorkspaceSession.js decoupling plan

`src/js/shared/workspaceSession.js` contains 306 lines mixing low-level RPC transport with feature-specific providers and browser window lifecycle management.

1. Feature-specific state provider hooks
   - Lines 22-53, 167-171, 184-190, 209-210: `previewStateProvider`, `stripVisibleIndicesProvider`, `metadataStateProvider`.
   - Reason: Generic RPC transport contains hardcoded knowledge of preview theme/css, manhwa strip indices, and comic metadata.
   - Target: Provide a generic snapshot provider registration mechanism in `src/js/shared/workspaceSession.js`.

2. Initiator tracking
   - Lines 58-70: `initiatorCoreMethods`, `initiatorFsMethods`, `initiatorImportMethods`, `lastInitiator`.
   - Reason: Tracks focus origins for dialogs and navigation intents.
   - Target: Move to `src/js/shared/workspaceControls.js`.

3. Configuration dirty patch calculation
   - Lines 96-106: `rememberConfig`, `configPatch`.
   - Reason: Configuration diffing belongs in the configuration domain.
   - Target: Move to `src/js/services/configDomain.js`.

4. Browser popup management
   - Lines 236-240, 262, 301-306: `windowPopups`, `workspacePopupUrl`.
   - Reason: Browser-mode popup tracking mixed into Tauri event transport.
   - Target: Move to `src/js/main/workspace.js`.

### Architecture state tracking verification

- `src/js/shared/clipboard.js` is missing from `.agents/architecture-state.md` under the `shared/` section. It provides asynchronous text copying to the system clipboard with navigator clipboard error handling.
- `src/js/services/workspaceLayout.js` is correctly recorded in `.agents/architecture-state.md` under `services/`.
- No other misplaced helpers were identified across Zone 1 files.

## Detached workspace and multi-window session parity

### Behavioral divergences and desynchronization

1. ViewportCore stubbing breaks passwordOverlay.js in detached mode
   - `src/js/shared/workspaceHost.js:15` returns `{ ...state, mode: 'empty', src: '', list: EMPTY_LIST, index: -1, manhwaEnabled: false, isAnimated: false }` whenever `hostsWorkspaceSurface('viewport')` is false.
   - In `src/js/main/main.js:268`, `ViewportCore` is passed to `initPasswordOverlay`.
   - In the detached `fileList` window, `hostsWorkspaceSurface('viewport')` evaluates to false.
   - `src/js/main/passwordOverlay.js:136` tests `state.mode === 'archive' || state.index !== -1`. Because `ViewportCore` forces `mode: 'empty'` and `index: -1`, password prompts fail to open when an encrypted archive is selected in the detached window.
   - When pressing Escape in `passwordOverlay.js:118`, the handler checks `state.mode === 'archive'`. Because `ViewportCore` forces `'empty'`, Escape never calls `FsUtils.openParent()`, calling `Core.selectIndex(-1)` instead.

2. ViewportCore stubbing breaks urlOverlay.js in detached mode
   - In `src/js/main/main.js:288`, `ViewportCore` is passed to `initUrlOverlay`.
   - In `src/js/main/urlOverlay.js:208`, the overlay listens for state changes to dismiss itself when media changes: `if (state.src !== _lastObservedSrc || currentDir !== _lastObservedDirectory)`.
   - Because `ViewportCore` forces `src: ''` permanently in the detached window, image navigation never triggers auto-dismissal of the URL overlay in detached mode.

3. Asymmetric window focus restoration
   - In `src/js/shared/workspaceControls.js:91-105`, restoring focus to `workspace-file-list` from `main` invokes `plugin:window|set_focus` via Tauri IPC and dispatches a workspace RPC focus request.
   - Restoring focus to `main` from `workspace-file-list` calls `document.getElementById('viewport')?.focus()`. If the main OS window does not have OS focus, setting DOM element focus does not bring the main Tauri window to the foreground.

4. Action routing desynchronization
   - In `src/js/shared/workspaceControls.js:37`, actions with `owner === 'window'` run locally in the window where the shortcut occurred.
   - `cmd-fullscreen` has `owner: 'window'` in `src/js/services/actions.js:234`. Triggering fullscreen while focused on the detached file list window fullscreens the detached panel rather than the primary viewer window.
   - `cmd-toggle-menubar` and `cmd-toggle-statusbar` have `owner: 'window'`, altering chrome only in the currently focused window.

5. Core methods omitted from CORE_SESSION_METHODS
   - `src/js/core.js:46-51` omits `patchFrontendConfig`, `setPlaceholderCheck`, `isDownloading`, `isPlaceholder`, `checkIsAnimated`, and `clearAnimationMemo`.
   - Calling `patchFrontendConfig` on a replica does not route through `CORE_SESSION_METHODS`, relying on the independent `persistConfig` forwarder in `core.js:363`.

### Redundant broadcasts and RPC round-trips

1. Notification and snapshot cascade during navigation
   - A single item navigation step from the detached file list window with `cmd-next` produces the following traffic sequence:
     1. Replica sends RPC request: `requestWorkspace('main', 'action', 'run', ['cmd-next', ...])`.
     2. Main runs `action.run` and calls `Core.navigate(1)`.
     3. `Core.navigate` mutates state and calls `_notify()`.
     4. Main's `workspaceSession.js:289` triggers on `Core.onStateChange` and immediately broadcasts a `snapshot` message to the replica.
     5. Main completes the RPC call and sends a `response` message to the replica.
     6. Header inspection resolves asynchronously, calling `_notify()` on main and broadcasting a second `snapshot` message to the replica.
     7. Image dimension calculation resolves, calling `Core.setImageDimensions` and broadcasting a third `snapshot` message to the replica.
     8. In manhwa mode, visible index settling emits `quivit-manhwa-settle`, which broadcasts a fourth `event` message to the replica.
   - Single navigation inputs generate 1 RPC request/response pair, 3 state snapshots, and 1 event broadcast.

2. Uncached JSON serialization on every state notification
   - `src/js/shared/workspaceSession.js:160` executes `const configJson = JSON.stringify(state.config)` on every single `publish()` execution.
   - During pan drag, rapid keyboard navigation, or mouse wheel scrolling, the full configuration tree is converted to JSON on every animation frame, even when configuration has not changed.

3. High-frequency RPC scroll reporting
   - `src/js/shared/workspaceControls.js:70-75` invokes `requestWorkspace('main', 'filePanel', 'setFileListAtTop', [isAtTop])` on scroll changes.
   - Rapid scrolling near the top boundary causes repeated inter-window RPC round-trips.

## Performance, hot paths, and async races

### Hot-path allocations and linear scans

1. String allocations and array sorting on key and mouse events
   - `src/js/shortcuts.js:347,498,535` invokes `formatKeysCombo(activeKeys, activeButtons)`.
   - `src/js/services/keyCombo.js:61-87` executes inside `formatKeysCombo`:
     - `Array.from(keysSet)` creates a new array.
     - `.map(k => k.toLowerCase())` creates a second array.
     - `others` array is allocated.
     - `others.sort()` sorts the array in-place.
     - `combo.concat(others).join('+')` allocates concatenated arrays and strings.
   - This occurs on every `keydown`, `keyup`, `mousedown`, `mouseup`, and `wheel` event.

2. Linear regular expression scans and string splitting in key event handlers
   - `src/js/shortcuts.js:350,362,367,374,400` executes `_updateScrollIndicator(config)` on every `keydown` and `keyup`.
   - `src/js/shortcuts.js:62-76` (`getScrollModifierKeys`):
     - Iterates `_SCROLL_ALL_IDS`.
     - Executes regex test `/Scroll(Up|Down)$/` on every binding string.
     - Calls `c.split('+')` on every binding string.
     - Allocates a `new Set()` and returns `Array.from(found)`.
   - `src/js/shortcuts.js:111-114`:
     - Allocates `['Ctrl', 'Alt', 'Shift']` and runs two chained `.filter()` passes on every keypress.
   - Breaks AGENTS.md rule requiring pre-parsed `O(1)` Set or Map lookups on hot paths.

3. Pan vector evaluation allocations
   - `src/js/shortcuts.js:180-193` (`readKeyboardPanVector`) allocates a `new Set()` for `activeActions` on every keyboard pan event and iterates `keyboardPanBindings`.

4. Wheel event set cloning
   - `src/js/shortcuts.js:520` executes `const keys = new Set(activeKeys)` on every scroll wheel tick, followed by `formatKeysCombo`.

5. Fullscreen pointermove handler
   - `src/js/main/fullscreen.js:161-171` executes on `pointermove` across the window, checking client coordinates and updating hover visibility state.

### State cloning and subscriber notification cascades

1. State object cloning on every notification
   - `src/js/core.js:166` executes `const snapshot = { ..._state }` on every `_notify()` call.
   - All registered subscribers run sequentially. `main/main.js:186-236` runs `updateMenuShortcuts`, `syncViewMenu`, `updateHistoryMenu`, and statusbar updates on every tick.

2. Synchronous duplicate notification cycles
   - `src/js/core.js:583,588` in `setManhwaMode`: calls `this.setSpreadEnabled(false)`, which calls `_notify()`, and then calls `_notify()` again immediately.
   - `src/js/core.js:559,560` in `setSpreadMode`: calls `this.setSpreadEnabled(true)`, which calls `_notify()`, and then calls `this.setSpreadDirection(mode)`, which calls `_notify()` again.
   - Single operations trigger double synchronous UI repaints and double IPC broadcasts.

3. Triplicate notifications during media loading
   - `src/js/core.js:328` fires notification 1 on entry selection.
   - `src/js/core.js:337` fires notification 2 when animation header check completes.
   - `src/js/core.js:512` fires notification 3 when `setImageDimensions` reports dimensions from image decoding.

### Asynchronous flows and stale-generation races

1. Password submission race
   - `src/js/main/passwordOverlay.js:60-72` awaits `_FsUtils.loadArchive(_lockedArchivePath, '', { password })`.
   - If the user navigates to another container while submission is pending, `_submitting` remains true until completion. If an incorrect password response returns after navigation, stale error messages display on the new container.

2. URL overlay locks out state change dismissal while loading
   - `src/js/main/urlOverlay.js:206` returns early if `_overlay.classList.contains('loading')`.
   - If a remote gallery download hangs or encounters high network latency, background navigation inputs cannot dismiss the URL overlay via state change events.

3. Stale file list snapshot in metadata badge
   - `src/js/main/metadataBadge.js:80,117` captures `fileList` at the moment `_loadMetadataForArchive` or `_loadMetadataForDirectory` is called.
   - When `fetchMetadata` completes after an asynchronous interval, `firstImage` is resolved against the stale closure list rather than the active sorted file list.

4. Drop completion side-effects on canceled intents
   - `src/js/services/importActions.js:130-135` awaits `save_dropped_image` and calls `libraryUpdated()`.
   - Even if the navigation intent is superseded during the IPC write, the dropped media has already been committed to disk and watcher events have already fired.

## Redundant code, shared helpers, and stale references

### Duplicated logic across assigned files

1. Pipe-delimited archive path parsing and parent directory stripping
   - `src/js/services/actions.js:296-297`: `const sep = favorite.path.indexOf('|'); const realPath = sep === -1 ? favorite.path : favorite.path.slice(0, sep);`
   - `src/js/services/actions.js:320-321`: identical slice logic for `entry.path`.
   - `src/js/services/actions.js:339-341`: identical slice logic with parent directory regex stripping `realPath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')`.
   - `src/js/services/actions.js:354-356`: identical slice and parent directory regex stripping.
   - Recommended helper: Consolidate into `FsUtils.splitArchivePath(path)` and `FsUtils.getParentPath(path)`.

2. Key modifier extraction and combination assembly
   - `src/js/services/keyCombo.js:61-87`: extracts modifiers from key sets.
   - `src/js/main/fullscreen.js:49-57`: extracts modifiers from keyboard events: `ctrlKey`, `altKey`, `shiftKey`, and `formatKeyName`.
   - `src/js/shortcuts.js:87-92`: extracts modifiers from keyboard events.
   - Recommended helper: Consolidate into `keyCombo.js:extractEventModifiers(e)` and reuse across `shortcuts.js` and `fullscreen.js`.

3. Reset held keys event dispatch
   - `src/js/main/passwordOverlay.js:36`: `window.dispatchEvent(new CustomEvent('quivit-reset-held-keys'))`.
   - `src/js/main/passwordOverlay.js:97`: identical event dispatch on paste.
   - `src/js/main/urlOverlay.js:35`: identical event dispatch on show.
   - `src/js/main/urlOverlay.js:139`: identical event dispatch on paste.
   - Recommended helper: Consolidate into `shortcuts.js:resetHeldKeys()`.

4. IPC error normalization
   - `src/js/main/urlOverlay.js:67-73`: `_errorText(err)` unwraps string vs `err.message` vs fallback.
   - `src/js/main/dropzone.js:27`: `typeof err === 'string' ? err : err?.message || 'Unable to open dropped content'`.
   - Recommended helper: Consolidate into `formatIpcError(err, fallback)` in `src/js/shared/errorUtils.js`.

5. Offscreen canvas thumbnail scaling
   - `src/js/main/metadataBadge.js:44-63`: `_generateCoverThumbnail` sets up canvas dimensions, draws scaled image, and converts to data URL.
   - Recommended helper: Consolidate into `src/js/shared/blobImage.js`.

### Unused imports, dead functions, and outdated references

1. `src/js/core.js:429-435` contains duplicate functions `isDownloading(path)` and `isPlaceholder(path)` with identical bodies calling `_placeholderCheck(path)`. One is redundant dead code.
2. `src/js/shortcuts.js:1` header comment claims `shortcuts.js - keyboard shortcut matching and command dispatch. Does not write the statusbar.` Lines 124, 263, 350, 362, 367, 374, 393, and 400 directly call `Statusbar.setScrollIndicatorState` and `Statusbar.syncManhwaIndicator`, contradicting the architecture contract.
3. `src/js/shared/workspaceSession.js:148-150` dispatches `quivit-favorites-changed` if `favorites` or `favorites_collapsed` exists in `message.patch`, but favorites persistence is governed by `favoritesStore.js` and `quivit_favorites.json`.
4. `src/js/main/main.js:60` imports `getAnchorImgIdx` from `viewer/manhwaStrip.js`, used only to pass to `actionCtx`.
5. `src/js/services/keybindDomain.js:5` contains `export const CATEGORIES = REGISTRY_CATEGORIES;`, acting as a redundant pass-through export for `actions.js`.

### CorePipelineProbe diagnostic contracts

`e2e/replay-diagnostics/probes/corePipelineProbe.js` hooks into the state machine and command pipeline. To avoid breaking diagnostic scenarios during Zone 1 refactoring, the following contracts must be preserved:

- Dynamic import paths:
  - `/js/services/actions.js`
  - `/js/core.js`
- Exported signatures:
  - `actions.js`: `dispatch(actionId, payload, ctx)` function.
  - `actions.js`: `ACTION_MAP` with `.has(actionId)`.
  - `core.js`: `Core` object.
- Core methods hooked:
  - `Core.getState()`: must return the active state snapshot.
  - `Core.onStateChange(fn)`: must accept a subscriber callback.
  - `Core.navigate(delta)`: must accept a delta step integer.
  - `Core.persistConfig(options)`: must accept options with `immediate` and `debounceMs`.
- Core state keys tracked by diff recorder, lines 61-75:
  - `mode`
  - `index`
  - `filename`
  - `src`
  - `archivePath`
  - `archiveEncryption`
  - `isSpread`
  - `spreadStep`
  - `spreadEnabled`
  - `spreadDirection`
  - `fitMode`
  - `scalingMode`
  - `fileListViewMode`
  - `list`, probed via `state.list.length`
- Configuration keys recorded in `persistConfig` hook, lines 128-130:
  - `config.frontend_data.last_opened_path`
  - `config.frontend_data.last_active_image`
  - `config.frontend_data.scroll_zoom_latched`
- Action payload properties inspected, lines 31-33:
  - `wheel`
  - `clientX`
  - `clientY`
- DOM IDs or classes:
  - None. `corePipelineProbe.js` does not query any DOM IDs, classes, or attributes. It hooks directly into the runtime JavaScript module pipeline.
