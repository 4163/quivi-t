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

import { DEFAULT_FIT_MODE, DEFAULT_KEYBINDS, DEFAULT_SCALING_MODE, DEFAULT_SPREAD_ENABLED, DEFAULT_SPREAD_DIRECTION, DEFAULT_SPREAD_MODE, mergeConfig } from './keybinds.js';
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

  /** Archive encryption status: null, 'password_required', or 'password_incorrect' */
  archiveEncryption: null,

  /** True if container was loaded via sibling (next/prev folder) navigation */
  isSiblingNavigation: false,

  /** True if the current image is an animated format */
  isAnimated: false,

  /** Total times to play the animation (0 = infinite). Syncs with native <img>. */
  loopCount: 0,

  /** File list panel visibility. */
  fileListVisible: true,

  /** Current image fit mode. */
  fitMode: DEFAULT_FIT_MODE,

  /** Monotonic counter bumped on every setFitMode call (even same-mode) */
  fitModeGen: 0,

  /** Current image scaling mode. */
  scalingMode: DEFAULT_SCALING_MODE,

  /** Natural dimensions and spread state of the currently loaded image */
  naturalWidth: 0,
  naturalHeight: 0,
  isSpread: false,

  /** Spread View enabled */
  spreadEnabled: DEFAULT_SPREAD_ENABLED,

  /** Spread reading direction: 'rtl' | 'ltr' */
  spreadDirection: DEFAULT_SPREAD_DIRECTION,

  /** Current reading step on a 2-page spread: 1 or 2 */
  spreadStep: 1,
  
  /** Options configuration */
  config: {
    portable_mode: false,
    frontend_data: {
      continue_last: true,
      start_dir: '',
      fit_mode: DEFAULT_FIT_MODE,
      scaling_mode: DEFAULT_SCALING_MODE,
      spread_enabled: DEFAULT_SPREAD_ENABLED,
      spread_direction: DEFAULT_SPREAD_DIRECTION,
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
  _state.spreadStep = direction < 0 ? 2 : 1;
  _state.isSpread = false;
  _state.naturalWidth = 0;
  _state.naturalHeight = 0;
  _state.isSiblingNavigation = false;

  let newSrc = '';
  if (file.is_dir || file.is_parent || FsUtils.isArchiveEntry(file) || !FsUtils.isImageEntry(file)) {
    newSrc = clampPreview ? _state.src : '';
  } else if (_state.mode === 'archive') {
    if (_state.archiveEncryption === 'password_required' || _state.archiveEncryption === 'password_incorrect') {
      newSrc = '';
    } else {
      newSrc = await FsUtils.buildArchiveEntrySrc(_state.archivePath, file.name);
      if (_state.index !== index) return;
    }
  } else {
    newSrc = await FsUtils.buildFileSrc(file.path);
    if (_state.index !== index) return;
  }

  if (_state.mode !== 'archive') {
    if (FsUtils.isArchiveEntry(file)) {
      const enc = await FsUtils.checkArchiveEncryption(file.path);
      if (_state.index !== index) return;
      if (enc === 'password_required' || enc === 'password_incorrect') {
        _state.archivePath = file.path;
        _state.archiveEncryption = enc;
        _state.filename = `Password required: ${file.name}`;
        newSrc = '';
      } else {
        _state.archivePath = '';
        _state.archiveEncryption = null;
      }
    } else {
      _state.archivePath = '';
      _state.archiveEncryption = null;
    }
  }

  FsUtils.revokeIfObjectURL(_state.src);
  _state.src = newSrc;

  let animPromise = null;
  if (FsUtils.isImageEntry(file) && _state.archiveEncryption !== 'password_required' && _state.archiveEncryption !== 'password_incorrect') {
    const pathArg = _state.mode === 'archive' ? file.name : file.path;
    const archiveArg = _state.mode === 'archive' ? _state.archivePath : null;
    const cacheKey = `${archiveArg || ''}::${pathArg}`;
    
    if (_animMemo.has(cacheKey)) {
      const cached = _animMemo.get(cacheKey);
      _state.isAnimated = cached.is_animated;
      _state.loopCount = cached.loop_count;
    } else {
      // Leave previous flags alone until checked, to prevent pipeline teardown flash
      animPromise = Core.checkIsAnimated(pathArg, archiveArg);
    }
  } else {
    _state.isAnimated = false;
    _state.loopCount = 0;
  }

  _notify();

  if (animPromise) {
    animPromise.then(animStatus => {
      if (_state.index === index && _state.src === newSrc) {
        _state.isAnimated = animStatus.is_animated;
        _state.loopCount = animStatus.loop_count;
        _notify();
      }
    });
  }

  if (_state.config?.frontend_data?.remember_last_image && _state.src !== '') {
    const container = _state.mode === 'archive' ? _state.archivePath : _state.directory;
    if (container) {
      _state.config.frontend_data.last_active_image = { container, path: file.path };
      _scheduleConfigFlush(1500);
    }
  }

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
    _state.spreadStep = 1;
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
      const animStatus = await invoke('check_is_animated', { path: pathArg, archivePath: archiveArg });
      _animMemo.set(cacheKey, animStatus);
      return animStatus;
    } catch (err) {
      console.warn('[Core] Failed to check animation header:', err);
      return { is_animated: false, loop_count: 0 };
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

  setImageDimensions(natW, natH) {
    _state.naturalWidth = natW || 0;
    _state.naturalHeight = natH || 0;
    _state.isSpread = (natW && natH) ? (natW / natH >= 1.2) : false;
    if (!_state.isSpread) {
      _state.spreadStep = 1;
    }
    _notify();
  },

  setSpreadStep(step) {
    _state.spreadStep = step === 2 ? 2 : 1;
    _notify();
  },

  setSpreadEnabled(enabled, options = {}) {
    _state.spreadEnabled = !!enabled;
    if (_state.config?.frontend_data) {
      _state.config.frontend_data.spread_enabled = _state.spreadEnabled;
    }
    if (options.persist) {
      _scheduleConfigFlush(1500);
    }
    _notify();
  },

  toggleSpreadEnabled(options = {}) {
    const current = _state.spreadEnabled ?? _state.config?.frontend_data?.spread_enabled ?? DEFAULT_SPREAD_ENABLED;
    this.setSpreadEnabled(!current, options);
  },

  setSpreadDirection(direction, options = {}) {
    const valid = direction === 'ltr' ? 'ltr' : 'rtl';
    _state.spreadDirection = valid;
    if (_state.config?.frontend_data) {
      _state.config.frontend_data.spread_direction = valid;
    }
    if (options.persist) {
      _scheduleConfigFlush(1500);
    }
    _notify();
  },

  setSpreadMode(mode, options = {}) {
    if (mode === 'off') {
      this.setSpreadEnabled(false, options);
    } else {
      this.setSpreadEnabled(true, options);
      this.setSpreadDirection(mode, options);
    }
  },

  cycleSpreadMode(options = {}) {
    if (!_state.spreadEnabled) {
      this.setSpreadEnabled(true, options);
      this.setSpreadDirection('rtl', options);
    } else if (_state.spreadDirection === 'rtl') {
      this.setSpreadDirection('ltr', options);
    } else {
      this.setSpreadEnabled(false, options);
    }
  },

  /**
   * Navigate delta items forward or backward.
   */
  navigate(delta) {
    const isSpreadActive = (_state.spreadEnabled ?? _state.config?.frontend_data?.spread_enabled ?? DEFAULT_SPREAD_ENABLED)
      && _state.isSpread
      && ['width', 'width-if-larger'].includes(_state.fitMode);

    if (isSpreadActive) {
      if (delta > 0 && _state.spreadStep === 1) {
        this.setSpreadStep(2);
        return;
      }
      if (delta < 0 && _state.spreadStep === 2) {
        this.setSpreadStep(1);
        return;
      }
    }

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
      
      const newFitMode = _state.config.frontend_data.fit_mode || DEFAULT_FIT_MODE;
      if (_state.fitMode !== newFitMode) {
        _state.fitMode = newFitMode;
        _state.fitModeGen++;
      }
      _state.scalingMode = _state.config.frontend_data.scaling_mode || DEFAULT_SCALING_MODE;
      _state.spreadEnabled = _state.config.frontend_data.spread_enabled !== false;
      _state.spreadDirection = _state.config.frontend_data.spread_direction || DEFAULT_SPREAD_DIRECTION;
      

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
