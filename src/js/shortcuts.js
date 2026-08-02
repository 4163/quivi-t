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

export function formatKeysCombo(keysSet, buttonsSet) {
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

export function bindKeyboardShortcuts({ Core, dispatchAction }) {
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
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
      e.preventDefault();
    }
    activeKeys.add(e.key.toLowerCase());
    handleShortcut(e);
  });

  window.addEventListener('keyup', (e) => {
    activeKeys.delete(e.key.toLowerCase());
  });

  window.addEventListener('mousedown', (e) => {
    activeButtons.add(e.button);
    handleShortcut(e);
  });

  window.addEventListener('mouseup', (e) => {
    activeButtons.delete(e.button);
  });
}
