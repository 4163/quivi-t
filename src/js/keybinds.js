/**
 * keybinds.js — QuiviT
 * Single source of truth for default keybindings, shared by core.js
 * (main window) and options.js (options window).
 */

import { normalizeCombo } from './shortcuts.js';

export const DEFAULT_KEYBINDS = {
  'cmd-next': ['Shift+d', 'Shift+ArrowRight', 'Shift+s', 'Shift+ArrowDown', 'MouseForward'],
  'cmd-prev': ['Shift+a', 'Shift+ArrowLeft', 'Shift+w', 'Shift+ArrowUp', 'MouseBack'],
  'cmd-zoom-in': ['c', 'Ctrl+ScrollUp'],
  'cmd-zoom-out': ['z', 'Ctrl+ScrollDown'],
  'cmd-open-next-container': 'Ctrl+x',
  'cmd-open-prev-container': 'Ctrl+z',
  'cmd-open-dir': 'Ctrl+o',
  'cmd-open-file': 'Ctrl+Shift+o',
  'cmd-open-explorer': [],
  'cmd-open-folder': [],
  'cmd-toggle-favorite': [],
  'cmd-parent': 'Backspace',
  'cmd-toggle-filelist': '1',
  'cmd-toggle-menubar': '2',
  'cmd-toggle-statusbar': '3',
  'cmd-fullscreen': ['4', 'Alt+Enter'],
  'cmd-toggle-transparent': [],
  'cmd-options': '5',
  'cmd-fit-width': 'q',
  'cmd-fit-height': 'e',
  'cmd-fit-width-if-larger': 'r',
  'cmd-fit-height-if-larger': 't',
  'cmd-fit-best': 'f',
  'cmd-zoom-100': 'x',
  'cmd-cycle-scaling': ']',
  'cmd-refresh': ['6', 'Ctrl+r'],
  'cmd-rotate-ccw': 'g',
  'cmd-rotate-cw': 'h',
  'cmd-flip-horizontal': 'v',
  'cmd-flip-vertical': 'b',
  'cmd-pan-up': ['w', 'ArrowUp', 'ScrollUp'],
  'cmd-pan-left': ['a', 'ArrowLeft'],
  'cmd-pan-down': ['s', 'ArrowDown', 'ScrollDown'],
  'cmd-pan-right': ['d', 'ArrowRight'],
};

// Pixel distance moved by keyboard pan commands. Increase/decrease this to tune
// W/A/S/D and arrow-key panning without touching the command dispatch code.
export const VIEWER_KEYBOARD_PAN_STEP = 72;

// Pixel distance moved per scroll-wheel notch when the wheel is bound to pan.
export const VIEWER_WHEEL_PAN_STEP = 120;
export const DEFAULT_FIT_MODE = 'height-if-larger';
export const DEFAULT_SCALING_MODE = 'bicubic';

// persistence: frontend_data is merged here with normalized defaults. Preference
// flags (theme, keybinds, scroll_zoom_modifier) belong in quivit_config.json;
// last-known runtime state like scroll_zoom_latched is split into
// quivit_state.json by the backend (STATE_KEYS). See the policy in core.js.
export function mergeConfig(loaded) {
  const fd = loaded?.frontend_data && typeof loaded.frontend_data === 'object'
    ? loaded.frontend_data
    : {};

  return {
    portable_mode: !!loaded?.portable_mode,
    frontend_data: {
      ...fd,
      continue_last: fd.continue_last !== false,
      remember_last_image: fd.remember_last_image === true,
      open_first_image: fd.open_first_image === true,
      single_instance: fd.single_instance !== false,
      transparent_bg: fd.transparent_bg === true,
      start_dir: fd.start_dir || '',
      scroll_zoom_modifier: fd.scroll_zoom_modifier === 'toggle' ? 'toggle' : 'hold',
      scroll_zoom_latched: fd.scroll_zoom_latched === true,
      fit_mode: fd.fit_mode || DEFAULT_FIT_MODE,
      scaling_mode: fd.scaling_mode || DEFAULT_SCALING_MODE,
      show_hidden: fd.show_hidden === true,
      hide_chrome_on_fullscreen: fd.hide_chrome_on_fullscreen !== false,
      menu_visible: fd.menu_visible !== false,
      status_visible: fd.status_visible !== false,
      keybinds: (() => {
        const defaultClone = JSON.parse(JSON.stringify(DEFAULT_KEYBINDS));
        const userBinds = fd.keybinds || {};
        const merged = { ...defaultClone, ...userBinds };
        for (const [actionId, combo] of Object.entries(merged)) {
          merged[actionId] = Array.isArray(combo) ? combo.map(normalizeCombo) : normalizeCombo(combo);
        }
        return merged;
      })(),
    },
  };
}
