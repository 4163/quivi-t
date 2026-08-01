/**
 * keybinds.js — QuiviT
 * Single source of truth for default keybindings, shared by core.js
 * (main window) and options.js (options window).
 */

export const DEFAULT_KEYBINDS = {
  'cmd-next': ['Shift+d', 'Shift+ArrowRight', 'Shift+s', 'Shift+ArrowDown'],
  'cmd-prev': ['Shift+a', 'Shift+ArrowLeft', 'Shift+w', 'Shift+ArrowUp'],
  'cmd-open-next-container': 'Ctrl+x',
  'cmd-open-prev-container': 'Ctrl+z',
  'cmd-parent': 'Backspace',
  'cmd-options': '3',
  'cmd-fullscreen': '1',
  'cmd-fit-width': 'e',
  'cmd-fit-height': 'r',
  'cmd-fit-width-if-larger': 't',
  'cmd-fit-height-if-larger': 'y',
  'cmd-zoom-in': 'c',
  'cmd-zoom-out': 'z',
  'cmd-zoom-100': 'x',
  'cmd-refresh': '4',
  'cmd-toggle-filelist': '2',
  'cmd-rotate-ccw': 'g',
  'cmd-pan-up': ['w', 'ArrowUp'],
  'cmd-pan-left': ['a', 'ArrowLeft'],
  'cmd-pan-down': ['s', 'ArrowDown'],
  'cmd-pan-right': ['d', 'ArrowRight'],
};

// Pixel distance moved by keyboard pan commands. Increase/decrease this to tune
// W/A/S/D and arrow-key panning without touching the command dispatch code.
export const VIEWER_KEYBOARD_PAN_STEP = 72;
export const DEFAULT_FIT_MODE = 'height-if-larger';
export const DEFAULT_SCALING_MODE = 'bicubic';

const LEGACY_DEFAULT_KEYBINDS = {
  'cmd-next': 'PageDown',
  'cmd-prev': 'PageUp',
  'cmd-options': 'F4',
  'cmd-fullscreen': 'Alt+Enter',
  'cmd-refresh': 'F5',
  'cmd-open-prev-container': 'Ctrl+y',
};

function _sameBinding(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function _migrateLegacyDefaults(keybinds) {
  const migrated = { ...keybinds };
  for (const [id, legacyBinding] of Object.entries(LEGACY_DEFAULT_KEYBINDS)) {
    if (_sameBinding(migrated[id], legacyBinding)) {
      migrated[id] = DEFAULT_KEYBINDS[id];
    }
  }
  return migrated;
}

/**
 * Merge a loaded config's frontend_data over the built-in defaults so
 * keybinds always exist even if a config file was saved before keybinds
 * existed (or was edited by hand).
 */
export function mergeConfig(loaded) {
  const fd = loaded?.frontend_data && typeof loaded.frontend_data === 'object'
    ? loaded.frontend_data
    : {};

  return {
    portable_mode: !!loaded?.portable_mode,
    frontend_data: {
      ...fd,
      continue_last: fd.continue_last !== false,
      start_dir: fd.start_dir || '',
      fit_mode: fd.fit_mode || DEFAULT_FIT_MODE,
      scaling_mode: fd.scaling_mode || DEFAULT_SCALING_MODE,
      show_hidden: fd.show_hidden === true,
      keybinds: {
        ...DEFAULT_KEYBINDS,
        ..._migrateLegacyDefaults(fd.keybinds || {}),
      },
    },
  };
}
