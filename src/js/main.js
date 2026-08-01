/**
 * main.js - main window DOM wiring.
 */

import { Core } from './core.js';
import { Viewer } from './viewer.js';
import { initFilePanel, renderFilePanel } from './filePanel.js';
import { bindKeyboardShortcuts, updateMenuShortcuts } from './shortcuts.js';

const dropOverlay = document.getElementById('drop-overlay');
const viewport = document.getElementById('viewport');
const statusbar = document.getElementById('statusbar');
const statusName = document.getElementById('status-filename');
const statusIndex = document.getElementById('status-index');
const statusFit = document.getElementById('status-fit');

const filePanel = document.getElementById('file-panel');
const fileListUl = document.getElementById('file-list');
const resizeHandle = document.getElementById('panel-resize-handle');

let activeMenu = null;
let activeScaling = 'bicubic';

function closeMenus() {
  if (!activeMenu) return;
  activeMenu.classList.remove('open');
  activeMenu = null;
}

function updateScalingMenu() {
  document.querySelectorAll('[data-scaling]').forEach(item => {
    item.classList.toggle('checked', item.dataset.scaling === activeScaling);
  });
}

function setScaling(mode) {
  activeScaling = mode;
  Viewer.setScaling(mode);
  updateScalingMenu();
}

async function toggleFullscreen() {
  if (window.__TAURI__) {
    const { getCurrentWindow } = window.__TAURI__.window;
    const win = getCurrentWindow();
    win.setFullscreen(!(await win.isFullscreen()));
  } else if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

function dispatchAction(actionId) {
  const btn = document.getElementById(actionId);
  if (btn) {
    btn.click();
    return;
  }

  switch (actionId) {
    case 'cmd-rotate-ccw':
      Viewer.rotate(-90);
      break;
    case 'cmd-pan-up':
      Viewer.panBy(0, 32);
      break;
    case 'cmd-pan-left':
      Viewer.panBy(32, 0);
      break;
    case 'cmd-pan-down':
      Viewer.panBy(0, -32);
      break;
    case 'cmd-pan-right':
      Viewer.panBy(-32, 0);
      break;
    default:
      break;
  }
}

function bindMenus() {
  document.querySelectorAll('.menu-item').forEach(menu => {
    const trigger = menu.querySelector('.menu-trigger');

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

    trigger.addEventListener('mouseenter', () => {
      if (!activeMenu || activeMenu === menu) return;
      closeMenus();
      menu.classList.add('open');
      activeMenu = menu;
    });
  });

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.menu-item')) closeMenus();
  });

  document.querySelectorAll('.menu-dropdown li[role="menuitem"]').forEach(item => {
    item.addEventListener('click', closeMenus);
  });
}

function bindMenuCommands() {
  document.getElementById('cmd-open-dir').addEventListener('click', () => Core.openDirectoryDialog());
  document.getElementById('cmd-next').addEventListener('click', () => Core.navigate(1));
  document.getElementById('cmd-prev').addEventListener('click', () => Core.navigate(-1));
  document.getElementById('cmd-parent').addEventListener('click', () => Core.openParent());
  document.getElementById('cmd-zoom-in').addEventListener('click', () => Viewer.zoomCenter(1));
  document.getElementById('cmd-zoom-out').addEventListener('click', () => Viewer.zoomCenter(-1));
  document.getElementById('cmd-zoom-100').addEventListener('click', () => Viewer.setZoom(1));
  document.getElementById('cmd-fit-width').addEventListener('click', () => Core.setFitMode('width'));
  document.getElementById('cmd-fit-height').addEventListener('click', () => Core.setFitMode('height'));
  document.getElementById('cmd-fit-width-if-larger').addEventListener('click', () => Core.setFitMode('width-if-larger'));
  document.getElementById('cmd-fit-height-if-larger').addEventListener('click', () => Core.setFitMode('height-if-larger'));
  document.getElementById('cmd-scale-none').addEventListener('click', () => setScaling('none'));
  document.getElementById('cmd-scale-bicubic').addEventListener('click', () => setScaling('bicubic'));
  document.getElementById('cmd-scale-lanczos').addEventListener('click', () => setScaling('lanczos'));
  document.getElementById('cmd-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('cmd-toggle-filelist').addEventListener('click', () => Core.toggleFileList());

  document.getElementById('cmd-refresh').addEventListener('click', () => {
    const state = Core.getState();
    if (state.directory) Core.loadFile(state.directory);
  });

  document.getElementById('cmd-options').addEventListener('click', async () => {
    if (!window.__TAURI__) return;
    try {
      await window.__TAURI__.core.invoke('open_options');
    } catch (err) {
      console.error('[Options] Failed to open options window:', err);
    }
  });

  document.getElementById('cmd-quit').addEventListener('click', () => {
    if (window.__TAURI__) window.__TAURI__.core.invoke('plugin:process|exit');
    else window.close();
  });

  updateScalingMenu();
}

function bindDragDrop() {
  if (window.__TAURI__) {
    const { listen } = window.__TAURI__.event;

    listen('tauri://drag-enter', () => dropOverlay.classList.add('drag-over'));
    listen('tauri://drag-leave', () => dropOverlay.classList.remove('drag-over'));
    listen('tauri://drag-drop', (e) => {
      dropOverlay.classList.remove('drag-over');
      const paths = e.payload.paths;
      if (paths && paths.length > 0) Core.loadFile(paths[0]);
    });
    listen('config-updated', () => Core.loadConfig());
    return;
  }

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropOverlay.classList.add('drag-over');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) dropOverlay.classList.remove('drag-over');
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('drag-over');

    const file = e.dataTransfer?.files?.[0];
    if (file) Core.loadFile(file);
  });
}

Core.onStateChange((state) => {
  updateMenuShortcuts(state.config);

  if (state.mode === 'empty') {
    dropOverlay.classList.add('active');
    viewport.classList.add('empty');
    statusbar.classList.add('hidden');
    return;
  }

  dropOverlay.classList.remove('active');
  viewport.classList.remove('empty');
  statusbar.classList.remove('hidden');

  statusName.textContent = state.filename;
  statusIndex.textContent = state.list.length > 1 ? `${state.index + 1} / ${state.list.length}` : '';

  const fitDisplay = state.fitMode.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  statusFit.textContent = `Fit: ${fitDisplay}`;

  renderFilePanel(state);
});

initFilePanel({ filePanel, fileListUl, resizeHandle, Core, Viewer });
bindMenus();
bindMenuCommands();
bindDragDrop();
bindKeyboardShortcuts({ Core, dispatchAction });
Core.init();
