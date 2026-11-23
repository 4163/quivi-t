# shortcuts.js, keybinds.js & keyboardNav.js: Decoupling Analysis

> Files: `src/js/shortcuts.js` (~511 lines, reported 438), `src/js/keybinds.js` (~117 lines, reported 109), `src/js/keyboardNav.js` (35 lines).

## Part 1: shortcuts.js

### Exports (12)
| Export | Kind | Notes |
|---|---|---|
| `activeKeys` | Set (mutable, module-level) | Shared mutable state, consumed by viewer.js |
| `activeButtons` | Set (mutable) | Same |
| `MOUSE_BUTTON_NAMES` | object | Canonical button#→name table |
| `formatKeyName` | fn | Pure |
| `normalizeCombo` | fn | Pure |
| `formatKeysCombo` | fn | Pure |
| `formatKeyCombo` | fn | Takes unused `e` param: smell |
| `updateMenuShortcuts` | fn | **DOM write** |
| `resetScrollLatch` | fn | Pure (intentionally no DOM) |
| `syncScrollLatch` | fn | Config read + calls DOM writer |
| `bindKeyboardShortcuts` | fn | **Everything DOM/event-based** |

**Imports: none**: yet it's the most DOM-coupled module.

### DOM access level: High / pervasive
- Direct queries: `getElementById('statusbar')`, `querySelector('.status-scroll-zoom')`, `querySelector('#${id} .shortcut')`.
- Direct DOM reads: `e.target.closest(...)` in isWheelOverUI, isInteractiveKeyTarget, handleShortcut.
- Window listeners: keydown, keyup, blur, mousedown (capture), mouseup, auxclick (capture), wheel, `quivit-config-loaded`.

### Responsibility clusters
| Lines | Cluster | Functions/consts |
|---|---|---|
| 5-7 | Combo matching helper | `bindingMatches`: **defined but never called (dead code)** |
| 9 | Passive actions | PASSIVE_ACTIONS |
| 11-12 | Module state | activeKeys, activeButtons |
| 14-51 | Combo normalization | SPECIAL_KEY_MAP, MOUSE_BUTTON_NAMES |
| 53-63 | Combo normalization | formatKeyName, normalizeCombo |
| 65-94 | Combo formatting | formatKeysCombo, formatKeyCombo |
| 96-109 | Keydown dispatch lookup | `findAction` (pure) |
| 111-117 | **Menu DOM write** | updateMenuShortcuts |
| 119-218 | Scroll latch + indicator | resetScrollLatch, syncScrollLatch, isToggleModifier, getScrollModifierKeys, `_updateScrollIndicator` (DOM writer), `_SCROLL_*_IDS`, `_MODIFIER_LOWER`, `_MODIFIER_KEYS` |
| 220-224 | UI-chrome guard | isWheelOverUI (DOM read) |
| 226-283 | Pan vector table | KEYBOARD_PAN_VECTORS, keyboardPanBindings, keybindTokenToActiveKey, updateKeyboardPanBindings, keyboardPanBindingHeld, readKeyboardPanVector |
| 285-294 | Interactive-target guard | isInteractiveKeyTarget (DOM read) |
| 296-510 | **Dispatch monolith** | bindKeyboardShortcuts containing dispatchMouseButton, handleSideButton, handleShortcut, clearClickTimer, handleMouseButton, plus 7 window listeners |

### Coupling
- **viewer.js imports `activeKeys` + `MOUSE_BUTTON_NAMES`**: viewer's drag-pan hold state depends on mutable sets living in the dispatch module.
- **main.js `dispatchAction`** injected as callback; shortcuts calls it for keyboard/mouse/wheel.
- **main.js `dispatchKeyboardPan`** injected; multiplies vector by keyboardPanStep, calls Viewer.panBy.
- **Config mutation from dispatch layer:** latch toggle writes `config.frontend_data.scroll_zoom_latched` + Core.persistConfig directly: bypasses Core API.
- **`_updateScrollIndicator` idempotent sibling**: internal to shortcuts.js but driven from main.js (syncScrollLatch) and inline from every key handler; owns a status-bar sub-widget in main.js's own `#statusbar`.
- **KEYBOARD_PAN_VECTORS action ids** duplicate DEFAULT_KEYBINDS keys + keybindUi labels.
- **keybinds.js imports `normalizeCombo` from shortcuts.js**: pure data module depends on the dispatch module (reverse dependency).
- **main.js has its own keydown listeners** overlapping conceptually (emergency reset, Home/End, fullscreen exit).

### Code smells
1. Dead code: `bindingMatches`.
2. Misleading signature: `formatKeyCombo(e)` ignores `e`.
3. Modifier check `['control','shift','alt','meta'].includes(...)` repeated 6×.
4. `handleShortcut` double-computes findAction.
5. Config mutation from dispatch layer.
6. Module-level mutable exported state (activeKeys/activeButtons): hidden cross-module coupling with viewer.
7. Four nearly-identical keydown exit paths.
8. Duplicate list-normalization idiom inlined 4×.
9. Double-click gesture logic (350ms, <8px) near-copy of keybindUi.js capture logic.
10. `keybindTokenToActiveKey` re-implements modifier/space normalization already owned by normalizeCombo/formatKeyName.

### Decoupling recommendations
- Extract a **pure "combo core"** (SPECIAL_KEY_MAP, MOUSE_BUTTON_NAMES, formatKeyName, normalizeCombo, formatKeysCombo, findAction, PASSIVE_ACTIONS) into a pure module (e.g. `keyCombo.js`). All of shortcuts/keybinds/keybindUi/main/viewer import from it.
- Extract the **scroll latch state machine** into a pure controller exposing a state value; a small DOM adapter renders `.status-scroll-zoom`.
- Extract **KEYBOARD_PAN_VECTORS + readKeyboardPanVector/keyboardPanBindingHeld** into a pure pan-vector resolver.
- Move `.shortcut` menu-label writer (`updateMenuShortcuts`) to main.js/menubar.js where the menu DOM lives.
- Replace direct `scroll_zoom_latched` mutation + Core.persistConfig with a `Core.setScrollZoomLatched(value)` API.

## Part 2: keybinds.js

### Exports (6)
| Export | Kind |
|---|---|
| `DEFAULT_KEYBINDS` | object (default bindings) |
| `DEFAULT_KEYBOARD_PAN_STEP` | const = 72 |
| `DEFAULT_WHEEL_PAN_STEP` | const = 120 |
| `DEFAULT_FIT_MODE` | const = 'height-if-larger' |
| `DEFAULT_SCALING_MODE` | const = 'bicubic' |
| `mergeConfig(loaded)` | fn: config normalization/merging |

**Import:** `normalizeCombo` from `./shortcuts.js` (L7).

**DOM access: None**: fully pure. Shared by core.js and options.js across two windows.

**Coupling:** only dependency is `normalizeCombo` from a DOM-coupled module: the single architectural wart. DEFAULT_KEYBINDS ids are referenced by KEYBOARD_PAN_VECTORS, `_SCROLL_*_IDS`, CATEGORIES, main.js (string-level coupling, unavoidable).

**Recommendations:** Already refactor-ready. Only change needed: eliminate the normalizeCombo import from shortcuts.js: either move normalizeCombo into a shared pure module (keyCombo.js) or duplicate the ~10-line function. Keep as-is otherwise; it's the reference model for "pure module" style.

## Part 3: keyboardNav.js

### Exports
`makeListNavigable(elements, options = {})`: options: horizontal (default true), vertical (true), loop (true).

**Imports: none.** Tiny generic utility: attaches keydown per element, Arrow nav with wrap-around, calls `arr[nextIndex].focus()`.

**Generic / reusable: Yes**: takes any element collection, no app-specific ids, no config coupling. Already reused by options.js in two places (`.tab-btn`, `.theme-btn`).

**DOM coupling:** UI-coupled by design (listeners + `.focus()`), but no hidden coupling to app modules. Minor: `e.stopPropagation()` inside: behavioral contract with shortcuts.js `isInteractiveKeyTarget` undocumented.

**Recommendations:** Leave in place; already the right shape. Optional improvements: single delegated listener on a container; roving-tabindex/ARIA semantics. Can't become pure without becoming a "compute next index" function: current generic DOM-utility form is arguably the correct home.

## Part 4: Cross-file overlap

| Duplicated concern | Where |
|---|---|
| Combo formatting | `formatKeysCombo` (shortcuts.js) vs `keyEventCombo` (main.js): main.js hand-rolls Ctrl/Alt/Shift ordering |
| MOUSE_BUTTON_NAMES | shortcuts.js exported vs SPECIAL_KEY_MAP (same file); mirrored textually in viewer.js pan defaults |
| List normalization idiom | shortcuts.js (4×), keybindUi.js, keybinds.js, main.js: 7+ times across 4 files |
| Modifier key set | shortcuts.js (7 sites), keybindUi.js (2 sites) |
| Double-click gesture (350ms, <8px) | shortcuts.js handleMouseButton vs keybindUi.js onMouseDown |
| Escape fallback / locked binding | keybinds.js mergeConfig vs keybindUi.js LOCKED_BINDINGS |
| Keybind id strings | KEYBOARD_PAN_VECTORS, DEFAULT_KEYBINDS, _SCROLL_*_IDS, CATEGORIES |

**Key formatting note:** formatKeysCombo, normalizeCombo, formatKeyName are already exported and reused by keybindUi.js and keybinds.js: the "formatting" core is 90% centralized; outliers are main.js's private `keyEventCombo` and the dead `formatKeyCombo(e)` wrapper.

## Part 5: Pure vs UI-coupled

**Pure (safe to extract):** keybinds.js: entire file (except the normalizeCombo import). shortcuts.js pure subset: SPECIAL_KEY_MAP, MOUSE_BUTTON_NAMES, PASSIVE_ACTIONS, KEYBOARD_PAN_VECTORS, formatKeyName, normalizeCombo, formatKeysCombo, findAction, keybindTokenToActiveKey, keyboardPanBindingHeld, readKeyboardPanVector, isToggleModifier, getScrollModifierKeys. The latch *state* vars are pure state.

**UI-coupled:** keyboardNav.js (by design, acceptable). shortcuts.js UI subset: activeKeys/activeButtons, updateMenuShortcuts, _updateScrollIndicator, isWheelOverUI, isInteractiveKeyTarget, updateKeyboardPanBindings, bindKeyboardShortcuts.

**Bottom line:** keybinds.js is the pure reference model (redirect its normalizeCombo import). keyboardNav.js is fine. shortcuts.js mixes a ~110-line pure combo/matching core with a ~280-line DOM dispatch monolith: extract the pure combo/pan/latch core, move the scroll indicator + menu-label writers to their DOM owners, replace direct config mutation with a Core API, and route main.js's keyEventCombo through the shared formatKeysCombo.