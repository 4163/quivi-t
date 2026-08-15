import { normalizeCombo, normalizeList } from './keyCombo.js';

export const CATEGORIES = [
  {
    name: 'Navigation',
    actions: [
      { id: 'cmd-next', label: 'Next Item' },
      { id: 'cmd-prev', label: 'Previous Item' },
      { id: 'cmd-history-back', label: 'History Back' },
      { id: 'cmd-history-forward', label: 'History Forward' },
      { id: 'cmd-open-next-container', label: 'Open Next Folder/Archive' },
      { id: 'cmd-open-prev-container', label: 'Open Previous Folder/Archive' },
      { id: 'cmd-parent', label: 'Open Parent Folder' },
    ]
  },
  {
    name: 'View',
    actions: [
      { id: 'cmd-fit-none', label: 'Fit None' },
      { id: 'cmd-fit-width', label: 'Fit Width' },
      { id: 'cmd-fit-height', label: 'Fit Height' },
      { id: 'cmd-fit-width-if-larger', label: 'Fit Width If Larger' },
      { id: 'cmd-fit-height-if-larger', label: 'Fit Height If Larger' },
      { id: 'cmd-fit-best', label: 'Auto Fit' },
      { id: 'cmd-cycle-scaling-back', label: 'Scaling: Previous' },
      { id: 'cmd-cycle-scaling', label: 'Scaling: Next' },
      { id: 'cmd-toggle-transparent', label: 'Opaque Canvas' },
    ]
  },
  {
    name: 'Zoom',
    actions: [
      { id: 'cmd-zoom-in', label: 'Zoom In' },
      { id: 'cmd-zoom-out', label: 'Zoom Out' },
      { id: 'cmd-zoom-100', label: 'Zoom 100%' },
    ]
  },
  {
    name: 'Pan',
    actions: [
      { id: 'cmd-pan-drag', label: 'Pan (Drag)' },
      { id: 'cmd-pan-up', label: 'Pan Up' },
      { id: 'cmd-pan-left', label: 'Pan Left' },
      { id: 'cmd-pan-down', label: 'Pan Down' },
      { id: 'cmd-pan-right', label: 'Pan Right' },
    ]
  },
  {
    name: 'Rotation',
    actions: [
      { id: 'cmd-rotate-ccw', label: 'Rotate Counter-clockwise' },
      { id: 'cmd-rotate-cw', label: 'Rotate Clockwise' },
      { id: 'cmd-flip-horizontal', label: 'Flip Horizontal' },
      { id: 'cmd-flip-vertical', label: 'Flip Vertical' },
    ]
  },
  {
    name: 'Window & UI',
    actions: [
      { id: 'cmd-options', label: 'Open Options' },
      { id: 'cmd-toggle-filelist', label: 'Toggle File List' },
      { id: 'cmd-toggle-menubar', label: 'Toggle Menu Bar' },
      { id: 'cmd-toggle-statusbar', label: 'Toggle Status Bar' },
      { id: 'cmd-fullscreen', label: 'Toggle Fullscreen' },
      { id: 'cmd-exit-fullscreen-hold', label: 'Exit Fullscreen (Hold)' },
    ]
  },
  {
    name: 'Files & Folders',
    actions: [
      { id: 'cmd-open-dir', label: 'Open Directory' },
      { id: 'cmd-open-file', label: 'Open File/Archive' },
      { id: 'cmd-refresh', label: 'Refresh Directory' },
    ]
  },
  {
    name: 'File Operations',
    actions: [
      { id: 'cmd-open-explorer', label: 'Reveal in File Explorer' },
      { id: 'cmd-open-folder', label: 'Open Folder in Explorer' },
      { id: 'cmd-toggle-favorite', label: 'Toggle Favorite' },
      { id: 'cmd-open-metadata', label: 'Open Metadata' },
    ]
  }
];

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

export function canUseMenubarBinds(binds, candidateBinds) {
  return hasUsableMenubarBind(binds, candidateBinds);
}

export function isLockedBinding(actionId, bind) {
  return LOCKED_BINDINGS[actionId]?.has(normalizeCombo(bind)) === true;
}
