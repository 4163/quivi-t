# Lazy Config Save + Exit Flush Implementation Plan

## Goal

Move frequently toggled viewer/UI preferences away from immediate `save_config` writes. The UI should update instantly, mark config as dirty in memory, save lazily after idle, and flush pending changes when the app exits.

This is a performance-focused persistence change. It should not alter visible behavior except reducing frame drops and config watcher churn during rapid toggles.

## Scope

Lazy-save these existing config-backed preferences:

- `frontend_data.menu_visible`
- `frontend_data.status_visible`
- `frontend_data.transparent_bg` / opaque canvas toggle
- `frontend_data.scroll_zoom_latched`
- `frontend_data.fit_mode`
- `frontend_data.scaling_mode`

Do not include:

- File list visibility. It is not currently persistent and should remain session-only.
- Fullscreen auto-hide menu/status changes. These are temporary and must never write `menu_visible` or `status_visible`.
- Options window Apply behavior. Applying Options should continue to save immediately.
- Runtime state such as `last_active_image`, unless separately requested.

## Current relevant flow

### Config writes

`src/js/core.js` owns config persistence:

- `_persistConfig()` calls Tauri `save_config`.
- `Core.persistConfig()` currently supports optional debounce via `debounceMs`.
- Several preference methods still call `_persistConfig()` directly:
  - `toggleTransparentBg()`
  - `setFitMode(..., { persist: true })`
  - `setScalingMode(..., { persist: true })`
  - internal remember-last-image flow

`src/js/menubar.js`:

- `saveUIState()` writes `frontend_data.menu_visible`.
- It now uses `Core.persistConfig({ debounceMs: 300 })`.

`src/js/main.js`:

- `setStatusBarVisible(..., { persist: true })` writes `frontend_data.status_visible`.
- It now uses `Core.persistConfig({ debounceMs: 300 })`.
- Fullscreen auto-hide uses `setMenuBarVisible(false)` and `setStatusBarVisible(false)` without `persist: true`, so it is already non-persistent.

`src/js/shortcuts.js`:

- Scroll zoom latch currently mutates `config.frontend_data.scroll_zoom_latched` and calls `Core.persistConfig()`.

### Rust close handling

`src-tauri/src/lib.rs` already handles normal window close events:

- `WindowEvent::CloseRequested`
- Main window close also closes secondary windows.

This is the right area to coordinate an exit flush if using a backend-side command or event.

## Proposed design

### 1. Add dirty-aware save scheduling in `Core`

In `src/js/core.js`, replace the simple debounce timer with explicit dirty state:

```js
let _configDirty = false;
let _persistTimer = null;

function _markConfigDirty() {
  _configDirty = true;
}

async function _flushConfig() {
  clearTimeout(_persistTimer);
  _persistTimer = null;
  if (!_configDirty) return;
  _configDirty = false;
  await _persistConfigNow();
}

function _scheduleConfigFlush(delayMs = 1500) {
  _markConfigDirty();
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(_flushConfig, delayMs);
}
```

Keep the existing direct save behavior available for explicit saves:

```js
Core.persistConfig({ immediate: true })
Core.persistConfig({ debounceMs: 1500 })
Core.flushConfig()
```

Suggested public API:

```js
persistConfig(options = {}) {
  if (options.immediate) return _flushConfig();
  _scheduleConfigFlush(options.debounceMs ?? 1500);
},

flushConfig() {
  return _flushConfig();
}
```

Implementation detail: `_flushConfig()` should clear the timer before saving to avoid a second delayed save firing after an exit flush.

### 2. Convert scoped preferences to lazy persistence

Update these preference paths to mutate in-memory config immediately, notify/update DOM immediately, then call debounced persistence.

Use a shared delay constant. Recommended initial value:

```js
const GUI_PREF_SAVE_DEBOUNCE_MS = 1500;
```

#### Menu visibility

File: `src/js/menubar.js`

Current persistent path:

```js
state.config.frontend_data.menu_visible = menuBarVisible;
Core.persistConfig({ debounceMs: 300 });
```

Change to:

```js
Core.persistConfig({ debounceMs: GUI_PREF_SAVE_DEBOUNCE_MS });
```

Or import/use a Core default so the delay is not duplicated across modules.

#### Status visibility

File: `src/js/main.js`

Current persistent path:

```js
state.config.frontend_data.status_visible = statusBarVisible;
Core.persistConfig({ debounceMs: 300 });
```

Change to the same lazy GUI debounce.

Important: fullscreen calls must continue using `persist: false`.

#### Opaque/transparent canvas

File: `src/js/core.js`

Current:

```js
toggleTransparentBg() {
  _state.config.frontend_data.transparent_bg = !_state.config.frontend_data.transparent_bg;
  _persistConfig();
  _notify();
}
```

Change to:

```js
toggleTransparentBg() {
  _state.config.frontend_data.transparent_bg = !_state.config.frontend_data.transparent_bg;
  _scheduleConfigFlush(GUI_PREF_SAVE_DEBOUNCE_MS);
  _notify();
}
```

UI still updates immediately because `_notify()` remains immediate.

#### Scroll zoom latch

File: `src/js/shortcuts.js`

Current behavior mutates:

```js
config.frontend_data.scroll_zoom_latched = ctrlLatched;
Core.persistConfig();
```

Change to:

```js
config.frontend_data.scroll_zoom_latched = ctrlLatched;
Core.persistConfig({ debounceMs: GUI_PREF_SAVE_DEBOUNCE_MS });
```

If the user taps Ctrl repeatedly, those latch changes should collapse into one write.

#### Fit mode

File: `src/js/core.js`

Current:

```js
setFitMode(mode, options = {}) {
  _state.fitMode = mode;
  if (options.persist) {
    _state.config.frontend_data.fit_mode = mode;
    _persistConfig();
  }
  _notify();
}
```

Change only the persistence call:

```js
if (options.persist) {
  _state.config.frontend_data.fit_mode = mode;
  _scheduleConfigFlush(GUI_PREF_SAVE_DEBOUNCE_MS);
}
```

Do not delay `_notify()`. Fit changes must remain visually immediate.

#### Scaling mode

File: `src/js/core.js`

Same as fit mode:

```js
if (options.persist) {
  _state.config.frontend_data.scaling_mode = mode;
  _scheduleConfigFlush(GUI_PREF_SAVE_DEBOUNCE_MS);
}
```

Keep `_notify()` immediate.

### 3. Preserve immediate Options Apply

File: `src/js/options.js`

The Options Apply path calls Tauri `save_config` directly. Leave it immediate.

Reason: Apply is an explicit save action, not a high-frequency viewer interaction.

If `Core.saveConfig(...)` is involved in any Options path, it should keep using immediate `invoke('save_config', ...)`.

### 4. Add exit flush

Need to flush pending dirty config on normal app close.

Preferred frontend approach:

In `src/js/main.js`, register Tauri close handling for the main window:

```js
const mainWindow = window.__TAURI__?.window?.getCurrentWindow?.();
mainWindow?.onCloseRequested(async () => {
  await Core.flushConfig?.();
});
```

If Tauri closes before async work finishes, use the prevent/re-close pattern:

```js
let closingAfterFlush = false;

mainWindow.onCloseRequested(async (event) => {
  if (closingAfterFlush) return;
  event.preventDefault();
  await Core.flushConfig();
  closingAfterFlush = true;
  await mainWindow.close();
});
```

This pattern should be verified against the current Tauri JS API used in `src/js/options.js`, which already uses `onCloseRequested`.

Important:

- Avoid loops with the re-close guard.
- Do not block forever on save failure. `Core.flushConfig()` should catch/log errors or resolve after attempting the save.
- Existing Rust `CloseRequested` handling in `src-tauri/src/lib.rs` closes child windows; the JS flush should run before the main window is allowed to close.

### 5. Quit menu should flush too

File: `src/js/main.js`

Current quit path:

```js
window.__TAURI__.core.invoke('plugin:process|exit')
```

Before invoking process exit, flush config:

```js
await Core.flushConfig();
await window.__TAURI__.core.invoke('plugin:process|exit');
```

If the quit command is not async yet, make the handler async.

This matters because a direct process exit may bypass normal close handling.

### 6. Backend hard-exit caveats

This design handles:

- Window X close
- Alt+F4
- menu Quit, if wired to flush first
- normal application close

It cannot reliably handle:

- Task Manager kill
- hard crash
- power loss
- forced OS termination

That is why the debounce should still save after idle. Exit flush is a safety net, not the only persistence mechanism.

## Non-goals and guardrails

- Do not make file panel visibility persistent.
- Do not persist fullscreen auto-hide effects.
- Do not delay visual updates.
- Do not call `save_config` directly from high-frequency viewer toggles.
- Do not trigger full Core notifications just to persist a config value.
- Do not add per-toggle timers scattered across modules; prefer one Core-owned scheduler.

## Suggested verification

### Static checks

Run:

```powershell
node --check src/js/core.js
node --check src/js/main.js
node --check src/js/menubar.js
node --check src/js/shortcuts.js
git diff --check
```

### Manual behavior checks

1. Toggle menu/status/opaque canvas/fit/scaling quickly.
   - UI should update instantly.
   - No visible hitching from config writes.

2. Toggle several preferences within the debounce window.
   - Should result in one save after idle.

3. Enter fullscreen with auto-hide enabled.
   - Menu/status hide.
   - `menu_visible` and `status_visible` in config should not be changed by the auto-hide.

4. Exit fullscreen.
   - Menu/status restore to pre-fullscreen state.
   - No config write should happen from the temporary restore.

5. Change one lazy preference and close via window X before debounce fires.
   - Preference should persist after restart.

6. Change one lazy preference and quit via app menu before debounce fires.
   - Preference should persist after restart.

7. Toggle scroll zoom latch, close before debounce fires.
   - Latch state should persist after restart if that is still desired behavior.

## Expected result

After implementation:

```text
Viewer/UI action
  -> DOM/state update immediately
  -> config is marked dirty
  -> one debounced save after idle
  -> pending dirty config flushes on app exit
```

This keeps QuiviT responsive during rapid viewer interaction while preserving preferences robustly during normal exits.
