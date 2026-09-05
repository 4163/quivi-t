/**
 * keybinds.js: QuiviT
 * Single source of truth for default keybindings, shared by core.js
 * (main window) and options.js (options window).
 */

import { normalizeCombo, normalizeList } from './services/keyCombo.js';
import { activeFilterId, normalizeFilterOptions } from './services/registry.js';

import { DEFAULT_KEYBINDS as REGISTRY_DEFAULTS } from './services/actions.js';

export const DEFAULT_KEYBINDS = REGISTRY_DEFAULTS;

// Pixel distance moved by keyboard pan commands (W/A/S/D and arrow keys).
// Default: 72px. Configurable via Options > Interface.
export const DEFAULT_KEYBOARD_PAN_STEP = 72;

// Pixel distance moved per scroll-wheel notch when the wheel is bound to pan.
// Default: 120px. Configurable via Options > Interface.
export const DEFAULT_WHEEL_PAN_STEP = 120;
export const DEFAULT_HIDE_CURSOR_DELAY_SEC = 2;

export const DEFAULT_FIT_MODE = 'height-if-larger';
export const DEFAULT_SCALING_MODE = 'bilinear';
export const DEFAULT_SPREAD_ENABLED = false;
export const DEFAULT_SPREAD_DIRECTION = 'rtl';
export const DEFAULT_SPREAD_MODE = 'off';


// persistence: frontend_data is merged here with normalized defaults. Preference
// flags (theme, keybinds, scroll_zoom_modifier) belong in quivit_config.json;
// last-known runtime state like scroll_zoom_latched is split into
// quivit_state.json by the backend (STATE_KEYS). See the policy in core.js.
export function mergeConfig(loaded) {
  const fd = loaded?.frontend_data && typeof loaded.frontend_data === 'object'
    ? loaded.frontend_data
    : {};
  const fdBase = { ...fd };
  delete fdBase.keyboard_pan_step;
  delete fdBase.wheel_pan_step;
  delete fdBase.hide_cursor_delay_sec;

  const result = {
    portable_mode: !!loaded?.portable_mode,
    hidden: loaded?.hidden === true, // Preserve hidden field (config-file-only)
    frontend_data: {
      ...fdBase,
      continue_last: fd.continue_last !== false,
      remember_last_image: fd.remember_last_image === true,
      open_first_image: fd.open_first_image === true,
      single_instance: fd.single_instance !== false,
      transparent_bg: fd.transparent_bg === true,
      start_dir: fd.start_dir || '',
      theme: fd.theme || 'system', // Explicitly preserve theme
      custom_css: fd.custom_css || '', // Explicitly preserve custom CSS
      scroll_zoom_modifier: fd.scroll_zoom_modifier === 'toggle' ? 'toggle' : 'hold',
      scroll_zoom_latched: fd.scroll_zoom_latched === true,
      fit_mode: fd.fit_mode || DEFAULT_FIT_MODE,
      scaling_mode: fd.scaling_mode || DEFAULT_SCALING_MODE,
      spread_enabled: fd.spread_enabled !== undefined
        ? fd.spread_enabled === true
        : (fd.spread_mode !== undefined ? fd.spread_mode !== 'off' : DEFAULT_SPREAD_ENABLED),
      spread_direction: fd.spread_direction === 'ltr' || fd.spread_mode === 'ltr' ? 'ltr' : DEFAULT_SPREAD_DIRECTION,
      keyboard_pan_step: typeof fd.keyboard_pan_step === 'number' ? fd.keyboard_pan_step : DEFAULT_KEYBOARD_PAN_STEP,
      wheel_pan_step: typeof fd.wheel_pan_step === 'number' ? fd.wheel_pan_step : DEFAULT_WHEEL_PAN_STEP,
      hide_cursor_delay_sec: typeof fd.hide_cursor_delay_sec === 'number' ? fd.hide_cursor_delay_sec : DEFAULT_HIDE_CURSOR_DELAY_SEC,
      show_hidden: fd.show_hidden === true,
      hide_chrome_on_fullscreen: fd.hide_chrome_on_fullscreen !== false,
      menu_visible: fd.menu_visible !== false,
      status_visible: fd.status_visible !== false,
      active_filter: activeFilterId(fd),
      filter_options: normalizeFilterOptions(fd.filter_options),
      keybinds: (() => {
        const defaultClone = JSON.parse(JSON.stringify(DEFAULT_KEYBINDS));
        const userBinds = fd.keybinds || {};
        const merged = { ...defaultClone, ...userBinds };
        for (const [actionId, combo] of Object.entries(merged)) {
          merged[actionId] = normalizeList(combo).map(normalizeCombo);
        }
        const fullscreenExitHold = merged['cmd-exit-fullscreen-hold'];
        if (!fullscreenExitHold.includes('Escape')) fullscreenExitHold.push('Escape');
        merged['cmd-exit-fullscreen-hold'] = fullscreenExitHold;
        return merged;
      })(),
    },
  };

  return result;
}
