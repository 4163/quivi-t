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
    return { ok: false, message: 'Toggle Menu Bar needs at least one non-conflicting binding.' };
  }
  return { ok: true, message: '' };
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

  const SKIP_START = 190, SKIP_END = 240;
  const SKIP_SIZE = SKIP_END - SKIP_START;
  const usable = 360 - SKIP_SIZE;
  const N = conflictCombos.length;
  
  const hues = conflictCombos.map((_, i) => {
    const rawHue = (i / N) * usable;
    return rawHue < SKIP_START ? rawHue : rawHue + SKIP_SIZE;
  });

  const conflictColorMap = {};
  conflictCombos.forEach((combo, i) => {
    conflictColorMap[combo] = `hsl(${Math.round(hues[i])}, 80%, 45%)`;
  });

  return { comboToActions, conflictColorMap };
}


export function isLockedBinding(actionId, bind) {
  return LOCKED_BINDINGS[actionId]?.has(normalizeCombo(bind)) === true;
}
