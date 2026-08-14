/**
 * shortcuts.js - keyboard shortcut matching and command dispatch.
 */

import { formatKeysCombo, PASSIVE_ACTIONS, findAction, normalizeCombo, formatKeyName, MOUSE_BUTTON_NAMES, normalizeList, isModifierKey } from './services/keyCombo.js';
import { Statusbar } from './menubar/statusbar.js';
export { normalizeCombo, formatKeyName, formatKeysCombo, MOUSE_BUTTON_NAMES, normalizeList };

export const activeKeys = new Set();
export const activeButtons = new Set();

export function updateMenuShortcuts(config) {
  const binds = config?.frontend_data?.keybinds || {};
  for (const [id, combo] of Object.entries(binds)) {
    const shortcut = document.querySelector(`#${id} .shortcut`);
    if (shortcut) shortcut.textContent = normalizeList(combo)[0] || combo;
  }
}

// Scroll-wheel modifier latch (Options → Keys → Scroll Wheel → Toggle).
// In 'toggle' mode, pressing the zoom modifier once enters a sticky "zoom
// mode" so the wheel keeps zooming without holding the key; pressing it again
// exits. The toggle key is derived from the zoom scroll bindings so rebinding
// zoom to e.g. Alt+ScrollUp makes Alt the toggle key.
// Persistence: the latched state is last-known runtime state, split into
// quivit_state.json by the backend (STATE_KEYS) alongside last_active_image.
// See the persistence policy in core.js.
let _toggleLatched = false;
let _toggleKeyDown = false;
let _toggleChordBroken = false;

export function resetScrollLatch() {
  _toggleLatched = false;
  _toggleKeyDown = false;
  _toggleChordBroken = false;
  // No DOM write here: this always runs right before Core.loadConfig(), and
  // syncScrollLatch() (via quivit-config-loaded) is the single writer, so the
  // latch indicator is not touched on every navigation/config reload.
}

// Re-read the persisted latch after config loads (startup or Options Apply &
// Close). Only meaningful in 'toggle' modifier mode; in 'hold' mode a stale
// latch must not show the badge or latch zoom.
export function syncScrollLatch(config) {
  _toggleLatched = isToggleModifier(config) && config?.frontend_data?.scroll_zoom_latched === true;
  _updateScrollIndicator(config);
}

function isToggleModifier(config) {
  return config?.frontend_data?.scroll_zoom_modifier === 'toggle';
}

// The modifier keys bound to the scroll-wheel combos (Ctrl + Shift by default),
// derived from config so rebinding zoom/pan to e.g. Alt+ScrollUp updates the
// indicator. Deduplicated, in no particular order. ids lets callers scope the
// lookup to the zoom or pan groups.
const _SCROLL_ZOOM_IDS = ['cmd-zoom-in', 'cmd-zoom-out'];
const _SCROLL_PAN_IDS = ['cmd-pan-up', 'cmd-pan-down', 'cmd-pan-left', 'cmd-pan-right'];
const _SCROLL_ALL_IDS = [..._SCROLL_ZOOM_IDS, ..._SCROLL_PAN_IDS];
const _MODIFIER_LOWER = { Ctrl: 'control', Alt: 'alt', Shift: 'shift', Meta: 'meta' };
const _MODIFIER_KEYS = new Set(['control', 'alt', 'shift', 'meta']);
function getScrollModifierKeys(config, ids = _SCROLL_ALL_IDS) {
  const binds = config?.frontend_data?.keybinds || {};
  const found = new Set();
  for (const id of ids) {
    const combo = binds[id];
    const list = normalizeList(combo);
    for (const c of list) {
      if (typeof c === 'string' && /Scroll(Up|Down)$/.test(c)) {
        const token = c.split('+').find(t => _MODIFIER_LOWER[t] !== undefined);
        if (token) found.add(token);
      }
    }
  }
  return Array.from(found);
}

// The e.key names for modifiers that act as the zoom toggle, derived from
// the zoom scroll bindings. Falls back to ['Control'] if no modifier is bound.
const _TOKEN_TO_EVENT_KEY = { Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift', Meta: 'Meta' };
function _getToggleEventKeys(config) {
  const zoomMods = getScrollModifierKeys(config, _SCROLL_ZOOM_IDS);
  if (zoomMods.length === 0) return ['Control'];
  return zoomMods.map(m => _TOKEN_TO_EVENT_KEY[m]).filter(Boolean);
}

// Status-bar indicator for the scroll-wheel modifier. In hold mode a physically
// held bound modifier changes scroll behavior, so it shows e.g. "Ctrl+Shift — Held".
// In toggle mode the sticky latch is the zoom switch, so while latched it shows
// "Scroll Zoom — Toggled"; when unlatched Ctrl does nothing and only a held pan
// modifier (Shift by default) changes behavior, so that is shown as "— Held".
// The two states are mutually exclusive — gated on the configured modifier mode.
// Idempotent: if the rendered text and classes already match the computed state,
// the DOM is left completely untouched.
function _updateScrollIndicator(config) {

  let text = '';
  let held = false;
  let latched = false;

  if (isToggleModifier(config)) {
    if (_toggleLatched) {
      text = 'Scroll Zoom — Toggled';
      latched = true;
    } else {
      // Unlatched: the toggle keys do nothing to the wheel.
      // Only physically held pan modifiers matter.
      const toggleTokens = getScrollModifierKeys(config, _SCROLL_ZOOM_IDS);
      const mods = getScrollModifierKeys(config, _SCROLL_PAN_IDS)
        .filter(m => !toggleTokens.includes(m))
        .filter(m => activeKeys.has(_MODIFIER_LOWER[m] ?? m.toLowerCase()));
      held = mods.length > 0;
      if (held) text = `${mods.join('+')} — Held`;
    }
  } else {
    // Hold mode: show any bound scroll modifier that's physically held,
    // but only if the resulting combo actually resolves to a dispatchable
    // scroll action (e.g. Ctrl+Shift has no binding, so suppress it).
    const mods = getScrollModifierKeys(config)
      .filter(m => activeKeys.has(_MODIFIER_LOWER[m] ?? m.toLowerCase()));
    if (mods.length > 0 && findAction(config, [...mods, 'ScrollUp'].join('+'))) {
      held = true;
      text = `${mods.join('+')} — Held`;
    }
  }

  Statusbar.setScrollIndicatorState(text, held, latched);
}

// The wheel should never hijack scrolling over UI chrome or the file list.
function isWheelOverUI(e) {
  const el = e.target;
  return !!(el.closest?.('#file-panel, #menubar, .menu-dropdown, #statusbar'));
}

const KEYBOARD_PAN_VECTORS = {
  'cmd-pan-up': { x: 0, y: 1 },
  'cmd-pan-left': { x: 1, y: 0 },
  'cmd-pan-down': { x: 0, y: -1 },
  'cmd-pan-right': { x: -1, y: 0 },
};

let keyboardPanBindings = [];

function keybindTokenToActiveKey(token) {
  const lower = token.toLowerCase();
  if (lower === 'ctrl') return 'control';
  if (lower === 'space') return ' ';
  if (lower.startsWith('scroll') || lower.startsWith('mouse') || lower.startsWith('double')) return null;
  return lower;
}

function updateKeyboardPanBindings(config) {
  const binds = config?.frontend_data?.keybinds || {};
  keyboardPanBindings = [];

  for (const [actionId, vector] of Object.entries(KEYBOARD_PAN_VECTORS)) {
    const raw = binds[actionId];
    const list = normalizeList(raw);
    for (const combo of list) {
      if (typeof combo !== 'string') continue;
      const tokens = normalizeCombo(combo).split('+').map(keybindTokenToActiveKey);
      if (tokens.length > 0 && tokens.every(Boolean)) {
        keyboardPanBindings.push({ actionId, tokens, vector });
      }
    }
  }
}

function keyboardPanBindingHeld(binding) {
  for (const token of binding.tokens) {
    if (!activeKeys.has(token)) return false;
  }
  for (const modifier of _MODIFIER_KEYS) {
    if (activeKeys.has(modifier) && !binding.tokens.includes(modifier)) return false;
  }
  return true;
}

function readKeyboardPanVector() {
  let x = 0;
  let y = 0;
  const activeActions = new Set();

  for (const binding of keyboardPanBindings) {
    if (activeActions.has(binding.actionId) || !keyboardPanBindingHeld(binding)) continue;
    activeActions.add(binding.actionId);
    x += binding.vector.x;
    y += binding.vector.y;
  }

  return { x, y };
}

function isInteractiveKeyTarget(e) {
  const target = e.target;
  return !!(target && (
    target.tagName === 'BUTTON'
    || target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT'
    || target.closest?.('button, input, textarea, select')
  ));
}

export function bindKeyboardShortcuts({ Core, dispatchAction, dispatchKeyboardPan }) {
  let lastSideButtonDispatch = { button: null, time: 0 };
  updateKeyboardPanBindings(Core.getState().config);
  window.addEventListener('quivit-config-loaded', () => {
    updateKeyboardPanBindings(Core.getState().config);
  });

  function dispatchMouseButton(button, e) {
    const combo = formatKeysCombo(activeKeys, new Set([button]));
    const actionId = findAction(Core.getState().config, combo);
    if (!actionId) return false;

    e.preventDefault();
    e.stopPropagation();
    lastSideButtonDispatch = { button, time: Date.now() };
    dispatchAction(actionId);
    return true;
  }

  function handleSideButton(e) {
    if (e.button !== 3 && e.button !== 4) return false;

    e.preventDefault();
    e.stopPropagation();

    const now = Date.now();
    if (lastSideButtonDispatch.button === e.button && now - lastSideButtonDispatch.time < 120) {
      return true;
    }

    return dispatchMouseButton(e.button, e);
  }

  const handleShortcut = (e) => {
    // Ignore bare modifiers for dispatch
    if (e.type === 'keydown' && isModifierKey(e.key)) return;

    if (e.type === 'mousedown') {
      const isUI = e.target.closest('.menu-item, #statusbar, .file-panel-header');
      if (isUI) return;
    }

    const actionId = findAction(Core.getState().config, formatKeysCombo(activeKeys, activeButtons));
    if (!actionId) return;

    e.preventDefault();
    dispatchAction(actionId);
  };

  window.addEventListener('keydown', (e) => {
    // Don't hijack Space/arrows when an interactive element (e.g. a button)
    // has focus — Space should still activate the button natively.
    const onInteractive = isInteractiveKeyTarget(e);

    if (!onInteractive && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Alt'].includes(e.key)) {
      e.preventDefault();
    }

    // Track a clean toggle-key tap so 'toggle' mode can latch zoom without
    // being triggered by ordinary shortcuts like Ctrl+X.
    const config = Core.getState().config;
    const toggleKeys = _getToggleEventKeys(config);
    if (toggleKeys.includes(e.key)) {
      if (!e.repeat) {
        _toggleKeyDown = true;
        _toggleChordBroken = false;
      }
    } else {
      if (_toggleKeyDown) _toggleChordBroken = true;
    }

    activeKeys.add(e.key.toLowerCase());
    const actionId = findAction(config, formatKeysCombo(activeKeys, activeButtons));
    if (!onInteractive && actionId && !KEYBOARD_PAN_VECTORS[actionId]) {
      handleShortcut(e);
      if (isModifierKey(e.key)) _updateScrollIndicator(config);
      return;
    }

    const keyboardPanVector = readKeyboardPanVector();
    if (!onInteractive && (keyboardPanVector.x !== 0 || keyboardPanVector.y !== 0)) {
      e.preventDefault();
      dispatchKeyboardPan?.(keyboardPanVector.x, keyboardPanVector.y);
      if (isModifierKey(e.key)) _updateScrollIndicator(config);
      return;
    }

    handleShortcut(e);
    if (isModifierKey(e.key)) _updateScrollIndicator(Core.getState().config);
  });

  window.addEventListener('keyup', (e) => {
    const config = Core.getState().config;
    const toggleKeys = _getToggleEventKeys(config);
    if (toggleKeys.includes(e.key)) {
      // A standalone toggle-key press/release (no other key in between)
      // toggles the sticky zoom latch in 'toggle' mode.
      if (_toggleKeyDown && !_toggleChordBroken && isToggleModifier(config)) {
        _toggleLatched = !_toggleLatched;
        _updateScrollIndicator(config);
        config.frontend_data.scroll_zoom_latched = _toggleLatched;
        Core.persistConfig({ debounceMs: 1500 });
      }
      _toggleKeyDown = false;
      _toggleChordBroken = false;
    }
    activeKeys.delete(e.key.toLowerCase());
    if (isModifierKey(e.key)) _updateScrollIndicator(config);
  });

  window.addEventListener('blur', () => {
    activeKeys.clear();
    activeButtons.clear();
    _updateScrollIndicator(Core.getState().config);
  });

  window.addEventListener('mousedown', (e) => {
    if (handleSideButton(e)) return;

    // Mouse/double-click gestures are viewport actions — never over the file
    // panel, menubar/dropdowns, or status bar (which handle their own clicks).
    const isUI = e.target.closest('#file-panel, .menubar, .dropdown-menu, #statusbar');
    if (isUI) return;

    activeButtons.add(e.button);
    handleMouseButton(e);
  }, { capture: true });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      e.stopPropagation();
    }
    activeButtons.delete(e.button);
  });

  window.addEventListener('auxclick', (e) => {
    handleSideButton(e);
  }, { capture: true });

  // Buttons 0 (left) and 2 (right) wait out a short window before dispatching
  // their single-button binding so a rapid second press can be recognized as a
  // DoubleClick / DoubleRightClick gesture instead of two separate clicks.
  // Other buttons (middle, side) dispatch immediately.
  const DOUBLE_CLICK_MS = 350;
  let clickState = { button: null, x: 0, y: 0, time: 0, timer: null };

  function clearClickTimer() {
    if (clickState.timer) {
      clearTimeout(clickState.timer);
      clickState.timer = null;
    }
  }

  function handleMouseButton(e) {
    const button = e.button;
    if (button !== 0 && button !== 2) {
      handleShortcut(e);
      return;
    }

    const now = Date.now();
    const isDouble = clickState.button === button
      && now - clickState.time < DOUBLE_CLICK_MS
      && Math.abs(e.clientX - clickState.x) < 8
      && Math.abs(e.clientY - clickState.y) < 8;

    if (isDouble) {
      clearClickTimer();
      clickState = { button: null, x: 0, y: 0, time: 0, timer: null };
      const combo = button === 0 ? 'DoubleClick' : 'DoubleRightClick';
      const actionId = findAction(Core.getState().config, combo);
      if (actionId) {
        e.preventDefault();
        dispatchAction(actionId);
      }
      return;
    }

    const combo = formatKeysCombo(activeKeys, activeButtons);
    clearClickTimer();
    clickState = { button, x: e.clientX, y: e.clientY, time: now, timer: null };
    clickState.timer = setTimeout(() => {
      clickState.timer = null;
      const actionId = findAction(Core.getState().config, combo);
      if (actionId) dispatchAction(actionId);
    }, DOUBLE_CLICK_MS);
  }

  // Scroll wheel: route through the keybind table so ScrollUp/ScrollDown and
  // Ctrl+ScrollUp/Ctrl+ScrollDown are remappable. In hold mode a physically
  // held Ctrl synthesizes the modifier; in toggle mode only the sticky latch
  // does, so zooming requires the "zoom mode" to actually be active.
  window.addEventListener('wheel', (e) => {
    if (isWheelOverUI(e)) return;

    const config = Core.getState().config;
    const toggleMode = isToggleModifier(config);
    const keys = new Set(activeKeys);
    const scrollDir = e.deltaY < 0 ? 'ScrollUp' : 'ScrollDown';

    if (toggleMode) {
      const toggleActiveKeys = _getToggleEventKeys(config).map(k => k.toLowerCase());
      // Synthesize the primary toggle key to satisfy the bind matching.
      const primaryActiveKey = toggleActiveKeys[0] || 'control';
      if (_toggleLatched) {
        keys.add(primaryActiveKey);
      } else {
        toggleActiveKeys.forEach(k => keys.delete(k));
      }
      // A wheel event while a toggle key is held means the press wasn't a
      // clean tap, so releasing it must not toggle the latch.
      if (toggleActiveKeys.some(k => activeKeys.has(k))) _toggleChordBroken = true;
    }

    const combo = formatKeysCombo(keys, activeButtons, scrollDir);
    const actionId = findAction(config, combo);
    if (!actionId) return;

    e.preventDefault();
    dispatchAction(actionId, { wheel: true, clientX: e.clientX, clientY: e.clientY });
  }, { passive: false });
}
