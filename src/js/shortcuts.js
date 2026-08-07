/**
 * shortcuts.js - keyboard shortcut matching and command dispatch.
 */

function bindingMatches(binding, combo) {
  return Array.isArray(binding) ? binding.includes(combo) : binding === combo;
}

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
};

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
    const buttons = { 0: 'MouseLeft', 1: 'MouseMiddle', 2: 'MouseRight', 3: 'MouseBack', 4: 'MouseForward' };
    others.push(buttons[b] || `Mouse${b}`);
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
      if (bindCombo.some(b => b.toLowerCase() === lowerCombo)) return id;
    } else {
      if (bindCombo.toLowerCase() === lowerCombo) return id;
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
  _updateLatchIndicator();
}

// Re-read the persisted latch after config loads (startup or Options Apply &
// Close). Only meaningful in 'toggle' modifier mode; in 'hold' mode a stale
// latch must not show the badge or latch zoom.
export function syncScrollLatch(config) {
  ctrlLatched = isToggleModifier(config) && config?.frontend_data?.scroll_zoom_latched === true;
  _updateLatchIndicator();
}

function isToggleModifier(config) {
  return config?.frontend_data?.scroll_zoom_modifier === 'toggle';
}

function _updateLatchIndicator() {
  const bar = document.getElementById('statusbar');
  if (bar) bar.classList.toggle('zoom-latched', ctrlLatched);
}

// The wheel should never hijack scrolling over UI chrome or the file list.
function isWheelOverUI(e) {
  const el = e.target;
  return !!(el.closest?.('#file-panel, .menubar, .dropdown-menu, #statusbar'));
}

export function bindKeyboardShortcuts({ Core, dispatchAction }) {
  let lastSideButtonDispatch = { button: null, time: 0 };

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
    const target = e.target;
    const onInteractive = target && (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.closest?.('button, input, textarea, select'));

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
    handleShortcut(e);
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') {
      // A standalone Ctrl press/release (no other key in between) toggles the
      // sticky zoom latch in 'toggle' mode.
      if (ctrlKeyDown && !ctrlChordBroken && isToggleModifier(Core.getState().config)) {
        ctrlLatched = !ctrlLatched;
        _updateLatchIndicator();
        const config = Core.getState().config;
        config.frontend_data.scroll_zoom_latched = ctrlLatched;
        Core.persistConfig();
      }
      ctrlKeyDown = false;
      ctrlChordBroken = false;
    }
    activeKeys.delete(e.key.toLowerCase());
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
