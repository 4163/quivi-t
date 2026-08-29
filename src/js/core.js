/**
 * core.js: QuiviT
 *
 * State machine and application logic. No DOM access here.
 * Other modules hear about changes through registered callbacks.
 *
 * Persistence policy
 * Where app data lives, and which situation uses which mechanism:
 *
 * Roaming/portable files (backend save_config / load_config): SOURCE OF TRUTH.
 *   quivit_config.json            -> user PREFERENCES (theme, keybinds,
 *                                   scroll_zoom_modifier, fit/scaling mode, etc.)
 *   quivit_state.json             -> last-known RUNTIME STATE (last_opened_path,
 *                                   last_active_image, scroll_zoom_latched)
 *   quivit_directory_sort.json    -> per-directory sort prefs
 *   quivit_favorites.json         -> favorites + collapsed state
 * Portable mode folds all of these into one self-contained quivit_config.json
 * beside the executable; roaming mode keeps them as separate files.
 *
 * WebView2 localStorage: NEVER the source of truth for anything that must
 * survive a restart. Allowed roles:
 *   quivit-theme / quivit-custom-css -> pre-paint caches mirroring config so the
 *                                      head <script> applies theme/CSS before
 *                                      first paint (prevents flicker)
 *   options-active-tab               -> session-only; cleared each app start
 *
 * In-memory state: session-only; reset on app exit:
 *   navigationHistory                -> Container-level Back/Forward history
 *   archives LRU cache               -> ZIP/CBZ in-memory image cache and prefetch
 *   previewTheme / previewCss        -> Options window live previews (until Apply/Close)
 *
 * Decision guide:
 *   user chose it explicitly       -> quivit_config.json (frontend_data)
 *   "last-known" runtime state     -> quivit_state.json (STATE_KEYS in lib.rs)
 *   only needed before first paint -> localStorage cache of config
 *   ephemeral within a session     -> in-memory state (or cleared localStorage)
 */

import { DEFAULT_FIT_MODE, DEFAULT_KEYBINDS, DEFAULT_SCALING_MODE, mergeConfig } from './keybinds.js';
import { FsUtils } from './fsUtils.js';

const invoke = window.__TAURI__?.core?.invoke;

// Internal state.

const _animMemo = new Map();

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

  /** If mode === 'archive', the path to the archive */
  archivePath: '',

  /** If mode === 'archive', the filenames of any metadata files found */
  archiveMetadataFiles: [],

  /** True if the current image is an animated format (bypasses WebGL/Lanczos) */
  isAnimated: false,

  /** File list panel visibility. */
  fileListVisible: true,

  /** Current image fit mode. */
  fitMode: DEFAULT_FIT_MODE,

  /** Monotonic counter bumped on every setFitMode call (even same-mode) */
  fitModeGen: 0,

  /** Current image scaling mode. */
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
let _configDirty = false;
let _persistTimer = null;

// Helpers.

function _notify() {
  const snapshot = { ..._state };
  for (const fn of _listeners) fn(snapshot);
}

async function _persistConfig() {
  clearTimeout(_persistTimer);
  _persistTimer = null;
  _configDirty = false;
  try {
    await invoke('save_config', { config: _state.config });
  } catch (err) {
    console.error('[Core] Failed to persist config:', err);
  }
}

async function _flushConfig() {
  if (!_configDirty) return;
  await _persistConfig();
}

function _scheduleConfigFlush(delayMs = 1500) {
  _configDirty = true;
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(_flushConfig, delayMs);
}

async function _selectEntry(index, activate = false, clampPreview = false, direction = 1) {
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
    newSrc = clampPreview ? _state.src : '';
  } else if (_state.mode === 'archive') {
    newSrc = await FsUtils.buildArchiveEntrySrc(_state.archivePath, file.name);
  } else {
    newSrc = await FsUtils.buildFileSrc(file.path);
  }

  FsUtils.revokeIfObjectURL(_state.src);
  _state.src = newSrc;

  // Optimistic fallback while checking
  _state.isAnimated = false; 
  _notify();

  if (FsUtils.isImageEntry(file)) {
    if (file.name.toLowerCase().endsWith('.svg')) {
      _state.isAnimated = true;
      _notify();
    } else {
      const cacheKey = `${_state.mode === 'archive' ? _state.archivePath : ''}::${file.path}`;
      if (_animMemo.has(cacheKey)) {
        _state.isAnimated = _animMemo.get(cacheKey);
        _notify();
      } else {
        const pathArg = _state.mode === 'archive' ? file.name : file.path;
        const archiveArg = _state.mode === 'archive' ? _state.archivePath : null;
        Core.checkIsAnimated(pathArg, archiveArg).then(isAnim => {
          if (_state.index === index) {
            _state.isAnimated = isAnim;
            _notify();
          }
        });
      }
    }
  }

  if (_state.config?.frontend_data?.remember_last_image && _state.src !== '') {
    const container = _state.mode === 'archive' ? _state.archivePath : _state.directory;
    if (container) {
      _state.config.frontend_data.last_active_image = { container, path: file.path };
      _scheduleConfigFlush(1500);
    }
  }

  _notify();

  if (_state.mode === 'archive') {
    FsUtils.prefetchAhead(_state.archivePath, index, direction);
  }
}

// Public API.

export const Core = {
  onStateChange(fn) {
    _listeners.push(fn);
  },

  getState() {
    return { ..._state };
  },

  persistConfig(options = {}) {
    if (options.immediate) return _persistConfig();
    _scheduleConfigFlush(Number.isFinite(options.debounceMs) ? options.debounceMs : 1500);
  },

  flushConfig() {
    return _flushConfig();
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

  setFileListVisible(visible, options = {}) {
    _state.fileListVisible = !!visible;
    if (options.notify !== false) _notify();
  },

  async checkIsAnimated(pathArg, archiveArg = null) {
    const cacheKey = `${archiveArg || ''}::${pathArg}`;
    if (_animMemo.has(cacheKey)) return _animMemo.get(cacheKey);
    try {
      const isAnim = await invoke('check_is_animated', { path: pathArg, archivePath: archiveArg });
      _animMemo.set(cacheKey, isAnim);
      return isAnim;
    } catch (err) {
      console.warn('[Core] Failed to check animation header:', err);
      return false;
    }
  },

  toggleTransparentBg() {
    _state.config.frontend_data.transparent_bg = !_state.config.frontend_data.transparent_bg;
    _scheduleConfigFlush(1500);
    _notify();
  },

  setFitMode(mode, options = {}) {
    _state.fitMode = mode;
    _state.fitModeGen++;
    if (options.persist) {
      _state.config.frontend_data.fit_mode = mode;
      _scheduleConfigFlush(1500);
    }
    _notify();
  },

  setScalingMode(mode, options = {}) {
    _state.scalingMode = mode;
    if (options.persist) {
      _state.config.frontend_data.scaling_mode = mode;
      _scheduleConfigFlush(1500);
    }
    _notify();
  },

  setActiveFilter(id) {
    _state.config.frontend_data.active_filter = id;
    _scheduleConfigFlush();
    _notify();
  },

  /**
   * Navigate delta items forward or backward.
   */
  navigate(delta) {
    if (_state.list.length <= 1) return;

    let clampPreview = false;
    let firstImgIdx = FsUtils.firstImageIndex(_state.list, 0);
    let lastImgIdx = -1;
    for (let i = _state.list.length - 1; i >= 0; i--) {
      if (FsUtils.isImageEntry(_state.list[i])) {
        lastImgIdx = i;
        break;
      }
    }

    if (firstImgIdx !== -1 && firstImgIdx !== lastImgIdx) {
      // When image entries wrap around a non-image edge row, keep the previous
      // preview visible instead of flashing blank.
      const firstItemIsImage = FsUtils.isImageEntry(_state.list[_state.list[0]?.name === '..' ? 1 : 0]);
      const lastItemIsImage = FsUtils.isImageEntry(_state.list[_state.list.length - 1]);
      
      if (firstItemIsImage && lastItemIsImage) {
        if (delta > 0 && _state.index === lastImgIdx) clampPreview = true;
        if (delta < 0 && _state.index === firstImgIdx) clampPreview = true;
      }
    }

    const next = (_state.index + delta + _state.list.length) % _state.list.length;
    _selectEntry(next, false, clampPreview, Math.sign(delta) || 1);
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
   * Load app configuration from the Rust backend.
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
      

      // Refresh when show_hidden changes.
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
   * Run initial setup, called by main.js.
   */
  async init() {
    await this.loadConfig();
    
    // Pick the startup path.
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
        isStartup: true,
      });
    }
    
    if (window.__TAURI__) {
      setTimeout(() => {
        invoke('show_window').catch(e => console.error(e));
      }, 50); // Let the first render settle.
    }
  }
};
