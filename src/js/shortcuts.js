/**
 * shortcuts.js - keyboard shortcut matching and command dispatch.
 */

function bindingMatches(binding, combo) {
  return Array.isArray(binding) ? binding.includes(combo) : binding === combo;
}

export const activeKeys = new Set();
export const activeButtons = new Set();

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
      others.push(k === ' ' ? 'Space' : k);
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

  for (const [id, bindCombo] of Object.entries(binds)) {
    if (bindingMatches(bindCombo, combo)) return id;
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
