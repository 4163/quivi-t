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
  'cmd-open-dir': 'Ctrl+o',
  'cmd-open-file': 'Ctrl+Shift+o',
  'cmd-parent': 'Backspace',
  'cmd-options': '4',
  'cmd-fullscreen': '3',
  'cmd-toggle-menubar': '1',
  'cmd-fit-width': 'q',
  'cmd-fit-height': 'e',
  'cmd-fit-width-if-larger': 'r',
  'cmd-fit-height-if-larger': 't',
  'cmd-fit-best': 'f',
  'cmd-zoom-in': 'c',
  'cmd-zoom-out': 'z',
  'cmd-zoom-100': 'x',
  'cmd-refresh': '5',
  'cmd-toggle-filelist': '2',
  'cmd-rotate-ccw': 'g',
  'cmd-rotate-cw': 'h',
  'cmd-flip-horizontal': 'v',
  'cmd-flip-vertical': 'b',
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
        ...(fd.keybinds || {}),
      },
    },
  };
}
