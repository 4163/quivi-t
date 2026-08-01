import { mergeConfig } from './keybinds.js';

const tauri = window.__TAURI__ || {};
const invoke = tauri.core?.invoke?.bind(tauri.core);
const emit = tauri.event?.emit?.bind(tauri.event);
const open = tauri.dialog?.open?.bind(tauri.dialog);

let config = mergeConfig({});
const statusEl = document.getElementById('options-status');
const configDirLabel = document.getElementById('config-dir-label');

// Define default keybinds for rendering (so we know the labels)
const ACTIONS = [
  { id: 'cmd-next', label: 'Next Image' },
  { id: 'cmd-prev', label: 'Previous Image' },
  { id: 'cmd-parent', label: 'Open Parent Folder' },
  { id: 'cmd-refresh', label: 'Refresh Directory' },
  { id: 'cmd-options', label: 'Open Options' },
  { id: 'cmd-fullscreen', label: 'Toggle Fullscreen' },
  { id: 'cmd-toggle-filelist', label: 'Toggle File List' },
  { id: 'cmd-fit-width', label: 'Fit Width' },
  { id: 'cmd-fit-height', label: 'Fit Height' },
  { id: 'cmd-fit-width-if-larger', label: 'Fit Width If Larger' },
  { id: 'cmd-fit-height-if-larger', label: 'Fit Height If Larger' },
  { id: 'cmd-zoom-in', label: 'Zoom In' },
  { id: 'cmd-zoom-out', label: 'Zoom Out' },
  { id: 'cmd-zoom-100', label: 'Zoom 100%' },
  { id: 'cmd-rotate-ccw', label: 'Rotate Counter-clockwise' },
  { id: 'cmd-pan-up', label: 'Pan Up' },
  { id: 'cmd-pan-left', label: 'Pan Left' },
  { id: 'cmd-pan-down', label: 'Pan Down' },
  { id: 'cmd-pan-right', label: 'Pan Right' },
];

function showStatus(message) {
  if (statusEl) statusEl.textContent = message || '';
}

function bindingToDisplay(binding) {
  return Array.isArray(binding) ? binding.join(', ') : (binding || '');
}

function writeBinding(binds, actionId, value) {
  if (Array.isArray(binds[actionId])) {
    binds[actionId] = value ? [value] : [];
  } else if (value) {
    binds[actionId] = value;
  } else {
    delete binds[actionId];
  }
}

async function init() {
  try {
    if (!invoke) throw new Error('Tauri invoke API is unavailable.');
    config = mergeConfig(await invoke('load_config'));
    if (configDirLabel) configDirLabel.textContent = await invoke('get_config_dir');
    
    // Bind data to inputs
    document.getElementById('opt-portable-mode').checked = config.portable_mode;
    document.getElementById('opt-continue-last').checked = config.frontend_data.continue_last !== false;
    document.getElementById('opt-show-hidden').checked = config.frontend_data.show_hidden === true;
    document.getElementById('opt-start-dir').value = config.frontend_data.start_dir || '';
    
    renderKeybinds();
  } catch (err) {
    console.error('Failed to load config:', err);
    showStatus(`Failed to load config: ${err}`);
    renderKeybinds();
  }
}

function renderKeybinds() {
  const container = document.getElementById('keybinds-container');
  container.innerHTML = '';
  
  const binds = config.frontend_data.keybinds;
  
  ACTIONS.forEach(action => {
    const row = document.createElement('div');
    row.className = 'keybind-item';
    
    const label = document.createElement('span');
    label.className = 'keybind-name';
    label.textContent = action.label;
    
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'keybind-input';
    input.value = bindingToDisplay(binds[action.id]);
    input.readOnly = true;
    
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      
      let key = e.key;
      
      // Handle clearing
      if (key === 'Backspace' || key === 'Delete') {
        input.value = '';
        writeBinding(binds, action.id, '');
        return;
      }
      
      // Ignore bare modifiers
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return;
      
      // Format the string (e.g., Ctrl+Shift+Key)
      let combo = [];
      if (e.ctrlKey) combo.push('Ctrl');
      if (e.altKey) combo.push('Alt');
      if (e.shiftKey) combo.push('Shift');
      
      // Standardize key names
      if (key === ' ') key = 'Space';
      if (key.length === 1) key = key.toLowerCase();
      
      combo.push(key);
      const finalCombo = combo.join('+');
      
      input.value = finalCombo;
      writeBinding(binds, action.id, finalCombo);
    });
    
    row.appendChild(label);
    row.appendChild(input);
    container.appendChild(row);
  });
}

// --- Tab Navigation ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.target).classList.add('active');
  });
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

async function closeOptionsWindow() {
  const currentWindow = tauri.window?.getCurrentWindow?.();
  if (currentWindow) await currentWindow.close();
  else window.close();
}

// --- Save & Close ---
document.getElementById('btn-save-options').addEventListener('click', async () => {
  config.portable_mode = document.getElementById('opt-portable-mode').checked;
  config.frontend_data.continue_last = document.getElementById('opt-continue-last').checked;
  config.frontend_data.show_hidden = document.getElementById('opt-show-hidden').checked;
  config.frontend_data.start_dir = document.getElementById('opt-start-dir').value;
  config = mergeConfig(config);
  
  try {
    if (!invoke) throw new Error('Tauri invoke API is unavailable.');
    await invoke('save_config', { config });
    // Tell the main window to reload config
    await emit?.('config-updated');
    // Close this window
    await closeOptionsWindow();
  } catch (err) {
    console.error('Failed to save config:', err);
    showStatus(`Failed to save config: ${err}`);
  }
});

document.getElementById('btn-cancel').addEventListener('click', async () => {
  await closeOptionsWindow();
});

init();
