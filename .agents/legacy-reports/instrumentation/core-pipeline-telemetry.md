# Core Pipeline Telemetry Map — `core.js` / `services/actions.js` / `shortcuts.js` / `fsUtils.js`

Source revisions read: `src/js/core.js` (591 lines), `src/js/services/actions.js` (365 lines),
`src/js/shortcuts.js` (456 lines), `src/js/fsUtils.js` (1000 lines).
Supplemental wiring verified in `src/js/main/main.js` (241 lines) and `src/js/main/lifecycle.js` (62 lines)
for `actionCtx`, `dispatch` call sites, and `onStateChange` subscribers.

Pipeline in one line:

```
HW/OS event → shortcuts.js (keydown/mousedown/wheel/auxclick)
  → findAction(config,keyCombo) → dispatchAction(id,payload) → actions.js dispatch(id,payload,ctx)
  → ctx.Core.* / ctx.FsUtils.* / ctx.Viewer.* / ctx.NavigationHistory.*
  → core.js _state mutation → _notify() → onStateChange subscribers
  → FsUtils container loads → Core.setState({...}) → _notify() → render
```

`Core` is a singleton object literal (`core.js:286-591`) closing over module-private
`_state` (`core.js:50-130`), `_listeners` (`core.js:133`), `_configDirty`/`_persistTimer`
(`core.js:134-135`), and `_animMemo: BoundedMap(512)` (`core.js:47-48`).

---

## 1. State shape (`core.js:50-130`)

| Property | Type / default | Meaning |
|---|---|---|
| `mode` | `'empty'\|'image'\|'archive'`, `'empty'` | Container kind |
| `src` | `string`, `''` | Displayed image URL (`asset://`, `http://quivit.localhost/...`, `blob:`, `data:` for ICO) |
| `filename` | `string`, `''` | Display name; overloaded as status/error label (`Password required: …`, `Failed to open archive: …`) |
| `index` | `number`, `0` (`-1` = empty selection) | Position in `list` |
| `list` | `Array`, `[]` | Flat sorted entries for current scope; `list[0]` is `..` parent row when present |
| `directory` | `string`, `''` | Current dir (`'Drives'` for virtual root, `''` in archive mode) |
| `archivePath` | `string`, `''` | Archive path when `mode==='archive'`; also reused as lock-holder when an archive entry in a directory needs a password (`core.js:215`) |
| `archiveMetadataFiles` | `Array`, `[]` | Only written by `FsUtils.loadArchive` (metadata sidecar names) |
| `archiveEncryption` | `null\|'password_required'\|'password_incorrect'`, `null` | Lock state |
| `isSiblingNavigation` | `bool`, `false` | Set by `FsUtils` `isSiblingNavigation` option; consumed by history/UI |
| `isAnimated` | `bool`, `false` | Backend `check_is_animated` result |
| `loopCount` | `number`, `0` (`0` = infinite) | Ditto |
| `fileListVisible` | `bool`, `true` | Panel visibility |
| `fitMode` | `string`, `DEFAULT_FIT_MODE` | `none\|width\|height\|window\|width-if-larger\|height-if-larger\|window-if-larger` |
| `fitModeGen` | `number`, `0` | Monotonic bump on **every** `setFitMode`, even same value (`core.js:350`) |
| `scalingMode` | `string`, `DEFAULT_SCALING_MODE` | `none\|bilinear\|lanczos` |
| `naturalWidth` / `naturalHeight` | `number`, `0` | Last decoded dimensions |
| `isSpread` | `bool`, `false` | Derived: `natW/natH >= 1.2` (`core.js:376`) |
| `spreadEnabled` | `bool`, `DEFAULT_SPREAD_ENABLED` | Master switch (mirrored to config) |
| `spreadDirection` | `'rtl'\|'ltr'`, default RTL | Reading direction (mirrored to config) |
| `spreadStep` | `1\|2`, `1` | Current page of a 2-page spread |
| `fileListViewMode` | `'list'\|'thumbnail'` | Panel mode (mirrored to config) |
| `config` | `{ portable_mode, frontend_data: {...} }` | Merged backend config; `frontend_data` holds `continue_last`, `start_dir`, `fit_mode`, `scaling_mode`, `spread_enabled/dir`, `file_list_view_mode`, `keybinds`, plus lazily-added `transparent_bg`, `active_filter`, `show_hidden`, `open_first_image`, `remember_last_image`, `last_opened_path`, `last_active_image`, `scroll_zoom_latched`, `scroll_zoom_modifier`, `menu_visible`, `status_visible`, `theme`, `custom_css`, `keyboard_pan_step`, `wheel_pan_step` |

Non-`_state` module state that still matters for telemetry:
`_configDirty: bool`, `_persistTimer: timeout|null`, `_animMemo: BoundedMap(512)` keyed
`` `${archiveArg||''}::${pathArg}` `` (`core.js:322`), `FsUtils._navigationGeneration: number`,
`_archivePrefetchTimer/_archivePrefetchSeq`, `_unlockedArchivePasswords: BoundedMap(50)`,
`_archiveEncryptionCache: BoundedMap(100)` (`fsUtils.js:24-28`).

---

## 2. State mutation points

### 2.1 Central primitives

| Function | Location | What it does | Notifies? |
|---|---|---|---|
| `_notify()` | `core.js:139-142` | Shallow-copies `_state` (`{..._state}` — note: `list` and `config` are **shared references**, not deep clones) and calls every `_listeners` fn synchronously, in registration order. No error isolation — one throwing subscriber breaks the rest. | Is the notifier |
| `Core.onStateChange(fn)` | `core.js:287-289` | `_listeners.push(fn)`. No unsubscribe return, no dedup. | No |
| `Core.getState()` | `core.js:291-293` | Returns `{..._state}` shallow copy. Mutating the copy's top-level keys is safe; mutating `copy.list`/`copy.config.frontend_data` mutates live state **without** notify. | No |
| `Core.setState(partial)` | `core.js:311-314` | `Object.assign(_state, partial)` + `_notify()`. **Only generic mutation entry.** All `FsUtils` container commits go through here. Telemetry hook #1. | **Always** |
| `Core.setListAndIndex(newList, newIndex)` | `core.js:304-309` | `_state.list=newList`; if `newIndex!==undefined && !==-1` then `_state.index=newIndex`; `_state.spreadStep=1`. | **Always** |
| `Core.setFileListVisible(visible, options)` | `core.js:316-319` | `_state.fileListVisible=!!visible`. Skips notify only if `options.notify===false`. | Conditional |
| `_scheduleConfigFlush(delayMs=1500)` / `_persistConfig()` / `_flushConfig()` / `Core.persistConfig(options)` / `Core.flushConfig()` | `core.js:144-164, 295-302` | Config write path: sets `_configDirty=true`, resets `_persistTimer`, debounced `invoke('save_config',{config})`. `persistConfig({immediate:true})` bypasses debounce; `{debounceMs}` overrides 1500 ms. No `_notify`. | No (silent) |

### 2.2 Direct `_state.*` mutators in `core.js` (all bypass `setState`; hook must be at `_notify` or per-function)

| Function | Lines | Properties written | Notify sites | Notes |
|---|---|---|---|---|
| `_selectEntry(index, activate, clampPreview, direction)` (private) | `166-282` | `index`, `filename`, `src`, `spreadStep`, `isSpread`, `naturalWidth`, `naturalHeight`, `isSiblingNavigation=false` (reset, `193`), `archivePath`, `archiveEncryption` | `171` (early `index===-1` clear); `256` (main select); `265` (async anim correction, **only if changed**) | Single hottest intra-list navigation path. Has **generation guard**: captures `index`/`newSrc`, aborts if `_state.index!==index` after each `await` (`203, 213`). Early `return` with **no notify** when index out of range (`174`), when delegating to `FsUtils.openParent()` (`178-179`) or `FsUtils.loadFile()` (`182-184`) for dirs/archives/parents. Remembers `config.frontend_data.last_active_image={container,path}` + `_scheduleConfigFlush(1500)` at `271-277` (only if `remember_last_image` and `src!==''`) — silent config mutation. Fires `FsUtils.prefetchAhead` in archive mode (`279-281`). |
| `Core.toggleTransparentBg()` | `342-346` | `config.frontend_data.transparent_bg` (toggled in place) | `345` | + `_scheduleConfigFlush(1500)` |
| `Core.setFitMode(mode, options)` | `348-356` | `fitMode=mode`, `fitModeGen++` (unconditional), optionally `config.frontend_data.fit_mode` iff `options.persist` | `355` | `fitModeGen` bump is the render-invalidation signal for same-mode re-apply |
| `Core.setScalingMode(mode, options)` | `358-365` | `scalingMode`, optionally `config...scaling_mode` iff persist | `364` | |
| `Core.setActiveFilter(id)` | `367-371` | `config.frontend_data.active_filter=id` | `370` | Always `_scheduleConfigFlush()` (default 1500 ms) even without `options` |
| `Core.setImageDimensions(natW, natH)` | `373-381` | `naturalWidth`, `naturalHeight`, `isSpread=(w/h>=1.2)`, `spreadStep=1` iff `!isSpread` | `380` | Called by viewer on decode; no config write |
| `Core.setSpreadStep(step)` | `383-386` | `spreadStep=(step===2?2:1)` | `385` | Used both directly and as `navigate()` short-circuit |
| `Core.setSpreadEnabled(enabled, options)` | `388-397` | `spreadEnabled=!!enabled`, mirror `config.frontend_data.spread_enabled` (if `config` exists), flush iff `options.persist` | `396` | |
| `Core.toggleSpreadEnabled(options)` | `399-402` | Delegates to `setSpreadEnabled(!current)` where `current = _state.spreadEnabled ?? config...spread_enabled ?? DEFAULT` | Via delegate (1 notify) | |
| `Core.setSpreadDirection(direction, options)` | `404-414` | `spreadDirection=('ltr'? 'ltr':'rtl')`, mirror to config, flush iff persist | `413` | Any non-`'ltr'` coerces to `'rtl'` |
| `Core.setSpreadMode(mode, options)` | `416-423` | Delegates: `off→setSpreadEnabled(false)`; else `setSpreadEnabled(true)+setSpreadDirection(mode)` | Via delegates (**2 notifies** — observable double-render) | Same for `toggleSpreadMode` |
| `Core.toggleSpreadMode(mode, options)` | `425-434` | Delegates; disables if already `(enabled && direction===mode)`, else enable+set direction | Via delegates (1–2 notifies) | |
| `Core.setFileListViewMode(mode, options)` | `436-446` | `fileListViewMode=('thumbnail'?'thumbnail':'list')`, mirror to config, flush iff persist | `445` | |
| `Core.toggleFileListViewMode(options)` | `448-451` | Delegates with flipped mode | Via delegate (1 notify) | |
| `Core.navigate(delta)` | `456-498` | No direct writes; may call `this.setSpreadStep(2\|1)` (spread short-circuit, `462-469`) or `_selectEntry(next,false,clampPreview,sign(delta))` (`496-497`) | Via delegate; **zero notify** if `list.length<=1` (`472`) or spread-step absorbed the delta | Wrap-aware: `next=(index+delta+len)%len`. `clampPreview` keeps old `src` when wrapping across an all-image list (`484-494`). Spread gate: `spreadEnabled && isSpread && fitMode∈{width,width-if-larger}` (`457-459`) |
| `Core.jumpToIndex(index)` | `503-505` | Delegates `_selectEntry(index,true)` — `activate=true` means dirs/archives/parents trigger `loadFile`/`openParent` instead of preview | Via delegate | File-list click/Enter path |
| `Core.selectIndex(index)` | `507-509` | Delegates `_selectEntry(index)` (`activate=false`) | Via delegate | Hover/keyboard-highlight path |
| `Core.loadConfig()` | `514-549` | `config=mergeConfig(loaded)` (deletes legacy `last_active_images`, `521-524`); `fitMode+fitModeGen` (only if changed, `527-530`); `scalingMode`, `spreadEnabled` (`===true` coercion), `spreadDirection`, `fileListViewMode`; may trigger `FsUtils.refresh()` if `show_hidden` flipped and a container is open (`538-542`) | `544` + `window.dispatchEvent(CustomEvent('quivit-config-loaded'))` (`545`) | Startup + `config-updated`/`config-changed` backend events. Old `show_hidden` is captured **before** merge (`518`) for change detection |
| `Core.init()` | `554-590` | No direct writes | Via `loadConfig`; then `FsUtils.loadFile(startPath,{restoreLastImage,preferInitial,isStartup})` (`578-582`) and `invoke('show_window')` after 50 ms (`586-588`) | Startup path priority: CLI `args[1]` > `last_opened_path` (iff `continue_last!==false`) > `start_dir` > `get_default_dir()` (`566-574`) |
| `Core.checkIsAnimated / clearAnimationMemo` | `321-340` | `_animMemo` only (not `_state`) | No | Read-through cache around `invoke('check_is_animated')`; failure returns `{is_animated:false,loop_count:0}` |

### 2.3 `Core.setState({...})` call sites in `fsUtils.js` (container-level commits — all notify)

| Call site | Lines | `partial` keys | Trigger / guards |
|---|---|---|---|
| `applyDirectoryResult()` success | `457-469` | `mode:'image'`, `list:files`, `index`, `directory:result.directory`, `archivePath` (`''` or locked path), `archiveEncryption`, `filename`, `src:selectedSrc`, `isAnimated`, `loopCount`, `isSiblingNavigation:!!options.isSiblingNavigation` | After sort (`applySort`+`DirectoryPrefs`), index-resolution cascade (`preserveFilename` → `restoreLastImage` → `targetPath` → `targetName` → `result.target_filename` → `preferInitial`/`forceFirstImage`/`open_first_image`, `365-423`), `buildFileSrc`, `checkIsAnimated`, `checkArchiveEncryption`. Generation-guarded at entry (`358`) and after each await (`433, 441, 449`). Then `recordNavigation(prev, getState(), options)` (`470`) + `watch_directory` (`473-475`). |
| `loadArchive()` password-blocked | `530-543` | `mode:'archive'`, `list`, `index` (1 or 0 or -1), `archivePath:result.archive_path`, `archiveMetadataFiles:metaFiles`, `archiveEncryption:result.encryption`, `directory:''`, `filename:lockLabel`, `src:''`, `isAnimated:false`, `loopCount:0`, `isSiblingNavigation` | `isPasswordBlocked` (`523`); also caches `_unlockedArchivePasswords`/`_archiveEncryptionCache` (`505-511`). Then `recordNavigation` (`544`) + `persistLastOpened` (`545`). |
| `loadArchive()` success | `592-605` | Same keys as above, but `filename:selectedEntry?.name`, `src:selectedSrc`, `isAnimated:initialAnimated(ext===gif\|apng)`, `loopCount:0` | Index cascade: `targetPath` (normalized compare, `553-562`) → `restoreLastImage` (`564-567`) → `isRefresh`+`findNearestSurvivingIndex` (`569-570`) → `preferredIndex` → `forceFirstImage\|open_first_image` → `0` (`571-577`). Then `recordNavigation` (`606`), `persistLastOpened` (`608`), async `checkIsAnimated(name, archivePath)` → conditional `setState({isAnimated,loopCount})` only if `(mode,archivePath,index)` still match and values changed (`612-627`), `prefetchAhead(path,index,1)` (`630`). |
| `loadArchive()` async anim correction | `618-621` | `isAnimated`, `loopCount` only | Guarded by `_isCurrentGeneration(gen)` + current-state match (`615`); notifies only if changed (`616-622`). |
| `loadArchive()` catch-all error | `641-646` | `mode:(empty?'image':mode)` (preserves non-empty mode), `src:''`, `filename:'Failed to open archive: …'`, `isAnimated:false` | Only if current generation and `!options.suppressErrorState` (`638`); `isStartup` instead falls back to `loadFallbackAncestor` (`634-637`). Re-throws after setting state. |

Silent config writes in `fsUtils.js` (no `_notify` — invisible to `onStateChange` telemetry):
`persistLastOpened(path)` (`350-355`): `config.frontend_data.last_opened_path=path` + `Core.persistConfig()` (skipped if `continue_last===false`); called from `applyDirectoryResult`? No — from `loadArchive` (both outcomes), `loadFile` dir branch, `openParent` (both branches). `_selectEntry` last-image remember (`core.js:271-277`) likewise.

---

## 3. Subscriber notifications

### 3.1 `_notify()` fan-out (`core.js:139-142`)

Synchronous, in-order, snapshot-per-notify (`{..._state}`). Every `Core.set*` / `setState` /
`_selectEntry` commit ends here. Double-notify sequences to be aware of:
`setSpreadMode/toggleSpreadMode` (enable + direction = 2× `_notify`),
`loadArchive` success + delayed anim correction (2×, second conditional),
`_selectEntry` + `remember_last_image` flush (1 notify + 1 debounced backend save).

Full `_notify()` call-site table (16 sites):

| # | Site | Line | Fires when |
|---|---|---|---|
| 1 | `_selectEntry` empty-clear | `171` | `index===-1` (emptied container) |
| 2 | `_selectEntry` main | `256` | Every successful intra-list select (image, locked-archive placeholder, or non-image preview) |
| 3 | `_selectEntry` anim-correction | `265` | Async `checkIsAnimated` resolved and `(isAnimated,loopCount)` actually changed and selection still current |
| 4 | `setListAndIndex` | `308` | External list replacement |
| 5 | `setState` | `313` | Every `FsUtils` container commit + error states |
| 6 | `setFileListVisible` | `318` | Unless `options.notify===false` |
| 7 | `toggleTransparentBg` | `345` | Every toggle |
| 8 | `setFitMode` | `355` | Every call incl. same-mode (gen bump) |
| 9 | `setScalingMode` | `364` | Every call |
| 10 | `setActiveFilter` | `370` | Every call |
| 11 | `setImageDimensions` | `380` | Every decode-size report |
| 12 | `setSpreadStep` | `385` | Every step set (incl. `navigate()` spread absorption) |
| 13 | `setSpreadEnabled` | `396` | + via `toggleSpreadEnabled/setSpreadMode/toggleSpreadMode` |
| 14 | `setSpreadDirection` | `413` | + via spread-mode delegates |
| 15 | `setFileListViewMode` | `445` | + via toggle |
| 16 | `loadConfig` | `544` | Every config load, followed by `quivit-config-loaded` DOM event (`545`) |

No `_notify` in: `navigate()` itself, `jumpToIndex`/`selectIndex` wrappers (delegate),
`persistConfig/flushConfig/_scheduleConfigFlush/_persistConfig`, `checkIsAnimated`,
`persistLastOpened`, `recordNavigation`, prefetch, or any `shortcuts.js` latch bookkeeping
(`_toggleLatched` is module-local + mirrored to `frontend_data.scroll_zoom_latched` via
`Core.persistConfig({debounceMs:1500})` at `shortcuts.js:334` — silent).

### 3.2 `onStateChange` subscribers (registration order ≈ notification order)

| Subscriber | File:line | Consumes | Notes for telemetry |
|---|---|---|---|
| `main.js` global UI sync | `main/main.js:110-167` | `config.frontend_data`, `mode`, `src`, `archiveEncryption`, `fileListVisible`, `config.transparent_bg` | First subscriber; one-time chrome init (`_uiInitialized`), `updateMenuShortcuts`, empty-state overlay/viewport/statusbar classes, `Statusbar.update`, `syncViewMenu`, `updateHistoryMenu` |
| `initFilePanel` render | `filepanel/filePanel.js:1593` | Full state (`renderFilePanel(getState())`) | File list re-render per notify — most expensive subscriber |
| `viewerRender` | `viewer/viewerRender.js:315` | Image/view state | Canvas/DOM image swap |
| `viewerPipelines` | `viewer/viewerPipelines.js:576` | Image/view state | Filter/transform pipeline |
| `initPasswordOverlay` | `main/passwordOverlay.js:94` | `archiveEncryption`, `archivePath`, `filename` | Lock UI |
| `initMetadataBadge` | `main/metadataBadge.js:77` | `archiveMetadataFiles`, `mode` | Badge |
| `initLifecycle` → `updateWindowTitle` | `main/lifecycle.js:27` (+`3-24`) | `mode`, `src`, `list`, `filename`, `archivePath` | `win.setTitle`, change-deduped via `_lastTitle` |
| `bindKeyboardShortcuts` config resync | `shortcuts.js:205-209` | `config` (on `quivit-config-loaded` DOM event, **not** `onStateChange`) | `updateKeyboardPanBindings` + `rebuildBindMap` |
| `main.js` config-loaded handler | `main/main.js:215-239` | `config` (same DOM event) | Pan steps, key labels, `syncScrollLatch`, theme/CSS, fullscreen sync |

DOM-event side channels (not `_notify`, must be instrumented separately):
`quivit-config-loaded` (`core.js:545`), `quivit-refresh-start/end` (`fsUtils.js:913,937`),
`quivit-history-changed` (navigationHistory), Tauri `config-updated`/`config-changed`/
`directory-changed`/`single-instance-open` (`main.js:192-202`, `lifecycle.js:35-46`).

---

## 4. Action dispatch lifecycle (`services/actions.js` + `shortcuts.js` + `main.js`)

### 4.1 Registry → map → dispatch

- `ACTION_REGISTRY: Array<{id,label,defaultBinds,category,run(ctx,payload)}>` (`actions.js:7-336`).
  Categories: Navigation (7), View incl. generated `FILTERS` fan-out (15+), Zoom (3), Pan (5),
  Rotation (4), Window & UI (9), File Operations (9). `defaultBinds` is `string|Array`
  (bare `'Backspace'` vs array). `cmd-pan-drag` and `cmd-exit-fullscreen-hold` have
  no-op `run` (gesture-only placeholders, `142`, `211`).
- `CATEGORIES` / `DEFAULT_KEYBINDS` built by loop (`341-353`); `DEFAULT_KEYBINDS[id]` always
  normalized to array.
- `ACTION_MAP: Map(id→action)` (`354`). `dispatch(actionId, payload, ctx)` (`362-365`):
  `ACTION_MAP.get(actionId)` → `await action.run(ctx, payload)`; **silent no-op on unknown id**
  (no throw, no log — telemetry gap #1).

### 4.2 Context injection (`main/main.js:79-93, 95-108, 187`)

`actionCtx` exposes getters: `Core`, `FsUtils`, `Viewer`, `NavigationHistory`, `Chrome`,
`toggleFavoriteCurrent`, `getHighlightedFavorite`, `navigateHighlightedFavorite`,
`openMetadataWindow`, `toggleFullscreen`, plus `isFavoritesFocused()`, `keyboardPanStep`,
`wheelPanStep`. Two entry edges:

1. Menus: `bindMenuCommands()` (`95-108`) — `click` on `#{action.id}` → `dispatch(id, event, actionCtx)`
   (guard: `.muted` / `aria-disabled` clicks dropped).
2. Keyboard/mouse/wheel: `bindKeyboardShortcuts({Core, dispatchAction, dispatchKeyboardPan})`
   (`187`) with `dispatchAction=(id,payload)=>dispatch(id,payload,actionCtx)` and
   `dispatchKeyboardPan(dx,dy)=>Viewer.panBy(dx*keyboardPanStep, dy*keyboardPanStep)` (`74-77`).

### 4.3 `run(ctx,payload)` routing (action → Core/FsUtils call)

| Action ids | `run` body → downstream |
|---|---|
| `cmd-next` / `cmd-prev` | Favorites-focused? `navigateHighlightedFavorite(±1)` : `Core.navigate(±1)` (`10-20`) |
| `cmd-history-back` / `-forward` | `NavigationHistory.goBack/goForward(Core.getState())` → `FsUtils.loadHistoryEntry(entry).catch` (`22-32`) |
| `cmd-parent` | `FsUtils.openParent()` (`34`) |
| `cmd-open-next/prev-container` | `FsUtils.openSibling(±1)` (`37,40`) |
| `cmd-fit-*` (7) | `Core.setFitMode(mode,{persist:true})` (`45-63`) |
| `cmd-scale-*` + cycle (5) | `Core.setScalingMode(mode,{persist:true})`, cycle reads `getState().scalingMode` over `['none','bilinear','lanczos']` (`66-108`) |
| `cmd-filter-off` + per-filter fan-out | `Core.setActiveFilter(null\|id)` with toggle-read via `activeFilterId(frontend_data)` (`77-88`) |
| `cmd-toggle-transparent` | `Core.toggleTransparentBg()` (`111`) |
| `cmd-spread-off / -rtl / -ltr` | `Core.setSpreadMode('off')` / `toggleSpreadMode(dir)` with `{persist:true}` (`114-121`) |
| `cmd-zoom-in/out/100` | `Viewer.zoomAt(±1,x,y)` if `payload.wheel` else `zoomCenter(±1)`; `Viewer.setZoom(1)` (`125-138`) — **no Core state** |
| `cmd-pan-up/down/left/right` | `Viewer.panBy` with `payload.wheel? wheelPanStep : keyboardPanStep` (`145-167`) — **no Core state** |
| `cmd-rotate-ccw/cw`, `cmd-flip-*` | `Viewer.rotate(±90)` / `flipHorizontal/Vertical` (`171-181`) — **no Core state** |
| `cmd-options/github/quit` | Tauri `invoke('open_options')` / `openUrl` / `getCurrentWindow().close()` (quit path relies on `lifecycle.js:50-60` `flushConfig` on close) (`185-230`) |
| `cmd-toggle-filelist` | `Core.setFileListVisible(!getState().fileListVisible)` + manual `.checked` class toggle (`190-194`) |
| `cmd-toggle-menubar/statusbar` | `Chrome.toggleMenuBar/StatusBar()` (`197,200`) — reads `frontend_data.menu_visible/status_visible` via own path |
| `cmd-fullscreen` | `toggleFullscreen()` (`203`) |
| `cmd-toggle-cursor-autohide` | `Viewer.toggleCursorAutoHide?.()` (`207`) |
| `cmd-open-dir/file` | `FsUtils.openDirectoryDialog/openFileDialog` (`234,238`) |
| `cmd-refresh` | `FsUtils.refresh()` (`240`) |
| `cmd-toggle-file-list-view-mode` | `Core.toggleFileListViewMode({persist:true})` (`243`) |
| `cmd-open-explorer/folder` | Tauri `invoke('open_in_explorer')` / `revealItemInDir`, resolved from highlighted favorite or `list[index]` (`246-329`) — **no Core state** |
| `cmd-toggle-favorite` / `cmd-open-metadata` | `toggleFavoriteCurrent()` / `openMetadataWindow()` (`331,334`) |

Read-before-write actions (`getState()` then `set*`): cycle-scaling (2), filter toggle,
toggle-filelist, explorer/folder. These are the races to log with before/after snapshots.

### 4.4 Shortcut → `dispatchAction` edges (`shortcuts.js:202-456`)

- `bindKeyboardShortcuts({Core, dispatchAction, dispatchKeyboardPan})` (`202`): primes
  `updateKeyboardPanBindings(config)` + `rebuildBindMap(config)` (`203-204`), resyncs on
  `quivit-config-loaded` (`205-209`).
- `keydown` (`262-319`): skips interactive targets (`isInteractiveKeyTarget`, `187-200`);
  Enter refocuses `#file-list` (`269-280`); prevents default on arrows/space/Alt (`282-284`);
  tracks scroll-latch tap state (`288-295`); `activeKeys.add(key)` (`297`);
  `findAction(config, formatKeysCombo(activeKeys,activeButtons))` (`298`) — non-pan hits go to
  `handleShortcut→dispatchAction` (`299-303`); else keyboard-pan vector
  (`readKeyboardPanVector`, `172-185`) → `dispatchKeyboardPan` (`306-315`); else fallthrough
  `handleShortcut` (`317`). Bare modifiers ignored for dispatch (`244`).
- `handleShortcut(e)` (`242-260`) and `dispatchMouseButton(button,e)` (`211-224`): shared
  pre-dispatch ritual — `findAction` → `preventDefault/stopPropagation` → `closeMenus()` →
  blur menubar focus → `dispatchAction(actionId[, payload])`.
- `mousedown` capture (`349-360`): skips open-menu clicks (`350`) and side buttons
  (`handleSideButtonPress`, `226-232`, buttons 3/4 → `MouseBack/MouseForward` actions);
  ignores `#file-panel/#menubar/.menu-dropdown/#statusbar` (`355-356`); else
  `activeButtons.add(button)` → `handleMouseButton` (`358-359`).
- `mouseup` (`362-365`) / `auxclick` capture (`367-370`): `suppressSideButtonRelease` swallows
  side-button release (`234-240`); `activeButtons.delete`.
- Double-click arbitration (`376-423`): buttons 0/2 held `DOUBLE_CLICK_MS=350` ms so a second
  press within 8 px becomes `DoubleClick`/`DoubleRightClick` (`402`); single-click dispatch
  deferred in `setTimeout` (`415-422`). Middle/side buttons dispatch immediately (`388-390`).
- `wheel` non-passive (`427-455`): drops UI-chrome wheels (`isWheelOverUI`, `123-126`:
  `#file-panel/#menubar/.menu-dropdown/#statusbar`); toggle-mode synthesizes/removes the
  cached toggle key (`435-446`); `formatKeysCombo(keys,activeButtons,scrollDir)` →
  `findAction` → `dispatchAction(id,{wheel:true,clientX,clientY})` (`454`).
- `keyup` (`321-341`): clean toggle-key tap (down without chord-break, `327-338`) flips
  `_toggleLatched`, updates indicator, **silently** writes
  `config.frontend_data.scroll_zoom_latched` + `Core.persistConfig({debounceMs:1500})`
  (`333-334`); `blur` (`343-347`) clears `activeKeys/activeButtons`.

---

## 5. Navigation trigger origins

Two disjoint navigation families — do not conflate in telemetry:

### 5.1 Intra-list selection (no container reload; stays in `_selectEntry`)

| Origin | Path |
|---|---|
| `cmd-next` / `cmd-prev` keybinds (incl. `Shift+d/s/a/w`, arrows) | shortcuts keydown → `dispatchAction('cmd-next'/'cmd-prev')` → `Core.navigate(±1)` → `_selectEntry` |
| `MouseBack` / `MouseForward` side buttons when bound to history; `DoubleClick`→`cmd-fit-none` default | Same dispatch path; `handleSideButtonPress` / double-click timer |
| File-list click / Enter (`jumpToIndex`, `selectIndex`) | `Core.jumpToIndex(i)` (activate=true → may escalate to container load) / `Core.selectIndex(i)` → `_selectEntry` |
| Spread-step absorption | `Core.navigate` → `setSpreadStep(2\|1)` + return (no index change) |
| Wheel remapped to next/prev (user keybind) | wheel → `dispatchAction` → `Core.navigate` |

### 5.2 Container loads (new `list`; always `Core.setState` + `recordNavigation`)

| Origin | Path | Options / history behavior |
|---|---|---|
| Startup | `Core.init` → `FsUtils.loadFile(startPath,{restoreLastImage:!explicit,preferInitial:explicit,isStartup:true})` | `restoreLastImage` re-selects `last_active_image` if container matches |
| Dir `<..>` / `jumpToIndex` on dir/archive/parent | `_selectEntry(activate=true)` → `FsUtils.openParent()` or `FsUtils.loadFile(file.path)` | Fresh generation, `previousEntry=createHistoryEntry(getState())` (`fsUtils.js:656-658`) |
| `cmd-parent` / Backspace | `FsUtils.openParent()` (`758-802`): archive→parent dir (lands on archive entry via `preferInitial`, else `forceFirstImage`); dir→parent dir (highlights `basename(directory)`); root→`__DRIVES__` | Own `generation`; passes explicit `previousEntry` through to `applyDirectoryResult` |
| `cmd-open-next/prev-container` | `FsUtils.openSibling(±1)` (`804-868`): sorts sibling dirs+archives per `DirectoryPrefs`, walks `delta` direction skipping failures | Delegates to `loadFile(path,{generation (shared!), suppressErrorState:true, isSiblingNavigation:true})` (`852-856`) — note: reuses the **outer** generation |
| `cmd-open-dir/file` dialogs | `openDirectoryDialog` (`870-879`) → `loadFile(selected)`; `openFileDialog` (`881-907`) → `loadFile(selected,{preferInitial:true,restoreLastImage:false})` | Dialog actions carry no history of their own |
| `cmd-history-back/forward` | `NavigationHistory.goBack/goForward(getState())` → `FsUtils.loadHistoryEntry(entry)` (`941-957`) with `{history:'skip',preferInitial:true,targetPath:selectedPath,targetName:selectedName,restoreLastImage:false}` → `loadArchive` or `loadFile` | `history:'skip'` prevents re-recording |
| `cmd-refresh` / `directory-changed` backend event / `show_hidden` flip | `FsUtils.refresh()` (`909-939`): archive→`loadFile(archivePath,{history:'skip',targetName,isRefresh:true})` (+`drop_archive_cache`); drives→reload; dir→`read_directory`+`applyDirectoryResult({preserveFilename:true,history:'skip',isRefresh:true})`; failure→`openParent()` | `preserveFilename`/`isRefresh` use `findNearestSurvivingIndex` (`72-113`); emits `quivit-refresh-start/end` |
| Single-instance / deep link | `lifecycle.js:42-46` `single-instance-open` → `FsUtils.loadFile(payload,{preferInitial:true,restoreLastImage:false})` | |
| Drag & drop | `initDropZone` → `FsUtils.loadFile` (outside the four files; noted for completeness) | |
| Missing-path fallback | `loadFallbackAncestor` (`479-493`): walks `parentOf` up to `__DRIVES__`; used on `isStartup` failures in `loadFile`/`loadArchive` | |

Generation protocol (`fsUtils.js:24-37`): `_nextNavigationGeneration()` at every
`loadFile`/`loadArchive`/`openParent`/`openSibling`/`refresh` entry; `_isCurrentGeneration(g)`
checked after **every** await; stale generations return silently (telemetry gap #2 — log drops).
`openSibling` is the exception: all sibling attempts share one generation.

---

## 6. Surgical hook points for diagnostic telemetry

Goal: full `(trigger → dispatch → mutation → notify → render)` trace with minimal overhead
and no behavior change. Recommended order of implementation:

| # | Hook | Exact location | What to log | Why surgical |
|---|---|---|---|---|
| H1 | `Core.setState` wrapper | `core.js:311-314` | `performance.now()`, `Object.keys(partial)`, before/after pick of `{mode,index,filename,src,archivePath,archiveEncryption,isAnimated}` | Single choke point for **all** container commits (5 `fsUtils.js` sites). Catches navigation + error states in one place. Safe: log then delegate; never mutate `partial`. |
| H2 | `_notify` counter + fan-out timer | `core.js:139-142` | Sequence id, changed top-level keys (diff `_state` vs last snapshot — shallow), listener count, per-listener duration (wrap each `fn` in try/finally timer) | Quantifies double-notify (`setSpreadMode`, anim correction) and isolates slow/throwing subscribers (`filePanel` render is prime suspect). Keep the try/catch **around** measurement only; preserve current throw semantics or explicitly harden. |
| H3 | `dispatch` entry/exit | `services/actions.js:362-365` | `actionId`, `payload` (`wheel/clientX/clientY` or event type), `Date.now()`, duration, unknown-id miss, async error | Only async boundary in the pipeline (`await run`). Unknown-id silent no-op becomes visible here. Correlate with H1/H2 via an async-local dispatch id. |
| H4 | `findAction` misses in shortcut paths | `shortcuts.js:213,251,298,403,417,449` | `formatKeysCombo(...)` string + `activeKeys/activeButtons` sets on miss | Dead-keybind diagnosis (user reports "shortcut does nothing"). Log at `debug` level; these fire on **every** key/mouse/wheel event — sample or gate behind a flag. |
| H5 | `_selectEntry` decision trace | `core.js:166-282` | `(index,activate,clampPreview,direction)`, branch taken (early-clear / out-of-range-drop / openParent-delegate / loadFile-delegate / preview / archive-src / file-src), `newSrc` length/type, generation-abort drops (`203,213`), anim-cache hit/miss | Hottest path; distinguishes "navigation swallowed" (out-of-range, stale generation) from "navigation rendered". Log generation-aborts — currently invisible. |
| H6 | `Core.navigate` spread gate | `core.js:456-498` | `delta`, `spreadEnabled/isSpread/fitMode/spreadStep`, `list.length`, computed `next`, `clampPreview` | Explains "arrow does nothing / needs two presses" (spread absorption, `len<=1` early return). |
| H7 | `FsUtils.loadFile` / `loadArchive` / `applyDirectoryResult` boundaries | `fsUtils.js:652,495,357` | `generation`, `options` (`preferInitial/restoreLastImage/targetPath/targetName/isRefresh/isSiblingNavigation/history`), `previousEntry` container, resolved `index` + strategy used (`restoreLastImage` vs `targetPath` vs `preferInitial` vs `open_first_image` vs `findNearestSurvivingIndex`), backend latency (`read_directory`/`list_archive`) | Container-load waterfall; index-resolution cascade (`375-423`, `549-577`) is the "wrong image selected" root-cause zone. Log stale-generation early returns (`358,433,441,449,503,587,696,744`). |
| H8 | `openParent` / `openSibling` / `refresh` / `loadHistoryEntry` origins | `fsUtils.js:758,804,909,941` | Origin label + params (`delta`, `targetName`, `history:'skip'`), sibling candidate list + skipped failures (`858-861`), `recordNavigation` args | Attributes container loads to user intent (menu vs history vs watcher vs fallback). `refresh` failure→`openParent` escalation (`934-935`) is a surprise-navigation source. |
| H9 | Silent config writes | `core.js:160-164` (`_scheduleConfigFlush`), `core.js:271-277`, `fsUtils.js:350-355`, `shortcuts.js:330-335` | Key written (`last_opened_path`, `last_active_image`, `scroll_zoom_latched`, `fit_mode`, …), debounce delay, `immediate` flag | These change restart behavior with **zero** `_notify` — invisible to state-subscriber telemetry. Counterpart: log `_persistConfig` success/failure (`144-153`; failure is currently console-only). |
| H10 | Subscriber-side render timing | `main.js:110`, `filePanel.js:1593`, `viewerRender.js:315`, `viewerPipelines.js:576`, `passwordOverlay.js:94`, `metadataBadge.js:77`, `lifecycle.js:27` | Per-subscriber duration + snapshot `index/src` seen (detects stale-closure reads via `getState()` inside subscriber) | Proves which subscriber drops frames on rapid `navigate` (key-repeat). Note `_notify` shares `list`/`config` references — log whether subscribers mutate them. |
| H11 | Wheel/latch path | `shortcuts.js:427-455` + `321-347` | `toggleMode`, `_toggleLatched`, synthesized combo, `isWheelOverUI` drops (`428`), chord-break events (`445`) | Wheel "sometimes zooms, sometimes pans" root-cause zone; latch flips persist silently (see H9). |

Minimal-instrumentation sketch (wraps only H1–H3; ~15 lines, zero behavior change):

```js
// core.js — inside Core object, wrap at definition time (dev-only flag)
const __origSetState = Core.setState.bind(Core);
let __seq = 0;
Core.setState = (partial) => {
  const id = ++__seq;
  console.debug(`[tm] #${id} setState keys=${Object.keys(partial).join(',')} mode→${partial.mode} index→${partial.index}`);
  __origSetState(partial);
};
// actions.js — inside dispatch()
console.debug(`[tm] dispatch ${actionId}`, payload);
```

Constraints to respect when instrumenting:
- `_notify` snapshots are shallow — diff only top-level keys or explicitly pick scalar fields; deep-diffing `list` (potentially thousands of entries) per notify will dominate profiles.
- `dispatch` is `async` and callers mostly don't await menu clicks (`main.js:101`) — always `.catch` in probes; never let telemetry reject into the UI.
- Wheel/keydown handlers run at input frequency — H4/H11 logging must be level-gated (`localStorage.quivit-tm=1`) or sampled.
- Generation-abort and unknown-action-drop paths are intentionally silent today — converting them to `console.debug` (not `warn`) preserves console signal while closing the two biggest diagnosis gaps.
