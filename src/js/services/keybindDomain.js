import { normalizeCombo, normalizeList } from './keyCombo.js';

import { CATEGORIES as REGISTRY_CATEGORIES } from './actions.js';

export const CATEGORIES = REGISTRY_CATEGORIES;

export const SINGLE_INPUT_ACTIONS = new Set(['cmd-pan-drag', 'cmd-exit-fullscreen-hold']);
export const LOCKED_BINDINGS = {
  'cmd-exit-fullscreen-hold': new Set(['Escape']),
};
export const MENUBAR_ACTION = 'cmd-toggle-menubar';

export function comboUsedByOtherAction(binds, ownerActionId, combo) {
  const normalizedCombo = normalizeCombo(combo);
  return Object.entries(binds).some(([actionId, raw]) => (
    actionId !== ownerActionId && normalizeList(raw).map(normalizeCombo).includes(normalizedCombo)
  ));
}

export function hasUsableMenubarBind(binds, candidateBinds = normalizeList(binds[MENUBAR_ACTION])) {
  return candidateBinds.some(bind => !comboUsedByOtherAction(binds, MENUBAR_ACTION, bind));
}

export function validateKeybindSafety(config) {
  const binds = config?.frontend_data?.keybinds || {};
  if (!hasUsableMenubarBind(binds)) {
    return { ok: false, message: 'Keep one Menu Bar shortcut that does not conflict with another shortcut.' };
  }
  return { ok: true, message: '' };
}

export function computeSlotHue(index, total) {
  if (!total || total <= 0) return 'hsl(0, 80%, 45%)';
  const count = Math.max(1, total);
  const normIdx = ((index % count) + count) % count;
  const SKIP_START = 190;
  const SKIP_END = 240;
  const SKIP_SIZE = SKIP_END - SKIP_START;
  const usable = 360 - SKIP_SIZE;
  const rawHue = (normIdx / count) * usable;
  const hue = rawHue < SKIP_START ? rawHue : rawHue + SKIP_SIZE;
  let rounded = Math.round(hue) % 360;
  if (rounded >= SKIP_START && rounded <= SKIP_END) {
    rounded = rawHue < SKIP_START ? (SKIP_START - 1) : (SKIP_END + 1);
  }
  return `hsl(${rounded}, 80%, 45%)`;
}

export function getConflictColors(binds) {
  const comboToActions = {};
  for (const [actionId, raw] of Object.entries(binds)) {
    const list = normalizeList(raw);
    for (const combo of list) {
      if (!comboToActions[combo]) comboToActions[combo] = [];
      comboToActions[combo].push(actionId);
    }
  }

  const conflictCombos = Object.entries(comboToActions)
    .filter(([, ids]) => ids.length > 1)
    .map(([combo]) => combo);

  if (conflictCombos.length === 0) return { comboToActions, conflictColorMap: {} };

  const N = conflictCombos.length;
  const conflictColorMap = {};
  conflictCombos.forEach((combo, i) => {
    conflictColorMap[combo] = computeSlotHue(i, N);
  });

  return { comboToActions, conflictColorMap };
}


export function isLockedBinding(actionId, bind) {
  return LOCKED_BINDINGS[actionId]?.has(normalizeCombo(bind)) === true;
}
