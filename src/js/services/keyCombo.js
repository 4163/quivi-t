export const PASSIVE_ACTIONS = new Set(['cmd-exit-fullscreen-hold']);

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

export const MOUSE_BUTTON_NAMES = { 0: 'MouseLeft', 1: 'MouseMiddle', 2: 'MouseRight', 3: 'MouseBack', 4: 'MouseForward' };

export function isModifierKey(key) {
  const k = key.toLowerCase();
  return k === 'control' || k === 'alt' || k === 'shift' || k === 'meta';
}

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

export function normalizeList(value) {
  if (!value && value !== 0) return [];
  return Array.isArray(value) ? value : [value];
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

export function findAction(config, combo) {
  const binds = config?.frontend_data?.keybinds || {};

  const lowerCombo = combo.toLowerCase();
  for (const [id, bindCombo] of Object.entries(binds)) {
    const arr = normalizeList(bindCombo);
    if (arr.some(b => b.toLowerCase() === lowerCombo)) return PASSIVE_ACTIONS.has(id) ? null : id;
  }

  return null;
}
