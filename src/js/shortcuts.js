/**
 * shortcuts.js - keyboard shortcut matching and command dispatch.
 */

function bindingMatches(binding, combo) {
  return Array.isArray(binding) ? binding.includes(combo) : binding === combo;
}

function formatKeyCombo(e) {
  const combo = [];
  if (e.ctrlKey) combo.push('Ctrl');
  if (e.altKey) combo.push('Alt');
  if (e.shiftKey) combo.push('Shift');

  let key = e.key;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toLowerCase();

  combo.push(key);
  return combo.join('+');
}

function findAction(config, combo) {
  const binds = config?.frontend_data?.keybinds || {};

  for (const [id, bindCombo] of Object.entries(binds)) {
    if (bindingMatches(bindCombo, combo)) return id;
  }

  if (combo === 'Ctrl+o') return 'cmd-open-dir';
  if (combo === '3') return 'cmd-options';

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
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
      e.preventDefault();
    }

    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    const actionId = findAction(Core.getState().config, formatKeyCombo(e));
    if (!actionId) return;

    e.preventDefault();
    dispatchAction(actionId);
  });
}
