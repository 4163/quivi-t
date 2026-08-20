# keybindUi.js & options.js: Decoupling Analysis

> Files: `src/js/keybindUi.js` (~593 lines, reported 560) and `src/js/options.js` (~430 lines, reported 398).

## Part 1: keybindUi.js

### Exports / Imports
| Kind | Names |
|---|---|
| Exports | `validateKeybindSafety(config)` (L108-114), `initKeybindUi(containerId, config, showStatus)` (L116-592) |
| Imports | `formatKeysCombo`, `normalizeCombo` from `./shortcuts.js` (L1) |

- `validateKeybindSafety` is **pure**: takes config, returns `{ ok, message }`. Zero DOM.
- `initKeybindUi` is **heavily DOM-coupled**: getElementById, createElement, classList/textContent writes, capture-phase window listeners (keydown/keyup/mousedown/mouseup/wheel/contextmenu), full `container.innerHTML = ''` rebuilds.

### Responsibility clusters
| Cluster | Lines | Functions |
|---|---|---|
| Static catalog/data | 3-91 | CATEGORIES, SINGLE_INPUT_ACTIONS, LOCKED_BINDINGS, MENUBAR_ACTION |
| Pure keybind-domain helpers | 93-114 | `keybindList`, `comboUsedByOtherAction`, `hasUsableMenubarBind`, `validateKeybindSafety` |
| Conflict color computation | 119-151 | `getConflictColors` (pure: comboToActions + HSL conflictColorMap) |
| Menubar-safety / lock checks | 153-165 | `canUseMenubarBinds`, `isLockedBinding`, `showLockedBindingStatus` |
| Capture state machine | 167-425 | `captureKeybind`: double-click gesture (200-207), wheel settle timer (211-226), `finish` (228-259), `cleanup` (261-276), `updateState` (278-325), onKeyDown/Up (327-355), onMouseDown/Up (357-389), onContextMenu (391-394), onWheel (400-417) |
| Scroll-modifier toggle widget | 427-467 | `createScrollModeToggle` |
| Rendering | 469-592 | `renderKeybinds` + initial call + return `{ renderKeybinds }` |

### Coupling / overlap
- **shortcuts.js**: imports formatKeysCombo/normalizeCombo (shared formatting), but the capture gesture engine re-implements dispatch-side semantics.
- **keybinds.js**: CATEGORIES ids must stay in sync with DEFAULT_KEYBINDS; the "Escape locked for cmd-exit-fullscreen-hold" rule also enforced in mergeConfig.
- **options.js**: mutates the caller-owned config object in place; options.js calls `renderKeybinds()` manually after reset and runs validateKeybindSafety before save.

### Code smells
1. In-place mutation of caller-owned config: no change callback/event.
2. Menubar safety rule triplicated in-file: `validateKeybindSafety` (L108), `finish` (L241/249), `removeBinding` (L521): same message 3×.
3. `getConflictColors` recomputed redundantly (renderKeybinds + per-action in renderTags); combined with `innerHTML=''` = full teardown/rebuild on every keystroke-capture.
4. Escape-lock policy split: LOCKED_BINDINGS + hardcoded `'Escape'` literals in showLockedBindingStatus/isLockedBinding.
5. ~260-line anonymous capture state machine mixing pure gesture decisions with DOM writes and timer juggling.
6. Duplicate modifier-key array `['control','shift','alt','meta']` at L295/339/409: shortcuts.js already defines `_MODIFIER_KEYS`.
7. Static CATEGORIES catalog drifts from DEFAULT_KEYBINDS: no single source of truth.
8. `createScrollModeToggle` writes `scroll_zoom_modifier` directly into config (consumed by shortcuts.js latch logic).

### Decoupling recommendations
- Extract a **pure keybind domain module** (`keybindDomain.js` or extend keybinds.js): `keybindList`, `comboUsedByOtherAction`, `hasUsableMenubarBind`, `canUseMenubarBinds`, `isLockedBinding`, `getConflictColors`, a single `validateMenubarSafety(binds)` predicate. Testable with zero DOM.
- Move CATEGORIES into the shared catalog (or derive labels from DEFAULT_KEYBINDS).
- Change initKeybindUi to take a read-only binds accessor and report mutations via `onKeybindsChanged(callback)`.
- Replace `innerHTML=''` with diff/incremental render to preserve focus/scroll.
- Reuse shared gesture primitives from shortcuts.js (double-click window, wheel direction, modifier set).

## Part 2: options.js

### Exports / Imports
| Kind | Names |
|---|---|
| Exports | **None**: side-effectful entry-point module |
| Imports | mergeConfig, DEFAULT_KEYBINDS (keybinds.js); makeListNavigable (keyboardNav.js); initKeybindUi, validateKeybindSafety (keybindUi.js); initAssociationsUi, applyAssociations (associationsUi.js) |

**Fully DOM-coupled** plus Tauri invoke/emit/listen and localStorage. No DOM-free logic.

### Responsibility clusters
| Cluster | Lines | Functions |
|---|---|---|
| Tauri bindings + module state | 6-23 | tauri, invoke, emit, listen, open, tauriConfirm; config, statusEl, labels, keybindUiInstance, previewing, forceClose |
| Emergency reset + Tab-nav (top-level keydown) | 26-64 | Ctrl+Shift+Alt+C CSS reset (26-48), Home/End jump (50-63) |
| Theme/CSS application | 66-86 | `applyTheme`, `applyCustomCss` |
| Status + live config refresh | 88-109 | `showStatus`, `refreshLiveConfigState` |
| Boot / field binding | 111-160 | `init`: loads config, binds inputs, theme buttons, initKeybindUi, initAssociationsUi; catch-path fallback |
| Tab navigation | 163-179 | `switchTab`, tab wiring, saved-tab restore |
| Keybind reset | 181-185 | reset to DEFAULT_KEYBINDS + renderKeybinds |
| Directory buttons | 188-217 | browse start dir, open config/local-data dir |
| Theme buttons / previewing | 219-233 | theme-preview emit, `previewing = true` |
| Window close + revert | 235-275 | closeOptionsWindow, revertPreviewChanges, onCloseRequested handler |
| CSS import/export | 278-312 | read_text_file / write_text_file |
| CSS preview | 314-330 | `previewCss`, Apply button, Ctrl+S |
| **Save flow** | 332-377 | validation, form read, mergeConfig, invoke save_config, emit config-updated, status |
| Cancel | 379-382 | revert + close |
| **Width auto-fit** | 384-419 | OPTIONS_MAX_INITIAL_W, fitTail, fitContentWidth |
| Window show + boot chain | 421-430 | showOptionsWindow, init().then(fitContentWidth).then(showOptionsWindow) |

### Coupling / overlap
- **Preview protocol duplicated**: `theme-preview`/`css-preview` events here consumed by main.js + metadata-window.js; `previewing` flag mirrors main.js previewTheme/previewCss: "keep preview alive across reload" rule lives in two windows.
- **Emergency CSS reset** near-verbatim copy of main.js L27-51.
- **Home/End tab jump** near-verbatim copy of main.js L53-66.
- **applyTheme / applyCustomCss** triplicated (options.js, main.js, metadata-window.js).
- **Save flow re-implements Core.saveConfig**: options.js does its own collect → mergeConfig → assign → invoke save_config → emit config-updated, duplicating core.js saveConfig semantics.
- **core.js "no DOM" claim violated**: Core.loadConfig writes `data-theme` + localStorage (L306-312): same theme logic options.js duplicates.

### Code smells
1. `currentTheme` used before its declaration (works only because init runs at the bottom).
2. `tauriConfirm` bound but never used.
3. 45-line monolithic save handler mixing DOM reads, safety validation, config mapping, merge, invoke, localStorage, status.
4. `previewing` cross-window protocol flag duplicated in main.js with different variable shapes.
5. Inconsistent element caching.
6. Catch-path fallback re-inits keybind UI with possibly-default config.
7. `fitContentWidth` mutates `.tabs` style to measure: layout thrash; magic constant.
8. `OPTIONS_MAX_INITIAL_W = 560` duplicates Rust `OPTIONS_MAX_W = 560.0` in config.rs: cross-language drift risk.
9. CSS Apply button only previews (Save is separate): status text apologizes.
10. Nothing is unit-testable: zero exports, top-level side effects.

### Decoupling recommendations
- Extract a **shared preview module** (`configPreview.js`): previewing state machine (previewing, current theme/CSS, revertPreviewChanges, event protocol) used by options.js and main.js.
- Extract **applyTheme / applyCustomCss** (+ emergency reset + Home/End) into a shared UI-utilities module; the three copies are byte-for-byte similar.
- Route options save through a **shared config-save helper** instead of duplicating merge+invoke+emit.
- Pull **width auto-fit** into a small window-fit module; consider generating OPTIONS_MAX_W from a single source shared with config.rs.
- Split the save handler into pure form→config mapping + thin IPC glue.

## Part 3: Cross-file overlap

| # | Duplicated logic | Locations |
|---|---|---|
| a | Double-click gesture (350ms, 8px) | keybindUi.js capture vs shortcuts.js dispatch |
| b | Wheel direction mapping | keybindUi.js vs shortcuts.js |
| c | Modifier key set | keybindUi.js vs shortcuts.js |
| d | String-or-array keybind normalization | keybindUi.js, shortcuts.js, keybinds.js, main.js |
| e | Escape-lock policy for cmd-exit-fullscreen-hold | keybindUi.js, keybinds.js, shortcuts.js, main.js |
| f | applyTheme / applyCustomCss (3 copies) | options.js, main.js, metadata-window.js (+ inline head scripts = 4th) |
| g | Emergency CSS Reset (Ctrl+Shift+Alt+C) | options.js vs main.js (verbatim) |
| h | Home/End tab navigation jump | options.js vs main.js (verbatim) |
| i | localStorage keys `quivit-theme`/`quivit-custom-css` | options.js, main.js, metadata-window.js, core.js, head scripts |
| j | Preview-state preservation across config reload | options.js `previewing` vs main.js previewTheme/previewCss |
| k | Config merge + save + config-updated | options.js vs core.js saveConfig/loadConfig |
| l | Menubar "keep one binding" rule (within keybindUi) | validateKeybindSafety, finish, removeBinding |
| m | Cross-language width cap | options.js 560 vs config.rs 560.0 |

## Part 4: Pure vs UI-coupled

**keybindUi.js pure:** CATEGORIES, SINGLE_INPUT_ACTIONS, LOCKED_BINDINGS, MENUBAR_ACTION, keybindList, comboUsedByOtherAction, hasUsableMenubarBind, validateKeybindSafety, getConflictColors, canUseMenubarBinds, isLockedBinding, and the candidate-validation core inside `finish`.

**keybindUi.js UI-coupled:** capture listeners + all element/textContent/classList writes, cleanup/updateState, createScrollModeToggle, renderKeybinds, showLockedBindingStatus.

**options.js pure:** none. Closest: refreshLiveConfigState decision logic and save form→config mapping: both fused with DOM/IPC.

**core.js related observation:** despite the "No DOM access" header, Core.loadConfig writes data-theme + localStorage: the theme-application responsibility options.js and main.js each duplicate.

**Highest-use targets:** (1) shared keybind domain module; (2) shared theme/CSS preview module (+ emergency reset, preview preservation); (3) shared gesture primitives in shortcuts.js; and restoring core.js purity by moving theme application out.