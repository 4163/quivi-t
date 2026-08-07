/**
 * core.js — QuiviT
 *
 * State machine and application logic. No DOM access here.
 * Communicates outward exclusively via registered callbacks.
 *
 * ── Persistence policy ──────────────────────────────────────────────────
 * Where app data lives, and which situation uses which mechanism:
 *
 * Roaming/portable files (backend save_config / load_config) — SOURCE OF TRUTH.
 *   quivit_config.json            → user PREFERENCES (theme, keybinds,
 *                                   scroll_zoom_modifier, fit/scaling mode, …)
 *   quivit_state.json             → last-known RUNTIME STATE (last_opened_path,
 *                                   last_active_image, scroll_zoom_latched)
 *   quivit_directory_sort.json    → per-directory sort prefs
 *   quivit_favorites.json         → favorites + collapsed state
 * Portable mode folds all of these into one self-contained quivit_config.json
 * beside the executable; roaming mode keeps them as separate files.
 *
 * WebView2 localStorage — NEVER the source of truth for anything that must
 * survive a restart. Allowed roles:
 *   quivit-theme / quivit-custom-css → pre-paint caches mirroring config so the
 *                                      head <script> applies theme/CSS before
 *                                      first paint (prevents flicker)
 *   options-active-tab               → session-only; cleared each app start
 *
 * Decision guide:
 *   user chose it explicitly       → quivit_config.json (frontend_data)
 *   "last-known" runtime state     → quivit_state.json (STATE_KEYS in lib.rs)
 *   only needed before first paint → localStorage cache of config
 *   ephemeral within a session     → localStorage + cleared on startup
 */

import { DEFAULT_FIT_MODE, DEFAULT_KEYBINDS, DEFAULT_SCALING_MODE, mergeConfig } from './keybinds.js';
import { FsUtils } from './fsUtils.js';

const { invoke } = window.__TAURI__.core;

// --- Internal state -----------------------------------------------------------

const _state = {
  /** @type {'empty'|'image'|'archive'} */
  mode: 'empty',

  /** Currently displayed image src (asset:// URL or quivit:// URL) */
  src: '',

  /** File name of the currently displayed image */
  filename: '',

  /** 0-based index within the current file list */
  index: 0,

  /** Flat, sorted array of file entries in the current scope */
  list: [],

  /** Current directory path (for sibling navigation) */
  directory: '',

  /** Parent directory path for the visible directory, if any */
  parentDirectory: '',

  /** If mode === 'archive', the path to the archive */
  archivePath: '',

  /** UI State: Is the file list panel visible? */
  fileListVisible: true,

  /** View State: How to fit the image */
  fitMode: DEFAULT_FIT_MODE,

  /** View State: Which image scaling mode to use */
  scalingMode: DEFAULT_SCALING_MODE,
  
  /** Options configuration */
  config: {
    portable_mode: false,
    frontend_data: {
      continue_last: true,
      start_dir: '',
      fit_mode: DEFAULT_FIT_MODE,
      scaling_mode: DEFAULT_SCALING_MODE,
      keybinds: { ...DEFAULT_KEYBINDS },
    }
  }
};

/** @type {Array<(state: typeof _state) => void>} */
const _listeners = [];

// --- Helpers ------------------------------------------------------------------

function _notify() {
  const snapshot = { ..._state };
  for (const fn of _listeners) fn(snapshot);
}

async function _persistConfig() {
  try {
    await invoke('save_config', { config: _state.config });
  } catch (err) {
    console.error('[Core] Failed to persist config:', err);
  }
}

async function _selectEntry(index, activate = false) {
  if (index === -1) {
    _state.index = -1;
    _state.filename = '';
    _state.src = '';
    _notify();
    return;
  }
  if (index < 0 || index >= _state.list.length || _state.list.length === 0) return;
  const file = _state.list[index];

  if (activate && file.is_parent) {
    FsUtils.openParent();
    return;
  }

  if (activate && (file.is_dir || FsUtils.isArchiveEntry(file))) {
    FsUtils.loadFile(file.path);
    return;
  }

  _state.index = index;
  _state.filename = file.name;

  let newSrc = '';
  if (file.is_dir || file.is_parent || FsUtils.isArchiveEntry(file) || !FsUtils.isImageEntry(file)) {
    newSrc = '';
  } else if (_state.mode === 'archive') {
    newSrc = FsUtils.buildArchiveSrc(_state.archivePath, file.name);
  } else {
    newSrc = await FsUtils.buildFileSrc(file.path);
  }

  // Prevent race condition if user navigated away while we were loading ICO frames
  if (_state.index !== index) return;

  FsUtils.revokeIfObjectURL(_state.src);
  _state.src = newSrc;

  if (_state.config?.frontend_data?.remember_last_image && _state.src !== '') {
    const container = _state.mode === 'archive' ? _state.archivePath : _state.directory;
    if (container) {
      _state.config.frontend_data.last_active_image = { container, path: file.path };
      _persistConfig();
    }
  }

  if (_state.mode === 'archive') {
    FsUtils.prefetchAhead(_state.archivePath, index, 1);
  }

  _notify();
}

// --- Public API ---------------------------------------------------------------

export const Core = {
  onStateChange(fn) {
    _listeners.push(fn);
  },

  getState() {
    return { ..._state };
  },

  persistConfig() {
    _persistConfig();
  },

  setListAndIndex(newList, newIndex) {
    _state.list = newList;
    if (newIndex !== undefined && newIndex !== -1) _state.index = newIndex;
    _notify();
  },

  setState(partial) {
    Object.assign(_state, partial);
    _notify();
  },

  toggleFileList() {
    _state.fileListVisible = !_state.fileListVisible;
    _notify();
  },

  toggleTransparentBg() {
    _state.config.frontend_data.transparent_bg = !_state.config.frontend_data.transparent_bg;
    _persistConfig();
    _notify();
  },

  setFitMode(mode, options = {}) {
    _state.fitMode = mode;
    if (options.persist) {
      _state.config.frontend_data.fit_mode = mode;
      _persistConfig();
    }
    _notify();
  },

  setScalingMode(mode, options = {}) {
    _state.scalingMode = mode;
    if (options.persist) {
      _state.config.frontend_data.scaling_mode = mode;
      _persistConfig();
    }
    _notify();
  },

  /**
   * Navigate delta items forward or backward.
   */
  navigate(delta) {
    if (_state.list.length <= 1) return;
    const next = (_state.index + delta + _state.list.length) % _state.list.length;
    _selectEntry(next);
  },

  /**
   * Jump directly to an index.
   */
  jumpToIndex(index) {
    _selectEntry(index, true);
  },

  selectIndex(index) {
    _selectEntry(index);
  },

  /**
   * Load the application configuration from Rust backend.
   */
  async loadConfig() {
    try {
      const loaded = await invoke('load_config');
      
      const oldShowHidden = _state.config?.frontend_data?.show_hidden;
      _state.config = mergeConfig(loaded);
      
      // Drop the legacy per-folder map in favor of a single last-active pair
      if (_state.config.frontend_data.last_active_images !== undefined) {
        delete _state.config.frontend_data.last_active_images;
      }
      
      _state.fitMode = _state.config.frontend_data.fit_mode || DEFAULT_FIT_MODE;
      _state.scalingMode = _state.config.frontend_data.scaling_mode || DEFAULT_SCALING_MODE;
      
      // Apply Theme
      const theme = _state.config.frontend_data.theme || 'system';
      document.documentElement.removeAttribute('data-theme');
      if (theme === 'light' || theme === 'dark') {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('quivit-theme', theme); } catch(e) {}
      } else {
        try { localStorage.removeItem('quivit-theme'); } catch(e) {}
      }
      
      // Auto-refresh if show_hidden changed
      if (oldShowHidden !== undefined && oldShowHidden !== _state.config.frontend_data.show_hidden) {
        if (_state.directory || _state.archivePath) {
          FsUtils.refresh();
        }
      }

      _notify();
      window.dispatchEvent(new CustomEvent('quivit-config-loaded'));
    } catch (err) {
      console.error('[Core] Failed to load config:', err);
    }
  },

  /**
   * Save the application configuration to Rust backend.
   */
  async saveConfig(portable_mode, frontend_data) {
    try {
      _state.config = mergeConfig({ portable_mode, frontend_data });
      if (_state.config.frontend_data.continue_last === false) {
        delete _state.config.frontend_data.last_opened_path;
      }
      _state.fitMode = _state.config.frontend_data.fit_mode || DEFAULT_FIT_MODE;
      _state.scalingMode = _state.config.frontend_data.scaling_mode || DEFAULT_SCALING_MODE;
      await invoke('save_config', { config: _state.config });
      _notify();
    } catch (err) {
      console.error('[Core] Failed to save config:', err);
    }
  },
  
  /**
   * Run initial setup (called by main.js)
   */
  async init() {
    await this.loadConfig();
    
    // Resolve startup directory
    const fd = _state.config.frontend_data || {};
    let startPath = '';
    let args = [];
    
    if (window.__TAURI__) {
      args = await invoke('get_initial_args').catch(() => []);
    }
    
    if (args.length > 1) {
      startPath = args[1];
    } else if (fd.continue_last !== false && fd.last_opened_path) {
      startPath = fd.last_opened_path;
    } else if (fd.start_dir) {
      startPath = fd.start_dir;
    } else {
      startPath = await invoke('get_default_dir').catch(() => '');
    }
    
    if (startPath && window.__TAURI__) {
      const explicitOpen = args.length > 1;
      FsUtils.loadFile(startPath, {
        restoreLastImage: !explicitOpen,
        preferInitial: explicitOpen,
      });
    }
    
    if (window.__TAURI__) {
      setTimeout(() => {
        invoke('show_window').catch(e => console.error(e));
      }, 50); // slight delay to allow first render
    }
  }
};
