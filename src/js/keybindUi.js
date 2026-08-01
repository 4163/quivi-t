import { formatKeysCombo } from './shortcuts.js';

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
  },
  {
    name: 'File Operations',
    actions: [
      { id: 'cmd-open-explorer', label: 'Reveal in File Explorer' },
      { id: 'cmd-open-folder', label: 'Open Folder in Explorer' },
    ]
  }
];

export function initKeybindUi(containerId, config, showStatus) {
  let isCapturing = false;

  function getConflictColors(binds) {
    const comboToActions = {};
    for (const [actionId, raw] of Object.entries(binds)) {
      const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
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
  
  function canRemoveMenubarBind(bindToRemove, currentBinds) {
    if (currentBinds.length > 1) return true;
    const binds = config.frontend_data.keybinds;
    const { comboToActions } = getConflictColors(binds);
    const isConflicted = (comboToActions[bindToRemove] || []).length > 1;
    return isConflicted;
  }

  function captureKeybind(actionId, index, element) {
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
      renderKeybinds();
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
      
      if (activeKeys.size === 0 && activeButtons.size === 0 && maxCombo) {
        const hasNonModifier = Array.from(maxKeys).some(k => !['control', 'shift', 'alt', 'meta'].includes(k)) 
          || (maxCombo.includes('+') && !maxCombo.endsWith('Ctrl') && !maxCombo.endsWith('Shift') && !maxCombo.endsWith('Alt'));
        
        finish(hasNonModifier ? maxCombo : null);
      }
    };
  
    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        finish(null);
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

  function renderKeybinds() {
    const container = document.getElementById(containerId);
    if (!container) return;
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
            tag.addEventListener('click', () => captureKeybind(action.id, idx, tag));
            tagsContainer.appendChild(tag);
          });
  
          const addBtn = document.createElement('button');
          addBtn.className = 'keybind-tag add-btn';
          addBtn.textContent = '+';
          addBtn.title = 'Add alternative bind';
          addBtn.addEventListener('click', () => captureKeybind(action.id, currentBinds.length, addBtn));
          tagsContainer.appendChild(addBtn);
        };
  
        renderTags();
        row.appendChild(label);
        row.appendChild(tagsContainer);
        container.appendChild(row);
      });
    });
  }

  // Initial render
  renderKeybinds();
  
  // Return the render function in case it needs to be called externally
  return {
    renderKeybinds
  };
}
