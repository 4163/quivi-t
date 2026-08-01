import { mergeConfig, DEFAULT_KEYBINDS } from './keybinds.js';

const tauri = window.__TAURI__ || {};
const invoke = tauri.core?.invoke?.bind(tauri.core);
const emit = tauri.event?.emit?.bind(tauri.event);
const open = tauri.dialog?.open?.bind(tauri.dialog);

let config = mergeConfig({});
const statusEl = document.getElementById('options-status');
const configDirLabel = document.getElementById('config-dir-label');

const CATEGORIES = [
  {
    name: 'Navigation',
    actions: [
      { id: 'cmd-next', label: 'Next Item' },
      { id: 'cmd-prev', label: 'Previous Item' },
      { id: 'cmd-open-next-container', label: 'Open Next Folder/Archive' },
      { id: 'cmd-open-prev-container', label: 'Open Previous Folder/Archive' },
      { id: 'cmd-parent', label: 'Open Parent Folder' },
    ]
  },
  {
    name: 'View',
    actions: [
      { id: 'cmd-fit-width', label: 'Fit Width' },
      { id: 'cmd-fit-height', label: 'Fit Height' },
      { id: 'cmd-fit-width-if-larger', label: 'Fit Width If Larger' },
      { id: 'cmd-fit-height-if-larger', label: 'Fit Height If Larger' },
      { id: 'cmd-fit-best', label: 'Auto Fit' },
      { id: 'cmd-cycle-scaling', label: 'Cycle Scaling Mode' },
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
    ]
  },
  {
    name: 'Files & Folders',
    actions: [
      { id: 'cmd-open-dir', label: 'Open Directory' },
      { id: 'cmd-open-file', label: 'Open File/Archive' },
      { id: 'cmd-refresh', label: 'Refresh Directory' },
    ]
  }
];

import { formatKeysCombo } from './shortcuts.js';

// Returns true if removing this bind from cmd-toggle-menubar is acceptable.
// Blocked only when it's the last bind AND it's uncontested (conflict-free).
// If the bind is already shared with another action it wasn't a reliable opener anyway.
function canRemoveMenubarBind(bindToRemove, currentBinds) {
  if (currentBinds.length > 1) return true;
  const binds = config.frontend_data.keybinds;
  const { comboToActions } = getConflictColors(binds);
  const isConflicted = (comboToActions[bindToRemove] || []).length > 1;
  return isConflicted;
}

let isCapturing = false;

function captureKeybind(actionId, index, reRender, element) {
  if (isCapturing) return;
  isCapturing = true;

  element.classList.add('capturing');
  element.textContent = 'Listening...';
  
  const binds = config.frontend_data.keybinds;
  let activeKeys = new Set();
  let activeButtons = new Set();
  let maxKeys = new Set();
  let maxButtons = new Set();
  let isFinalizing = false;
  
  const finish = (finalCombo) => {
    if (isFinalizing) return;
    isFinalizing = true;
    cleanup();
    
    if (finalCombo) {
      let currentBinds = binds[actionId];
      if (!Array.isArray(currentBinds)) currentBinds = currentBinds ? [currentBinds] : [];

      if (finalCombo === 'Delete') {
        const bindToRemove = currentBinds[index];
        if (actionId === 'cmd-toggle-menubar' && !canRemoveMenubarBind(bindToRemove, currentBinds)) {
          showStatus('Cannot remove the last uncontested menu bar binding!');
        } else {
          currentBinds.splice(index, 1);
        }
      } else {
        currentBinds[index] = finalCombo;
      }
      
      binds[actionId] = currentBinds;
    }
    reRender();
  };

  const cleanup = () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    setTimeout(() => { isCapturing = false; }, 100);
  };

  const updateState = () => {
    if ((activeKeys.size + activeButtons.size) > (maxKeys.size + maxButtons.size)) {
      maxKeys = new Set(activeKeys);
      maxButtons = new Set(activeButtons);
    }
    
    const maxCombo = formatKeysCombo(maxKeys, maxButtons);
    
    element.textContent = maxCombo || 'Listening...';
    
    // If no keys/buttons are held, we finish.
    if (activeKeys.size === 0 && activeButtons.size === 0 && maxCombo) {
      // Don't bind ONLY modifiers.
      const hasNonModifier = Array.from(maxKeys).some(k => !['control', 'shift', 'alt', 'meta'].includes(k)) 
        || (maxCombo.includes('+') && !maxCombo.endsWith('Ctrl') && !maxCombo.endsWith('Shift') && !maxCombo.endsWith('Alt'));
      
      finish(hasNonModifier ? maxCombo : null);
    }
  };

  const onKeyDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      finish(null); // Cancel
      return;
    }
    if (e.key === 'Delete') {
      finish('Delete');
      return;
    }
    activeKeys.add(e.key.toLowerCase());
    updateState();
  };
  
  const onKeyUp = (e) => {
    e.preventDefault();
    e.stopPropagation();
    activeKeys.delete(e.key.toLowerCase());
    updateState();
  };

  const onMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    activeButtons.add(e.button);
    updateState();
  };
  
  const onMouseUp = (e) => {
    e.preventDefault();
    e.stopPropagation();
    activeButtons.delete(e.button);
    updateState();
  };

  const onContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('contextmenu', onContextMenu, true);
}

function showStatus(message) {
  if (statusEl) statusEl.textContent = message || '';
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
    document.getElementById('opt-hide-chrome-fullscreen').checked = config.frontend_data.hide_chrome_on_fullscreen !== false;
    document.getElementById('opt-start-dir').value = config.frontend_data.start_dir || '';
    
    renderKeybinds();
  } catch (err) {
    console.error('Failed to load config:', err);
    showStatus(`Failed to load config: ${err}`);
    renderKeybinds();
  }
}

function getConflictColors(binds) {
  // Build map of combo -> [actionId, ...]
  const comboToActions = {};
  for (const [actionId, raw] of Object.entries(binds)) {
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    for (const combo of list) {
      if (!comboToActions[combo]) comboToActions[combo] = [];
      comboToActions[combo].push(actionId);
    }
  }

  // Collect combos that appear in more than one action
  const conflictCombos = Object.entries(comboToActions)
    .filter(([, ids]) => ids.length > 1)
    .map(([combo]) => combo);

  if (conflictCombos.length === 0) return { comboToActions, conflictColorMap: {} };

  // Build a list of hue "segments" that avoid the accent blue band (190-240°).
  // We split the usable hue arc into N equal slots and pick the midpoint of each.
  const SKIP_START = 190, SKIP_END = 240;
  const SKIP_SIZE = SKIP_END - SKIP_START; // 50°
  const usable = 360 - SKIP_SIZE; // 310° of usable space
  const N = conflictCombos.length;
  
  const hues = conflictCombos.map((_, i) => {
    // Even spread in [0, usable)
    const rawHue = (i / N) * usable;
    // Shift hues that fall in the blue zone forward by the skip size
    return rawHue < SKIP_START ? rawHue : rawHue + SKIP_SIZE;
  });

  const conflictColorMap = {};
  conflictCombos.forEach((combo, i) => {
    conflictColorMap[combo] = `hsl(${Math.round(hues[i])}, 80%, 45%)`;
  });

  return { comboToActions, conflictColorMap };
}

function renderKeybinds() {
  const container = document.getElementById('keybinds-container');
  container.innerHTML = '';
  
  const binds = config.frontend_data.keybinds;
  const { comboToActions, conflictColorMap } = getConflictColors(binds);
  
  CATEGORIES.forEach(category => {
    const header = document.createElement('h3');
    header.textContent = category.name;
    header.className = 'keybind-category-header';
    container.appendChild(header);

    category.actions.forEach(action => {
      const row = document.createElement('div');
      row.className = 'keybind-item';
      
      const label = document.createElement('span');
      label.className = 'keybind-name';
      label.textContent = action.label;
      
      const tagsContainer = document.createElement('div');
      tagsContainer.className = 'keybind-tags';

      const renderTags = () => {
        // Recompute conflicts since binds may have changed
        const { conflictColorMap: newColors } = getConflictColors(config.frontend_data.keybinds);
        tagsContainer.innerHTML = '';
        let currentBinds = binds[action.id];
        if (!Array.isArray(currentBinds)) {
          currentBinds = currentBinds ? [currentBinds] : [];
        }

        currentBinds.forEach((bind, idx) => {
          const tag = document.createElement('button');
          tag.className = 'keybind-tag';
          tag.title = 'Click to rebind';

          // Apply conflict color if this combo conflicts with another action
          const conflictColor = newColors[bind];
          if (conflictColor) {
            tag.style.color = conflictColor;
            tag.style.borderColor = conflictColor;
          }
          
          const textSpan = document.createElement('span');
          textSpan.textContent = bind;
          tag.appendChild(textSpan);
          
          const xBtn = document.createElement('span');
          xBtn.className = 'remove-btn';
          xBtn.textContent = '×';
          xBtn.title = 'Remove binding';
          
          xBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (action.id === 'cmd-toggle-menubar' && !canRemoveMenubarBind(bind, currentBinds)) {
              showStatus('Cannot remove the last uncontested menu bar binding!');
            } else {
              currentBinds.splice(idx, 1);
              binds[action.id] = currentBinds;
              renderKeybinds();
            }
          });
          
          tag.appendChild(xBtn);
          tag.addEventListener('click', () => captureKeybind(action.id, idx, renderKeybinds, tag));
          tagsContainer.appendChild(tag);
        });

        const addBtn = document.createElement('button');
        addBtn.className = 'keybind-tag add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add alternative bind';
        addBtn.addEventListener('click', () => captureKeybind(action.id, currentBinds.length, renderKeybinds, addBtn));
        tagsContainer.appendChild(addBtn);
      };

      renderTags();
      
      row.appendChild(label);
      row.appendChild(tagsContainer);
      container.appendChild(row);
    });
  });
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

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.target));
});

// Restore last active tab from this session (resets on app restart)
const _savedTab = localStorage.getItem('options-active-tab');
if (_savedTab && document.getElementById(_savedTab)) switchTab(_savedTab);

document.getElementById('btn-reset-keybinds').addEventListener('click', () => {
  config.frontend_data.keybinds = JSON.parse(JSON.stringify(DEFAULT_KEYBINDS));
  renderKeybinds();
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
  config.frontend_data.hide_chrome_on_fullscreen = document.getElementById('opt-hide-chrome-fullscreen').checked;
  config.frontend_data.start_dir = document.getElementById('opt-start-dir').value;
  if (!config.frontend_data.continue_last) {
    delete config.frontend_data.last_opened_path;
    delete config.frontend_data.last_opened_dir;
  }
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
