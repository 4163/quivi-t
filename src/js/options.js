import { mergeConfig, DEFAULT_KEYBINDS } from './keybinds.js';
import { makeListNavigable } from './keyboardNav.js';
import { initKeybindUi } from './keybindUi.js';
import { initAssociationsUi, applyAssociations } from './associationsUi.js';

const tauri = window.__TAURI__ || {};
const invoke = tauri.core?.invoke?.bind(tauri.core);
const emit = tauri.event?.emit?.bind(tauri.event);
const listen = tauri.event?.listen?.bind(tauri.event);
const open = tauri.dialog?.open?.bind(tauri.dialog);
const tauriConfirm = tauri.dialog?.confirm?.bind(tauri.dialog);

let config = mergeConfig({});
const statusEl = document.getElementById('options-status');
const configDirLabel = document.getElementById('config-dir-label');
const localDataDirLabel = document.getElementById('local-data-dir-label');
let keybindUiInstance = null;
// True once the user has previewed a theme or custom CSS. While set, config
// reloads (config-changed from the file watcher) must not revert the preview.
let previewing = false;
// Set once the native close is being carried out by this window, so the
// close-requested handler does not intercept its own re-close.
let forceClose = false;

// Emergency CSS Reset (Ctrl+Shift+Alt+C)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.altKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    previewing = false;
    localStorage.removeItem('quivit-custom-css');
    emit?.('css-preview', ''); // Immediately clear main window CSS
    if (config && config.frontend_data) {
      config.frontend_data.custom_css = "";
      if (invoke) {
        invoke('save_config', { config })
          .then(() => {
            emit?.('config-updated');
            window.location.reload();
          })
          .catch(err => {
            console.error('Failed emergency reset save:', err);
            window.location.reload();
          });
      }
    } else {
      window.location.reload();
    }
  }
  
  // Global Tab Navigation Jump (Home/End)
  if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && (e.key === 'Home' || e.key === 'End')) {
    const tabbables = Array.from(document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).visibility !== 'hidden');
    if (tabbables.length > 0) {
      if (e.key === 'Home') {
        e.preventDefault();
        tabbables[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        tabbables[tabbables.length - 1].focus();
      }
    }
  }
});

function applyTheme(theme) {
  // Apply to this (options) window
  document.documentElement.removeAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('quivit-theme', theme); } catch(e) {}
  } else {
    // 'system' — remove any stored override
    try { localStorage.removeItem('quivit-theme'); } catch(e) {}
  }
}

function applyCustomCss(cssText) {
  let styleEl = document.getElementById('custom-css');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'custom-css';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = cssText || '';
}

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
    
    // Bind data to inputs
    document.getElementById('opt-portable-mode').checked = config.portable_mode;
    document.getElementById('opt-continue-last').checked = config.frontend_data.continue_last !== false;
    document.getElementById('opt-remember-last-image').checked = config.frontend_data.remember_last_image === true;
    document.getElementById('opt-open-first-image').checked = config.frontend_data.open_first_image === true;
    document.getElementById('opt-single-instance').checked = config.frontend_data.single_instance !== false;
    document.getElementById('opt-show-hidden').checked = config.frontend_data.show_hidden === true;
    document.getElementById('opt-hide-chrome-fullscreen').checked = config.frontend_data.hide_chrome_on_fullscreen !== false;
    document.getElementById('opt-start-dir').value = config.frontend_data.start_dir || '';

    // Theme & Custom CSS
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

// --- Tab Navigation ---
function switchTab(targetId) {
  document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
  const targetContent = document.getElementById(targetId);
  const targetBtn = document.querySelector(`.tab-btn[data-target="${targetId}"]`);
  if (targetContent) targetContent.classList.add('active');
  if (targetBtn) targetBtn.classList.add('active');
  localStorage.setItem('options-active-tab', targetId);
}

document.querySelectorAll('.tab-btn').forEach((btn, index, NodeList) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.target));
});
makeListNavigable(document.querySelectorAll('.tab-btn'), { horizontal: false, vertical: true });

// Restore last active tab from this session (resets on app restart)
const _savedTab = localStorage.getItem('options-active-tab');
if (_savedTab && document.getElementById(_savedTab)) switchTab(_savedTab);

document.getElementById('btn-reset-keybinds').addEventListener('click', () => {
  config.frontend_data.keybinds = JSON.parse(JSON.stringify(DEFAULT_KEYBINDS));
  if (keybindUiInstance) keybindUiInstance.renderKeybinds();
  showStatus('Keybindings reset to defaults.');
});

// --- Browse Start Dir ---
document.getElementById('btn-browse-start').addEventListener('click', async () => {
  if (!open) {
    showStatus('Directory picker is unavailable in this window.');
    return;
  }
  const path = await open({ directory: true });
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

// --- Theme Buttons ---
let currentTheme = 'system';
document.querySelectorAll('.theme-btn').forEach((btn, index, NodeList) => {
  btn.addEventListener('click', () => {
    currentTheme = btn.dataset.theme;
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('primary', b.dataset.theme === currentTheme);
      b.classList.toggle('secondary', b.dataset.theme !== currentTheme);
    });
    applyTheme(currentTheme);
    previewing = true;
    emit?.('theme-preview', currentTheme);
  });
});
makeListNavigable(document.querySelectorAll('.theme-btn'), { horizontal: true, vertical: false });

async function closeOptionsWindow() {
  forceClose = true;
  const currentWindow = tauri.window?.getCurrentWindow?.();
  if (currentWindow) await currentWindow.close();
  else window.close();
}

async function revertPreviewChanges() {
  // Revert theme/css previews if they were not saved. Previews never mutate
  // `config`, so it still holds the last saved theme/CSS.
  previewing = false;
  const savedTheme = config?.frontend_data?.theme || 'system';
  const savedCss = config?.frontend_data?.custom_css || '';
  if (emit) {
    await Promise.all([emit('theme-preview', savedTheme), emit('css-preview', savedCss)]);
  }
  try {
    // Keep the pre-paint cache in sync so the next window open does not flash
    // the previewed theme/CSS before the config is loaded.
    if (savedTheme === 'light' || savedTheme === 'dark') {
      localStorage.setItem('quivit-theme', savedTheme);
    } else {
      localStorage.removeItem('quivit-theme');
    }
    if (savedCss) localStorage.setItem('quivit-custom-css', savedCss);
    else localStorage.removeItem('quivit-custom-css');
  } catch (e) {}
}

// Native window close (X button) must behave like the Close button: any
// unsaved theme/CSS previews are reverted before the window actually closes.
// Do NOT call event.preventDefault() here — Tauri's onCloseRequested wrapper
// awaits this handler and then destroys the window itself, so preventing the
// default and manually re-closing would leave the window stuck.
const optionsWindow = tauri.window?.getCurrentWindow?.();
if (optionsWindow?.onCloseRequested) {
  optionsWindow.onCloseRequested(async () => {
    if (forceClose || !previewing) return;
    await revertPreviewChanges();
  });
}

// --- Import / Export CSS ---
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
      await invoke('write_text_file', { path, content: css }); // We will implement this
      showStatus('CSS exported successfully.');
    } catch (err) {
      console.error('Failed to export CSS:', err);
      showStatus('Failed to export CSS.');
    }
  }
});

async function previewCss() {
  const css = document.getElementById('opt-custom-css').value;
  try { localStorage.setItem('quivit-custom-css', css); } catch(e) {}
  applyCustomCss(css);
  previewing = true;
  emit?.('css-preview', css);
  showStatus('CSS previewed locally (Click Apply to save).');
}

document.getElementById('btn-save-apply-css').addEventListener('click', previewCss);

document.getElementById('opt-custom-css').addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    previewCss();
  }
});

// --- Save ---
document.getElementById('btn-save-options').addEventListener('click', async () => {
  await applyAssociations(showStatus);
  config.portable_mode = document.getElementById('opt-portable-mode').checked;
  config.frontend_data.continue_last = document.getElementById('opt-continue-last').checked;
  config.frontend_data.remember_last_image = document.getElementById('opt-remember-last-image').checked;
  config.frontend_data.open_first_image = document.getElementById('opt-open-first-image').checked;
  config.frontend_data.single_instance = document.getElementById('opt-single-instance').checked;
  config.frontend_data.show_hidden = document.getElementById('opt-show-hidden').checked;
  config.frontend_data.hide_chrome_on_fullscreen = document.getElementById('opt-hide-chrome-fullscreen').checked;
  config.frontend_data.start_dir = document.getElementById('opt-start-dir').value;
  config.frontend_data.theme = currentTheme;
  config.frontend_data.custom_css = document.getElementById('opt-custom-css').value;
  try { localStorage.setItem('quivit-custom-css', config.frontend_data.custom_css); } catch(e) {}
  if (!config.frontend_data.continue_last) {
    delete config.frontend_data.last_opened_path;
  }
  const merged = mergeConfig(config);
  Object.assign(config, merged);
  try {
    if (!invoke) throw new Error('Tauri invoke API is unavailable.');
    await invoke('save_config', { config });
    previewing = false;
    // Tell the main window to reload config
    await emit?.('config-updated');
    const currentStatus = statusEl ? statusEl.textContent : '';
    if (currentStatus.toLowerCase().includes('failed') || currentStatus.toLowerCase().includes('error')) {
      showStatus('Options applied, but some operations failed (see above logs).');
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

init();
