/**
 * main.js - main window DOM wiring.
 */

import { Core } from './core.js';
import { Viewer } from './viewer.js';
import { initFilePanel, renderFilePanel } from './filePanel.js';
import { VIEWER_KEYBOARD_PAN_STEP } from './keybinds.js';
import { bindKeyboardShortcuts, updateMenuShortcuts } from './shortcuts.js';

// Reset the options tab state on app startup so it defaults to General per session
localStorage.removeItem('options-active-tab');

const dropOverlay = document.getElementById('drop-overlay');
const menubar = document.getElementById('menubar');
const viewport = document.getElementById('viewport');
const statusbar = document.getElementById('statusbar');
const statusName = document.getElementById('status-filename');
const statusIndex = document.getElementById('status-index');
const statusFit = document.getElementById('status-fit');

const filePanel = document.getElementById('file-panel');
const filePanelBreadcrumb = document.getElementById('file-panel-breadcrumb');
const fileListUl = document.getElementById('file-list');
const resizeHandle = document.getElementById('panel-resize-handle');

let activeMenu = null;
let activeScaling = '';
let menuBarVisible = true;
let statusBarVisible = true; // updated from config when loaded

// Snapshot taken on entering fullscreen, restored on exit
let _preFullscreenState = null;
let _uiInitialized = false;

function saveUIState() {
  const state = Core.getState();
  if (state.config && state.config.frontend_data) {
    state.config.frontend_data.menu_visible = menuBarVisible;
    state.config.frontend_data.status_visible = statusBarVisible;
    if (window.__TAURI__) {
      window.__TAURI__.core.invoke('save_config', { config: state.config }).catch(console.error);
    }
  }
}

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
  Core.setScalingMode(mode, { persist: true });
}

async function toggleFullscreen() {
  const enteringFullscreen = window.__TAURI__
    ? !(await window.__TAURI__.window.getCurrentWindow().isFullscreen())
    : !document.fullscreenElement;

  const config = Core.getState()?.config;
  const hideChrome = config?.frontend_data?.hide_chrome_on_fullscreen !== false;

  if (enteringFullscreen) {
    // Snapshot current visibility before hiding
    _preFullscreenState = { menuBar: menuBarVisible, statusBar: statusBarVisible };
    if (hideChrome) {
      if (menuBarVisible) toggleMenuBar();
      if (statusBarVisible) toggleStatusBar();
    }
  } else {
    // Restore from snapshot if we have one
    if (_preFullscreenState) {
      if (menuBarVisible !== _preFullscreenState.menuBar) toggleMenuBar();
      if (statusBarVisible !== _preFullscreenState.statusBar) toggleStatusBar();
      _preFullscreenState = null;
    }
  }

  if (window.__TAURI__) {
    const win = window.__TAURI__.window.getCurrentWindow();
    win.setFullscreen(enteringFullscreen);
  } else if (enteringFullscreen) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

function toggleMenuBar() {
  menuBarVisible = !menuBarVisible;
  menubar.classList.toggle('hidden', !menuBarVisible);
  closeMenus();
  saveUIState();
}

function toggleStatusBar() {
  statusBarVisible = !statusBarVisible;
  // If we're in empty mode, it stays hidden regardless of the toggle, 
  // but we still persist the toggle state.
  if (Core.getState().mode !== 'empty') {
    statusbar.classList.toggle('hidden', !statusBarVisible);
  }
  saveUIState();
}

async function openGithub() {
  const url = 'https://github.com/4163/quivi-t';
  if (window.__TAURI__?.opener?.openUrl) {
    await window.__TAURI__.opener.openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
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
    case 'cmd-rotate-cw':
      Viewer.rotate(90);
      break;
    case 'cmd-flip-horizontal':
      Viewer.flipHorizontal();
      break;
    case 'cmd-flip-vertical':
      Viewer.flipVertical();
      break;
    case 'cmd-open-next-container':
      Core.openContainer(1);
      break;
    case 'cmd-open-prev-container':
      Core.openContainer(-1);
      break;
    case 'cmd-pan-up':
      Viewer.panBy(0, VIEWER_KEYBOARD_PAN_STEP);
      break;
    case 'cmd-pan-left':
      Viewer.panBy(VIEWER_KEYBOARD_PAN_STEP, 0);
      break;
    case 'cmd-pan-down':
      Viewer.panBy(0, -VIEWER_KEYBOARD_PAN_STEP);
      break;
    case 'cmd-pan-right':
      Viewer.panBy(-VIEWER_KEYBOARD_PAN_STEP, 0);
      break;
    case 'cmd-cycle-scaling': {
      const modes = ['none', 'bicubic', 'lanczos'];
      const current = Core.getState().scalingMode;
      const next = modes[(modes.indexOf(current) + 1) % modes.length];
      setScaling(next);
      break;
    }
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
  document.getElementById('cmd-open-file').addEventListener('click', () => Core.openFileDialog());
  document.getElementById('cmd-next').addEventListener('click', () => Core.navigate(1));
  document.getElementById('cmd-prev').addEventListener('click', () => Core.navigate(-1));
  document.getElementById('cmd-parent').addEventListener('click', () => Core.openParent());
  document.getElementById('cmd-zoom-in').addEventListener('click', () => Viewer.zoomCenter(1));
  document.getElementById('cmd-zoom-out').addEventListener('click', () => Viewer.zoomCenter(-1));
  document.getElementById('cmd-zoom-100').addEventListener('click', () => Viewer.setZoom(1));
  document.getElementById('cmd-fit-width').addEventListener('click', () => Core.setFitMode('width', { persist: true }));
  document.getElementById('cmd-fit-height').addEventListener('click', () => Core.setFitMode('height', { persist: true }));
  document.getElementById('cmd-fit-width-if-larger').addEventListener('click', () => Core.setFitMode('width-if-larger', { persist: true }));
  document.getElementById('cmd-fit-height-if-larger').addEventListener('click', () => Core.setFitMode('height-if-larger', { persist: true }));
  document.getElementById('cmd-fit-best').addEventListener('click', () => Core.setFitMode('window', { persist: true }));
  document.getElementById('cmd-scale-none').addEventListener('click', () => setScaling('none'));
  document.getElementById('cmd-scale-bicubic').addEventListener('click', () => setScaling('bicubic'));
  document.getElementById('cmd-scale-lanczos').addEventListener('click', () => setScaling('lanczos'));
  document.getElementById('cmd-rotate-cw').addEventListener('click', () => Viewer.rotate(90));
  document.getElementById('cmd-rotate-ccw').addEventListener('click', () => Viewer.rotate(-90));
  document.getElementById('cmd-flip-horizontal').addEventListener('click', () => Viewer.flipHorizontal());
  document.getElementById('cmd-flip-vertical').addEventListener('click', () => Viewer.flipVertical());
  document.getElementById('cmd-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('cmd-toggle-menubar').addEventListener('click', toggleMenuBar);
  document.getElementById('cmd-toggle-filelist').addEventListener('click', () => Core.toggleFileList());
  document.getElementById('cmd-toggle-statusbar').addEventListener('click', toggleStatusBar);
  document.getElementById('cmd-github').addEventListener('click', () => {
    openGithub().catch(err => console.error('[GitHub] Failed to open repository:', err));
  });

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
  if (!_uiInitialized && state.config?.frontend_data) {
    const fd = state.config.frontend_data;
    if (fd.menu_visible !== undefined) {
      menuBarVisible = fd.menu_visible;
      menubar.classList.toggle('hidden', !menuBarVisible);
    }
    if (fd.status_visible !== undefined) {
      statusBarVisible = fd.status_visible;
    }
    _uiInitialized = true;
  }

  updateMenuShortcuts(state.config);

  if (state.mode === 'empty') {
    dropOverlay.classList.add('active');
    viewport.classList.add('empty');
    statusbar.classList.add('hidden');
    return;
  }

  dropOverlay.classList.remove('active');
  viewport.classList.remove('empty');
  // Show statusbar only if the user hasn't hidden it
  if (statusBarVisible) statusbar.classList.remove('hidden');
  else statusbar.classList.add('hidden');

  statusName.textContent = state.filename;
  statusIndex.textContent = state.list.length > 1 ? `${state.index + 1} / ${state.list.length}` : '';

  const fitDisplay = state.fitMode.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  statusFit.textContent = `Fit: ${fitDisplay}`;

  if (state.scalingMode !== activeScaling) {
    activeScaling = state.scalingMode;
    Viewer.setScaling(activeScaling);
    updateScalingMenu();
  }

  renderFilePanel(state);
});

initFilePanel({ filePanel, breadcrumbEl: filePanelBreadcrumb, fileListUl, resizeHandle, Core, Viewer });
bindMenus();
bindMenuCommands();
bindDragDrop();
bindKeyboardShortcuts({ Core, dispatchAction });
Core.init();
