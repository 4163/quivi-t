/**
 * main.js — QuiviT
 *
 * DOM bindings ONLY. Handles:
 *   - Menubar interactions
 *   - File list rendering and resizing
 *   - Drag-and-drop events
 *   - Keyboard navigation
 *   - Statusbar updates
 */

import { Core } from './core.js';
import { Viewer } from './viewer.js';

// --- DOM refs -----------------------------------------------------------------
const dropOverlay  = document.getElementById('drop-overlay');
const viewport     = document.getElementById('viewport');
const statusbar    = document.getElementById('statusbar');
const statusName   = document.getElementById('status-filename');
const statusIndex  = document.getElementById('status-index');
const statusFit    = document.getElementById('status-fit');

const filePanel    = document.getElementById('file-panel');
const fileListUl   = document.getElementById('file-list');
const resizeHandle = document.getElementById('panel-resize-handle');

// --- Menubar logic ------------------------------------------------------------
const menus = document.querySelectorAll('.menu-item');
let activeMenu = null;

function closeMenus() {
  if (activeMenu) {
    activeMenu.classList.remove('open');
    activeMenu = null;
  }
}

menus.forEach(menu => {
  const trigger = menu.querySelector('.menu-trigger');
  
  // Click to toggle
  trigger.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (activeMenu === menu) {
      closeMenus();
    } else {
      closeMenus();
      menu.classList.add('open');
      activeMenu = menu;
    }
  });

  // Hover to switch active menu
  trigger.addEventListener('mouseenter', () => {
    if (activeMenu && activeMenu !== menu) {
      closeMenus();
      menu.classList.add('open');
      activeMenu = menu;
    }
  });
});

document.addEventListener('mousedown', closeMenus);

// --- Menu commands ------------------------------------------------------------

document.getElementById('cmd-quit').addEventListener('click', () => {
  if (window.__TAURI__) window.__TAURI__.core.invoke('plugin:process|exit');
  else window.close();
});

document.getElementById('cmd-next').addEventListener('click', () => Core.navigate(1));
document.getElementById('cmd-prev').addEventListener('click', () => Core.navigate(-1));

document.getElementById('cmd-zoom-in').addEventListener('click', () => Viewer.zoomCenter(1));
document.getElementById('cmd-zoom-out').addEventListener('click', () => Viewer.zoomCenter(-1));
document.getElementById('cmd-zoom-100').addEventListener('click', () => Viewer.setZoom(1));

document.getElementById('cmd-fit-width').addEventListener('click', () => Core.setFitMode('width'));
document.getElementById('cmd-fit-height').addEventListener('click', () => Core.setFitMode('height'));

document.getElementById('cmd-fullscreen').addEventListener('click', async () => {
  if (window.__TAURI__) {
    const { getCurrentWindow } = window.__TAURI__.window;
    const win = getCurrentWindow();
    win.setFullscreen(!(await win.isFullscreen()));
  } else {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
});

document.getElementById('cmd-toggle-filelist').addEventListener('click', () => {
  Core.toggleFileList();
});

// --- State subscription -------------------------------------------------------

Core.onStateChange((state) => {
  // 1. Visibilities
  if (state.mode === 'empty') {
    dropOverlay.classList.add('active');
    viewport.classList.add('empty');
    statusbar.classList.add('hidden');
    return;
  }

  dropOverlay.classList.remove('active');
  viewport.classList.remove('empty');
  statusbar.classList.remove('hidden');

  // 2. Status bar updates
  statusName.textContent = state.filename;
  if (state.list.length > 1) {
    statusIndex.textContent = `${state.index + 1} / ${state.list.length}`;
  } else {
    statusIndex.textContent = '';
  }
  
  // Format the fit mode for display
  const fitDisplay = state.fitMode.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  statusFit.textContent = `Fit: ${fitDisplay}`;

  // 3. File list panel
  if (state.fileListVisible) {
    filePanel.classList.remove('hidden');
  } else {
    filePanel.classList.add('hidden');
  }

  // Render the file list (re-render only if list changed, for now just simple re-render)
  fileListUl.innerHTML = '';
  state.list.forEach((item, i) => {
    const li = document.createElement('li');
    if (i === state.index) li.classList.add('selected');
    
    li.innerHTML = `
      <span class="item-name">${item.name}</span>
      <span class="item-ext">${item.ext}</span>
      <span class="item-date">${item.date}</span>
    `;
    
    li.addEventListener('dblclick', () => {
      if (i !== state.index) Core.jumpToIndex(i);
    });
    
    fileListUl.appendChild(li);
    
    if (i === state.index) {
      li.scrollIntoView({ block: 'nearest' });
    }
  });
});

// --- File panel resizing ------------------------------------------------------

let isResizing = false;
resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizeHandle.classList.add('dragging');
  document.body.style.cursor = 'ew-resize';
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  // Calculate new width (mouse X is relative to the window, panel is on the left)
  let newWidth = e.clientX;
  if (newWidth < 120) newWidth = 120; // min-width
  if (newWidth > 480) newWidth = 480; // max-width
  filePanel.style.width = `${newWidth}px`;
  // Force viewer to recalculate fit if needed
  Viewer.applyFitMode();
});

window.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
  }
});

// --- Drag-and-drop ------------------------------------------------------------

if (window.__TAURI__) {
  const { listen } = window.__TAURI__.event;
  
  // In Tauri v2, the drag drop events are emitted on the window
  listen('tauri://drag-enter', () => {
    dropOverlay.classList.add('drag-over');
  });
  
  listen('tauri://drag-leave', () => {
    dropOverlay.classList.remove('drag-over');
  });

  listen('tauri://drag-drop', (e) => {
    dropOverlay.classList.remove('drag-over');
    const paths = e.payload.paths; // Array of absolute paths
    if (paths && paths.length > 0) {
      Core.loadFile(paths[0]);
    }
  });
} else {
  // Fallback for browser testing (mocking)
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropOverlay.classList.add('drag-over');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      dropOverlay.classList.remove('drag-over');
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('drag-over');

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;

    Core.loadFile(file);
  });
}

// --- Keyboard navigation ------------------------------------------------------

window.addEventListener('keydown', (e) => {
  // Prevent default scrolling for arrows
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
    e.preventDefault();
  }

  switch (e.key) {
    case 'ArrowDown':
    case 'PageDown':
      Core.navigate(+1);
      break;
    case 'ArrowUp':
    case 'PageUp':
      Core.navigate(-1);
      break;
    // Shortcuts
    case '2': Core.toggleFileList(); break;
    case 'e': case 'E': Core.setFitMode('width'); break;
    case 'r': case 'R': Core.setFitMode('height'); break;
    case 'c': case 'C': Viewer.zoomCenter(1); break;
    case 'z': case 'Z': Viewer.zoomCenter(-1); break;
    case 'x': case 'X': Viewer.setZoom(1); break;
  }
});
