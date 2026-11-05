/**
 * chrome.js
 * Owns the menubar and statusbar visibility, persistence, and fullscreen toggles.
 */

import { Core } from '../core.js';
import { closeMenus } from '../menubar.js';
import { Statusbar } from './statusbar.js';
import { workspaceSurface } from '../shared/workspaceHost.js';

let menuBarVisible = true;
let statusBarVisible = true;
let preFullscreenState = null;

const menubarEl = document.getElementById('menubar');
const statusbarEl = document.getElementById('statusbar');
const windowRole = workspaceSurface || 'main';

export function initChrome() {
  Core.onStateChange(syncChromeState);
  syncChromeState(Core.getState());
}

function syncChromeState(state) {
  const fd = state.config?.frontend_data || {};
  if (!preFullscreenState) {
    setMenuBarVisible(fd.window_menu_visible?.[windowRole] ?? fd.menu_visible !== false);
    statusBarVisible = fd.status_visible !== false;
  }
  applyStatusBarVisibility();
}

export function initImportActivity(importActions) {
  importActions.subscribe((activity) => {
    document.body.classList.toggle('is-importing-url', activity.importing);
    window.dispatchEvent(new CustomEvent('quivit-import-status', { detail: activity }));
    if (activity.importing) window.dispatchEvent(new CustomEvent('quivit-reset-held-keys'));
  });
}

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
  if (persist) Core.setWindowMenuVisible(windowRole, menuBarVisible);
}

export function applyStatusBarVisibility() {
  const state = Core.getState();
  if (!statusbarEl) return;
  const disabled = windowRole === 'fileList';
  statusbarEl.classList.toggle('hidden', disabled || state.mode === 'empty' || !statusBarVisible);
  const checkmark = document.getElementById('cmd-toggle-statusbar');
  checkmark?.classList.toggle('checked', !disabled && statusBarVisible);
  checkmark?.classList.toggle('muted', disabled);
  checkmark?.setAttribute('aria-disabled', String(disabled));
  Statusbar.syncSpreadIndicator(state);
  Statusbar.syncManhwaIndicator(state);
}

export function setStatusBarVisible(visible, { persist = false } = {}) {
  statusBarVisible = !!visible;
  applyStatusBarVisibility();
  if (persist && windowRole !== 'fileList') {
    Core.getState().config.frontend_data.status_visible = statusBarVisible;
    Core.persistConfig({ debounceMs: 1500 });
  }
}

export function toggleMenuBar({ persist = true } = {}) {
  setMenuBarVisible(!menuBarVisible, { persist });
}

export function toggleStatusBar({ persist = true } = {}) {
  if (windowRole === 'fileList') return;
  setStatusBarVisible(!statusBarVisible, { persist });
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
  syncChromeState(Core.getState());
}

export function setFullscreenChromeVisible(visible) {
  setMenuBarVisible(visible);
  setStatusBarVisible(visible);
}
