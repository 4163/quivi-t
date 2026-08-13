/**
 * shortcuts.js - keyboard shortcut matching and command dispatch.
 */

function bindingMatches(binding, combo) {
  return Array.isArray(binding) ? binding.includes(combo) : binding === combo;
}

const PASSIVE_ACTIONS = new Set(['cmd-exit-fullscreen-hold']);

export const activeKeys = new Set();
export const activeButtons = new Set();

const SPECIAL_KEY_MAP = {
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  capslock: 'CapsLock',
  scrolllock: 'ScrollLock',
  numlock: 'NumLock',
  printscreen: 'PrintScreen',
  contextmenu: 'ContextMenu',
  pause: 'Pause',
  scrollup: 'ScrollUp',
  scrolldown: 'ScrollDown',
  doubleclick: 'DoubleClick',
  doublerightclick: 'DoubleRightClick',
  ' ': 'Space',
  space: 'Space',
  mouseleft: 'MouseLeft',
  mousemiddle: 'MouseMiddle',
  mouseright: 'MouseRight',
  mouseback: 'MouseBack',
  mouseforward: 'MouseForward',
};

// Native mouse button number → canonical keybind name. Single source of truth
// shared by formatKeysCombo (dispatch), keybindUi (capture), and the viewer pan
// key lookup — keep the three in sync by using this one table.
export const MOUSE_BUTTON_NAMES = { 0: 'MouseLeft', 1: 'MouseMiddle', 2: 'MouseRight', 3: 'MouseBack', 4: 'MouseForward' };

export function formatKeyName(key) {
  const k = key.toLowerCase();
  if (SPECIAL_KEY_MAP[k]) return SPECIAL_KEY_MAP[k];
  if (k.length === 1) return k;
  return k.charAt(0).toUpperCase() + k.slice(1);
}

export function normalizeCombo(combo) {
  if (typeof combo !== 'string') return combo;
  return combo.split('+').map(formatKeyName).join('+');
}

export function formatKeysCombo(keysSet, buttonsSet, scrollDir) {
  const combo = [];
  const lowerKeys = Array.from(keysSet).map(k => k.toLowerCase());
  
  if (lowerKeys.includes('control')) combo.push('Ctrl');
  if (lowerKeys.includes('alt')) combo.push('Alt');
  if (lowerKeys.includes('shift')) combo.push('Shift');

  const modifiers = ['control', 'alt', 'shift', 'meta'];
  const others = [];

  for (const k of lowerKeys) {
    if (!modifiers.includes(k)) {
      others.push(k === ' ' ? 'Space' : formatKeyName(k));
    }
  }

  for (const b of buttonsSet) {
    others.push(MOUSE_BUTTON_NAMES[b] || `Mouse${b}`);
  }

  others.sort();
  if (scrollDir) others.push(scrollDir);

  return combo.concat(others).join('+');
}

export function formatKeyCombo(e) {
  return formatKeysCombo(activeKeys, activeButtons);
}

function findAction(config, combo) {
  const binds = config?.frontend_data?.keybinds || {};

  const lowerCombo = combo.toLowerCase();
  for (const [id, bindCombo] of Object.entries(binds)) {
    if (Array.isArray(bindCombo)) {
      if (bindCombo.some(b => b.toLowerCase() === lowerCombo)) return PASSIVE_ACTIONS.has(id) ? null : id;
    } else {
      if (bindCombo.toLowerCase() === lowerCombo) return PASSIVE_ACTIONS.has(id) ? null : id;
    }
  }

  return null;
}

export function updateMenuShortcuts(config) {
  const binds = config?.frontend_data?.keybinds || {};
  for (const [id, combo] of Object.entries(binds)) {
    const shortcut = document.querySelector(`#${id} .shortcut`);
    if (shortcut) shortcut.textContent = Array.isArray(combo) ? combo[0] : combo;
  }
}

// Scroll-wheel modifier latch (Options → Keys → Scroll Wheel → Toggle).
// In 'toggle' mode, pressing Ctrl once enters a sticky "zoom mode" so the
// wheel keeps zooming without holding Ctrl; pressing Ctrl again exits.
// persistence: the latched state is last-known runtime state, split into
// quivit_state.json by the backend (STATE_KEYS) alongside last_active_image.
// See the persistence policy in core.js.
let ctrlLatched = false;
let ctrlKeyDown = false;
let ctrlChordBroken = false;

export function resetScrollLatch() {
  ctrlLatched = false;
  ctrlKeyDown = false;
  ctrlChordBroken = false;
  // No DOM write here: this always runs right before Core.loadConfig(), and
  // syncScrollLatch() (via quivit-config-loaded) is the single writer, so the
  // latch indicator is not touched on every navigation/config reload.
}

// Re-read the persisted latch after config loads (startup or Options Apply &
// Close). Only meaningful in 'toggle' modifier mode; in 'hold' mode a stale
// latch must not show the badge or latch zoom.
export function syncScrollLatch(config) {
  ctrlLatched = isToggleModifier(config) && config?.frontend_data?.scroll_zoom_latched === true;
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
    const list = Array.isArray(combo) ? combo : (combo ? [combo] : []);
    for (const c of list) {
      if (typeof c === 'string' && /Scroll(Up|Down)$/.test(c)) {
        const token = c.split('+').find(t => _MODIFIER_LOWER[t] !== undefined);
        if (token) found.add(token);
      }
    }
  }
  return Array.from(found);
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
  const bar = document.getElementById('statusbar');
  const el = document.querySelector('.status-scroll-zoom');
  if (!bar || !el) return;

  let text = '';
  let held = false;
  let latched = false;

  if (isToggleModifier(config)) {
    const isLatched = ctrlLatched;
    if (isLatched) {
      text = 'Scroll Zoom — Toggled';
      latched = true;
    } else {
      // Unlatched: Ctrl is the toggle key, so holding it does nothing to the
      // wheel. Only physically held pan modifiers (Shift by default) matter.
      const mods = getScrollModifierKeys(config, _SCROLL_PAN_IDS)
        .filter(m => m !== 'Ctrl')
        .filter(m => activeKeys.has(_MODIFIER_LOWER[m] ?? m.toLowerCase()));
      held = mods.length > 0;
      if (held) text = `${mods.join('+')} — Held`;
    }
  } else {
    // Hold mode: show any bound scroll modifier that's physically held.
    const mods = getScrollModifierKeys(config)
      .filter(m => activeKeys.has(_MODIFIER_LOWER[m] ?? m.toLowerCase()));
    held = mods.length > 0;
    if (held) text = `${mods.join('+')} — Held`;
  }

  // ── Only write differences ──
  if (el.textContent !== text) el.textContent = text;
  if (bar.classList.contains('zoom-held') !== held) bar.classList.toggle('zoom-held', held);
  if (bar.classList.contains('zoom-latched') !== latched) bar.classList.toggle('zoom-latched', latched);
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
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
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
    if (e.type === 'keydown' && ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    if (e.type === 'mousedown') {
      const isUI = e.target.closest('.menu-item, #statusbar, .file-panel-header');
      if (isUI) return;
    }

    const actionId = findAction(Core.getState().config, formatKeyCombo(e));
    if (!actionId) return;

    e.preventDefault();
    dispatchAction(actionId);
  };

  window.addEventListener('keydown', (e) => {
    // Don't hijack Space/arrows when an interactive element (e.g. a button)
    // has focus — Space should still activate the button natively.
    const onInteractive = isInteractiveKeyTarget(e);

    if (!onInteractive && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
      e.preventDefault();
    }

    // Track a clean Ctrl tap so 'toggle' mode can latch zoom without being
    // triggered by ordinary shortcuts like Ctrl+X.
    if (e.key === 'Control') {
      if (!e.repeat) {
        ctrlKeyDown = true;
        ctrlChordBroken = false;
      }
    } else {
      if (ctrlKeyDown) ctrlChordBroken = true;
    }

    activeKeys.add(e.key.toLowerCase());
    const config = Core.getState().config;
    const actionId = findAction(config, formatKeyCombo(e));
    if (!onInteractive && actionId && !KEYBOARD_PAN_VECTORS[actionId]) {
      handleShortcut(e);
      if (['control', 'shift', 'alt', 'meta'].includes(e.key.toLowerCase())) _updateScrollIndicator(config);
      return;
    }

    const keyboardPanVector = readKeyboardPanVector();
    if (!onInteractive && (keyboardPanVector.x !== 0 || keyboardPanVector.y !== 0)) {
      e.preventDefault();
      dispatchKeyboardPan?.(keyboardPanVector.x, keyboardPanVector.y);
      if (['control', 'shift', 'alt', 'meta'].includes(e.key.toLowerCase())) _updateScrollIndicator(config);
      return;
    }

    handleShortcut(e);
    if (['control', 'shift', 'alt', 'meta'].includes(e.key.toLowerCase())) _updateScrollIndicator(Core.getState().config);
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') {
      // A standalone Ctrl press/release (no other key in between) toggles the
      // sticky zoom latch in 'toggle' mode.
      if (ctrlKeyDown && !ctrlChordBroken && isToggleModifier(Core.getState().config)) {
        ctrlLatched = !ctrlLatched;
        _updateScrollIndicator(Core.getState().config);
        const config = Core.getState().config;
        config.frontend_data.scroll_zoom_latched = ctrlLatched;
        Core.persistConfig();
      }
      ctrlKeyDown = false;
      ctrlChordBroken = false;
    }
    activeKeys.delete(e.key.toLowerCase());
    if (['control', 'shift', 'alt', 'meta'].includes(e.key.toLowerCase())) _updateScrollIndicator(Core.getState().config);
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

    const combo = formatKeyCombo(e);
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
    const latched = toggleMode && ctrlLatched;
    const keys = new Set(activeKeys);
    const scrollDir = e.deltaY < 0 ? 'ScrollUp' : 'ScrollDown';

    if (toggleMode) {
      if (latched) keys.add('control');
      else keys.delete('control');
    }
    // A wheel event while Ctrl is down means the press wasn't a clean tap, so
    // releasing Ctrl must not toggle the latch.
    if (activeKeys.has('control')) ctrlChordBroken = true;

    const combo = formatKeysCombo(keys, activeButtons, scrollDir);
    const actionId = findAction(config, combo);
    if (!actionId) return;

    e.preventDefault();
    dispatchAction(actionId, { wheel: true, clientX: e.clientX, clientY: e.clientY });
  }, { passive: false });
}
