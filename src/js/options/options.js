import { mergeConfig, DEFAULT_KEYBINDS } from '../keybinds.js';
import { applyTheme, applyCustomCss } from '../shared/theme.js';
import { makeListNavigable, handleTabJump } from '../keyboardNav.js';
import { initKeybindUi } from './keybindUi.js';
import { validateKeybindSafety } from '../services/keybindDomain.js';
import { initAssociationsUi, applyAssociations } from './associationsUi.js';
import { previewing, setPreviewing, revertPreviewChanges as _revertPreviewChanges, previewTheme, previewCss, emergencyCssReset } from '../shared/configPreview.js';
import { fitContentWidth } from '../shared/windowFit.js';

const tauri = window.__TAURI__ || {};
const invoke = tauri.core?.invoke?.bind(tauri.core);
const emit = tauri.event?.emit?.bind(tauri.event);
const listen = tauri.event?.listen?.bind(tauri.event);
const open = tauri.dialog?.open?.bind(tauri.dialog);

let config = mergeConfig({});
let currentTheme = 'system';
const statusEl = document.getElementById('options-status');
const configDirLabel = document.getElementById('config-dir-label');
const localDataDirLabel = document.getElementById('local-data-dir-label');
let keybindUiInstance = null;
let forceClose = false;

// Emergency CSS reset (Ctrl+Shift+Alt+C).
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    emergencyCssReset(config);
  }
  
  handleTabJump(e);
});



function showStatus(message) {
  if (statusEl) statusEl.textContent = message || '';
}

async function refreshLiveConfigState() {
  if (!invoke) return;
  const latest = mergeConfig(await invoke('load_config'));
  const latestTheme = latest.frontend_data.theme || 'system';
  const latestCss = latest.frontend_data.custom_css || '';

  if (!previewing) {
    applyTheme(latestTheme);
    applyCustomCss(latestCss);
    try {
      if (latestCss) localStorage.setItem('quivit-custom-css', latestCss);
      else localStorage.removeItem('quivit-custom-css');
    } catch (e) {}
  }

  if (configDirLabel) configDirLabel.textContent = await invoke('get_config_dir');
  if (localDataDirLabel) localDataDirLabel.textContent = await invoke('get_local_data_dir');
}

async function init() {
  if (listen) {
    listen('config-changed', () => {
      refreshLiveConfigState().catch(err => {
        console.error('Failed to refresh live config state:', err);
      });
    });
  }
  try {
    if (!invoke) throw new Error('Tauri invoke API is unavailable.');
    config = mergeConfig(await invoke('load_config'));
    if (configDirLabel) configDirLabel.textContent = await invoke('get_config_dir');
    if (localDataDirLabel) localDataDirLabel.textContent = await invoke('get_local_data_dir');
    
    // Bind config to inputs.
    document.getElementById('opt-portable-mode').checked = config.portable_mode;
    document.getElementById('opt-continue-last').checked = config.frontend_data.continue_last !== false;
    document.getElementById('opt-remember-last-image').checked = config.frontend_data.remember_last_image === true;
    document.getElementById('opt-open-first-image').checked = config.frontend_data.open_first_image === true;
    const singleInstanceValue = config.frontend_data.pending_single_instance ?? config.frontend_data.single_instance;
    document.getElementById('opt-single-instance').checked = singleInstanceValue !== false;
    document.getElementById('opt-show-hidden').checked = config.frontend_data.show_hidden === true;
    document.getElementById('opt-hide-chrome-fullscreen').checked = config.frontend_data.hide_chrome_on_fullscreen !== false;
    document.getElementById('opt-hide-cursor-delay').value = typeof config.frontend_data.hide_cursor_delay_sec === 'number' ? config.frontend_data.hide_cursor_delay_sec : 2;
    document.getElementById('opt-keyboard-pan-step').value = config.frontend_data.keyboard_pan_step || 72;
    document.getElementById('opt-wheel-pan-step').value = config.frontend_data.wheel_pan_step || 120;
    document.getElementById('opt-start-dir').value = config.frontend_data.start_dir || '';

    // Theme and custom CSS.
    const theme = config.frontend_data.theme || 'system';
    currentTheme = theme;
    
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('primary', btn.dataset.theme === theme);
      btn.classList.toggle('secondary', btn.dataset.theme !== theme);
    });
    applyTheme(theme);
    
    const customCss = config.frontend_data.custom_css || '';
    document.getElementById('opt-custom-css').value = customCss;
    applyCustomCss(customCss);
    
    // Anime4K UI
    const anime4kVariant = config.frontend_data?.filter_options?.anime4k?.variant || 'fast';
    document.querySelectorAll('[data-anime4k-variant]').forEach(btn => {
      btn.classList.toggle('primary', btn.dataset.anime4kVariant === anime4kVariant);
      btn.classList.toggle('secondary', btn.dataset.anime4kVariant !== anime4kVariant);
    });

    keybindUiInstance = initKeybindUi('keybinds-container', config, showStatus);
    initAssociationsUi('associations-container', showStatus);
  } catch (err) {
    console.error('Failed to load config:', err);
    showStatus(`Failed to load config: ${err}`);
    if (!keybindUiInstance) {
      keybindUiInstance = initKeybindUi('keybinds-container', config, showStatus);
    }
  }
}

// Tab navigation.
function switchTab(targetId) {
  document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
  const targetContent = document.getElementById(targetId);
  const targetBtn = document.querySelector(`.tab-btn[data-target="${targetId}"]`);
  if (targetContent) targetContent.classList.add('active');
  if (targetBtn) targetBtn.classList.add('active');
  localStorage.setItem('options-active-tab', targetId);
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.target));
});
makeListNavigable(document.querySelectorAll('.tab-btn'), { horizontal: false, vertical: true });

// Restore the last active tab for this session only.
const _savedTab = localStorage.getItem('options-active-tab');
if (_savedTab && document.getElementById(_savedTab)) switchTab(_savedTab);

document.getElementById('btn-reset-keybinds').addEventListener('click', () => {
  config.frontend_data.keybinds = JSON.parse(JSON.stringify(DEFAULT_KEYBINDS));
  config.frontend_data.scroll_zoom_modifier = 'hold';
  // Latch is runtime state (quivit_state.json) tied to the modifier — clear together so Toggle starts unlatched.
  config.frontend_data.scroll_zoom_latched = false;
  if (keybindUiInstance) {
    keybindUiInstance.renderKeybinds();
    keybindUiInstance.syncScrollModeToggle?.();
  }
  showStatus('Keybindings reset to defaults.');
});

// Start directory picker.
document.getElementById('btn-browse-start').addEventListener('click', async () => {
  if (!invoke) {
    showStatus('Directory picker is unavailable in this window.');
    return;
  }
  const path = await invoke('pick_folder');
  if (path) {
    document.getElementById('opt-start-dir').value = path;
  }
});

document.getElementById('btn-open-config-dir').addEventListener('click', async () => {
  try {
    if (!invoke) throw new Error('Tauri invoke API is unavailable.');
    await invoke('open_config_dir');
  } catch (err) {
    console.error('Failed to open config directory:', err);
    showStatus(`Failed to open config directory: ${err}`);
  }
});

document.getElementById('btn-open-local-data-dir').addEventListener('click', async () => {
  try {
    if (!invoke) throw new Error('Tauri invoke API is unavailable.');
    await invoke('open_local_data_dir');
  } catch (err) {
    console.error('Failed to open local data directory:', err);
    showStatus(`Failed to open local data directory: ${err}`);
  }
});

// Theme buttons.
document.querySelectorAll('.theme-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentTheme = btn.dataset.theme;
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('primary', b.dataset.theme === currentTheme);
      b.classList.toggle('secondary', b.dataset.theme !== currentTheme);
    });
    applyTheme(currentTheme);
    previewTheme(currentTheme);
  });
});
makeListNavigable(document.querySelectorAll('.theme-btn'), { horizontal: true, vertical: false });

// Anime4K variant buttons
document.querySelectorAll('[data-anime4k-variant]').forEach(btn => {
  btn.addEventListener('click', () => {
    const variant = btn.dataset.anime4kVariant;
    if (!config.frontend_data.filter_options) config.frontend_data.filter_options = {};
    if (!config.frontend_data.filter_options.anime4k) config.frontend_data.filter_options.anime4k = {};
    config.frontend_data.filter_options.anime4k.variant = variant;

    document.querySelectorAll('[data-anime4k-variant]').forEach(b => {
      b.classList.toggle('primary', b.dataset.anime4kVariant === variant);
      b.classList.toggle('secondary', b.dataset.anime4kVariant !== variant);
    });
  });
});
makeListNavigable(document.querySelectorAll('[data-anime4k-variant]'), { horizontal: true, vertical: false });

async function closeOptionsWindow() {
  forceClose = true;
  const currentWindow = tauri.window?.getCurrentWindow?.();
  if (currentWindow) await currentWindow.close();
  else window.close();
}

async function revertPreviewChanges() {
  const savedTheme = config?.frontend_data?.theme || 'system';
  const savedCss = config?.frontend_data?.custom_css || '';
  await _revertPreviewChanges(savedTheme, savedCss);
  try {
    if (savedTheme === 'light' || savedTheme === 'dark') {
      localStorage.setItem('quivit-theme', savedTheme);
    } else {
      localStorage.removeItem('quivit-theme');
    }
    if (savedCss) localStorage.setItem('quivit-custom-css', savedCss);
    else localStorage.removeItem('quivit-custom-css');
  } catch (e) {}
}

const optionsWindow = tauri.window?.getCurrentWindow?.();
if (optionsWindow?.onCloseRequested) {
  optionsWindow.onCloseRequested(async () => {
    if (forceClose || !previewing) return;
    await revertPreviewChanges();
  });
}

// Import and export CSS.
document.getElementById('btn-import-css').addEventListener('click', async () => {
  if (!open) return;
  const path = await open({
    multiple: false,
    filters: [{ name: 'CSS/Text Files', extensions: ['css', 'txt'] }]
  });
  if (path) {
    try {
      const content = await invoke('read_text_file', { path });
      document.getElementById('opt-custom-css').value = content;
      showStatus('CSS imported successfully.');
    } catch (err) {
      console.error('Failed to import CSS:', err);
      showStatus('Failed to import CSS.');
    }
  }
});

document.getElementById('btn-export-css').addEventListener('click', async () => {
  if (!tauri.dialog?.save) return;
  const css = document.getElementById('opt-custom-css').value;
  const path = await tauri.dialog.save({
    defaultPath: 'quivit-theme.css',
    filters: [{ name: 'CSS/Text Files', extensions: ['css', 'txt'] }]
  });
  if (path) {
    try {
      await invoke('write_text_file', { path, content: css });
      showStatus('CSS exported successfully.');
    } catch (err) {
      console.error('Failed to export CSS:', err);
      showStatus('Failed to export CSS.');
    }
  }
});

async function localPreviewCss() {
  const css = document.getElementById('opt-custom-css').value;
  try { localStorage.setItem('quivit-custom-css', css); } catch(e) {}
  applyCustomCss(css);
  previewCss(css);
  showStatus('CSS previewed locally. Click Apply to save.');
}

document.getElementById('btn-save-apply-css').addEventListener('click', localPreviewCss);

document.getElementById('opt-custom-css').addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    localPreviewCss();
  }
});

// Save.
function buildConfigFromForm(baseConfig) {
  const newConfig = { ...baseConfig };
  newConfig.portable_mode = document.getElementById('opt-portable-mode').checked;
  newConfig.frontend_data.continue_last = document.getElementById('opt-continue-last').checked;
  newConfig.frontend_data.remember_last_image = document.getElementById('opt-remember-last-image').checked;
  newConfig.frontend_data.open_first_image = document.getElementById('opt-open-first-image').checked;
  newConfig.frontend_data.pending_single_instance = document.getElementById('opt-single-instance').checked;
  newConfig.frontend_data.show_hidden = document.getElementById('opt-show-hidden').checked;
  newConfig.frontend_data.hide_chrome_on_fullscreen = document.getElementById('opt-hide-chrome-fullscreen').checked;
  const hideCursorVal = parseFloat(document.getElementById('opt-hide-cursor-delay').value);
  newConfig.frontend_data.hide_cursor_delay_sec = Number.isFinite(hideCursorVal) && hideCursorVal >= 0 ? hideCursorVal : 0;
  newConfig.frontend_data.keyboard_pan_step = parseInt(document.getElementById('opt-keyboard-pan-step').value, 10);
  newConfig.frontend_data.wheel_pan_step = parseInt(document.getElementById('opt-wheel-pan-step').value, 10);
  newConfig.frontend_data.start_dir = document.getElementById('opt-start-dir').value;
  // Wheel Behaviour (Keys tab) is owned by keybindUi.js and mutated directly on `config`.
  // Preserve the current value through the shallow copy so Save persists the toggle.
  newConfig.frontend_data.scroll_zoom_modifier = baseConfig.frontend_data.scroll_zoom_modifier === 'toggle' ? 'toggle' : 'hold';
  newConfig.frontend_data.theme = currentTheme;
  newConfig.frontend_data.custom_css = document.getElementById('opt-custom-css').value;
  // Spread View settings are controlled via the View menu; preserve them across Options saves.
  newConfig.frontend_data.spread_enabled = baseConfig.frontend_data?.spread_enabled ?? true;
  newConfig.frontend_data.spread_direction = baseConfig.frontend_data?.spread_direction || 'rtl';
  newConfig.frontend_data.spread_mode = newConfig.frontend_data.spread_enabled ? newConfig.frontend_data.spread_direction : 'off';
  // Preserve filter options which are mutated in memory directly.
  newConfig.frontend_data.filter_options = JSON.parse(JSON.stringify(baseConfig.frontend_data.filter_options || {}));
  
  if (!newConfig.frontend_data.continue_last) {
    delete newConfig.frontend_data.last_opened_path;
  }
  return newConfig;
}

document.getElementById('btn-save-options').addEventListener('click', async () => {
  const keybindSafety = validateKeybindSafety(config);
  if (!keybindSafety.ok) {
    switchTab('tab-keys');
    showStatus(keybindSafety.message);
    return;
  }
  await applyAssociations(showStatus);
  
  const formConfig = buildConfigFromForm(config);
  try { localStorage.setItem('quivit-custom-css', formConfig.frontend_data.custom_css); } catch(e) {}
  
  const merged = mergeConfig(formConfig);
  Object.assign(config, merged);
  
  try {
    if (!invoke) throw new Error('Tauri invoke API is unavailable.');
    await invoke('save_config', { config });
    setPreviewing(false);
    await emit?.('config-updated');
    
    const currentStatus = statusEl ? statusEl.textContent : '';
    if (currentStatus.toLowerCase().includes('failed') || currentStatus.toLowerCase().includes('error')) {
      showStatus('Options applied, but some operations failed. Check the logs above.');
    } else {
      showStatus('Options applied successfully.');
    }
  } catch (err) {
    console.error('Failed to save config:', err);
    showStatus(`Failed to save config: ${err}`);
  }
});

document.getElementById('btn-cancel').addEventListener('click', async () => {
  await revertPreviewChanges();
  await closeOptionsWindow();
});

let windowShown = false;
function showOptionsWindow() {
  if (windowShown || !tauri.window?.getCurrentWindow) return;
  windowShown = true;
  tauri.window.getCurrentWindow().show().catch(() => {});
}

init()
  .then(() => fitContentWidth().then(showOptionsWindow))
  .catch(() => showOptionsWindow());
