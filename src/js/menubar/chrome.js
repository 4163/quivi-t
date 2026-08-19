/**
 * chrome.js
 * Owns the menubar and statusbar visibility, persistence, and fullscreen toggles.
 */

import { Core } from '../core.js';
import { closeMenus } from '../menubar.js';

let menuBarVisible = true;
let statusBarVisible = true;
let preFullscreenState = null;

const menubarEl = document.getElementById('menubar');
const statusbarEl = document.getElementById('statusbar');

// Visibility.

export function setMenuBarVisible(visible, { persist = false } = {}) {
  menuBarVisible = !!visible;
  if (menubarEl) {
    menubarEl.classList.toggle('hidden', !menuBarVisible);
  }
  const checkmark = document.getElementById('cmd-toggle-menubar');
  if (checkmark) {
    checkmark.classList.toggle('checked', menuBarVisible);
  }
  if (!menuBarVisible) closeMenus();
  if (persist) saveChromeState();
}

export function applyStatusBarVisibility() {
  const state = Core.getState();
  if (!statusbarEl) return;
  if (state.mode === 'empty') {
    statusbarEl.classList.add('hidden');
  } else {
    statusbarEl.classList.toggle('hidden', !statusBarVisible);
  }
}

export function setStatusBarVisible(visible, { persist = false } = {}) {
  statusBarVisible = !!visible;
  applyStatusBarVisibility();
  const checkmark = document.getElementById('cmd-toggle-statusbar');
  if (checkmark) {
    checkmark.classList.toggle('checked', statusBarVisible);
  }
  if (persist) saveChromeState();
}

export function toggleMenuBar({ persist = true } = {}) {
  setMenuBarVisible(!menuBarVisible, { persist });
}

export function toggleStatusBar({ persist = true } = {}) {
  setStatusBarVisible(!statusBarVisible, { persist });
}

// Persistence.

function saveChromeState() {
  const state = Core.getState();
  if (state.config && state.config.frontend_data) {
    state.config.frontend_data.menu_visible = menuBarVisible;
    state.config.frontend_data.status_visible = statusBarVisible;
    if (window.__TAURI__) {
      Core.persistConfig({ debounceMs: 1500 });
    }
  }
}

// Fullscreen helpers.

export function snapshotPreFullscreenChrome() {
  preFullscreenState = { menuBar: menuBarVisible, statusBar: statusBarVisible };
}

export function restorePreFullscreenChrome() {
  if (!preFullscreenState) return;
  setMenuBarVisible(preFullscreenState.menuBar);
  setStatusBarVisible(preFullscreenState.statusBar);
  preFullscreenState = null;
}

export function setFullscreenChromeVisible(visible) {
  setMenuBarVisible(visible);
  setStatusBarVisible(visible);
}
