/**
 * core.js — QuiviT
 *
 * State machine and application logic. No DOM access here.
 * Communicates outward exclusively via registered callbacks.
 */

import { DEFAULT_FIT_MODE, DEFAULT_KEYBINDS, DEFAULT_SCALING_MODE, mergeConfig } from './keybinds.js';

const { invoke, convertFileSrc } = window.__TAURI__.core;

const SUPPORTED_IMAGES = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'apng', 'svg', 'bmp', 'ico', 'avif',
]);

const SUPPORTED_ARCHIVES = new Set(['zip', 'cbz', 'rar', 'cbr']);

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

function _ext(name) {
  return name.split('.').pop().toLowerCase();
}

function _notify() {
  const snapshot = { ..._state };
  for (const fn of _listeners) fn(snapshot);
}

function _revokeIfObjectURL(src) {
  if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
}

function _formatDate(msStr) {
  if (!msStr) return '';
  const ms = parseInt(msStr, 10);
  if (isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString();
}

function _base64Encode(str) {
  // URL-safe base64 encoding
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _buildArchiveSrc(archivePath, entryName) {
  const encoded = _base64Encode(archivePath);
  const isWindows = navigator.userAgent.includes('Windows');
  const base = isWindows ? 'http://quivit.localhost' : 'quivit://localhost';
  return `${base}/archive/${encoded}/${encodeURIComponent(entryName)}`;
}

function _buildFileSrc(filePath) {
  return convertFileSrc(filePath);
}

function _isArchive(name) {
  return SUPPORTED_ARCHIVES.has(_ext(name));
}

function _isImage(name) {
  return SUPPORTED_IMAGES.has(_ext(name));
}

function _isArchiveEntry(entry) {
  return entry && !entry.is_dir && _isArchive(entry.name);
}

function _isImageEntry(entry) {
  return entry && !entry.is_dir && _isImage(entry.name);
}

function _formatEntry(entry) {
  return {
    ...entry,
    rawDate: entry.date ? parseInt(entry.date, 10) : 0,
    date: _formatDate(entry.date),
  };
}

function _buildDirectoryList(result) {
  const files = result.files.map(_formatEntry);
  if (result.parent_directory) {
    files.unshift({
      name: '..',
      path: result.parent_directory,
      ext: '',
      date: '',
      rawDate: 0,
      is_dir: true,
      is_parent: true,
    });
  }
  return files;
}

function _buildArchiveList(result) {
  const archivePath = result.archive_path;
  return [
    {
      name: '..',
      path: archivePath,
      ext: '',
      date: '',
      rawDate: 0,
      is_dir: true,
      is_parent: true,
    },
    ...result.files.map(_formatEntry),
  ];
}

function _firstImageIndex(list, preferredIndex = 0) {
  if (_isImageEntry(list[preferredIndex])) return preferredIndex;
  const next = list.findIndex(_isImageEntry);
  return next === -1 ? 0 : next;
}

function _showHidden() {
  return _state.config.frontend_data?.show_hidden === true;
}

async function _persistConfig() {
  try {
    await invoke('save_config', { config: _state.config });
  } catch (err) {
    console.error('[Core] Failed to persist config:', err);
  }
}

function _persistLastOpened(path) {
  if (_state.config.frontend_data.continue_last === false) return;
  _state.config.frontend_data.last_opened_path = path;
  _state.config.frontend_data.last_opened_dir = path;
  _persistConfig();
}

function _applyDirectoryResult(result, options = {}) {
  const files = _buildDirectoryList(result);
  const offset = result.parent_directory ? 1 : 0;
  const preferredIndex = Math.min(files.length - 1, Math.max(0, result.initial_index + offset));
  const index = options.preferInitial ? preferredIndex : _firstImageIndex(files, preferredIndex);

  _revokeIfObjectURL(_state.src);

  _state.mode = 'image';
  _state.list = files;
  _state.index = index;
  _state.directory = result.directory;
  _state.parentDirectory = result.parent_directory || '';
  _state.archivePath = '';
  _state.filename = files[index]?.name || '';
  _state.src = _isImageEntry(files[index]) ? _buildFileSrc(files[index].path) : '';
}

function _selectEntry(index, activate = false) {
  if (index < 0 || index >= _state.list.length || _state.list.length === 0) return;
  const file = _state.list[index];

  if (activate && file.is_parent) {
    Core.openParent();
    return;
  }

  if (activate && (file.is_dir || _isArchiveEntry(file))) {
    Core.loadFile(file.path);
    return;
  }

  _state.index = index;
  _state.filename = file.name;

  if (file.is_parent || file.is_dir || !_isImageEntry(file)) {
    _state.src = '';
  } else if (_state.mode === 'archive') {
    _revokeIfObjectURL(_state.src);
    _state.src = _buildArchiveSrc(_state.archivePath, file.name);
  } else {
    _revokeIfObjectURL(_state.src);
    _state.src = _buildFileSrc(file.path);
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

  toggleFileList() {
    _state.fileListVisible = !_state.fileListVisible;
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

  async openContainer(delta) {
    const currentPath = _state.mode === 'archive' ? _state.archivePath : _state.directory;
    if (!currentPath) return;

    try {
      const path = await invoke('open_sibling_container', {
        currentPath,
        delta,
        showHidden: _showHidden(),
      });
      await this.loadFile(path);
    } catch (err) {
      console.error('[Core] openContainer error:', err);
    }
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
   * Load a file or directory from an absolute path string.
   */
  async loadFile(pathStr) {
    const name = typeof pathStr === 'string'
      ? pathStr.replace(/\\/g, '/').split('/').pop()
      : pathStr.name || '';
    const path = typeof pathStr === 'string' ? pathStr : (pathStr.path || pathStr.name);
    const ext = _ext(name);

    try {
      if (SUPPORTED_ARCHIVES.has(ext)) {
        // Archive mode
        const result = await invoke('read_archive', { archivePath: path });

        const files = _buildArchiveList(result);

        _revokeIfObjectURL(_state.src);

        _state.mode = 'archive';
        _state.list = files;
        _state.index = _firstImageIndex(files, 1);
        _state.archivePath = result.archive_path;
        _state.directory = '';
        _state.parentDirectory = result.archive_path.replace(/[\\/][^\\/]*$/, '');
        _state.filename = files[_state.index]?.name || '';
        _state.src = _isImageEntry(files[_state.index]) ? _buildArchiveSrc(result.archive_path, files[_state.index].name) : '';
        _persistLastOpened(result.archive_path);

        _notify();
        return;
      }

      // Image or directory mode
      const result = await invoke('read_directory', { path, showHidden: _showHidden() });
      _applyDirectoryResult(result);
      _persistLastOpened(result.directory);

      _notify();

    } catch (err) {
      console.error('[Core] Error loading file:', err);
    }
  },

  /**
   * Sort the current file list.
   */
  sortList(col, desc) {
    if (_state.list.length === 0) return;
    
    const dirList = _state.list.filter(f => f.is_dir);
    const fileList = _state.list.filter(f => !f.is_dir);

    const sortFn = (a, b) => {
      let cmp = 0;
      if (col === 'name') {
        // Natural sort
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      } else if (col === 'ext') {
        cmp = a.ext.localeCompare(b.ext);
        if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
      } else if (col === 'date') {
        cmp = a.rawDate - b.rawDate;
        if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
      }
      return desc ? -cmp : cmp;
    };

    dirList.sort(sortFn);
    fileList.sort(sortFn);

    // Folders always on top
    _state.list = [...dirList, ...fileList];
    
    // Keep the currently viewed file selected
    const newIdx = _state.list.findIndex(f => f.name === _state.filename && _isImageEntry(f));
    if (newIdx !== -1) {
      _state.index = newIdx;
    }
    _notify();
  },

  /**
   * Open the parent directory of the current directory.
   */
  async openParent() {
    if (_state.mode === 'archive' && _state.archivePath) {
      try {
        const result = await invoke('read_directory', { path: _state.archivePath, showHidden: _showHidden() });
        _applyDirectoryResult(result, { preferInitial: true });
        _persistLastOpened(result.directory);
        _notify();
      } catch (err) {
        console.error('[Core] openParent archive error:', err);
      }
      return;
    }

    if (!_state.directory) return;
    try {
      const result = await invoke('open_parent', { currentDir: _state.directory, showHidden: _showHidden() });
      _applyDirectoryResult(result);
      _persistLastOpened(result.directory);

      _notify();
    } catch (err) {
      console.error('[Core] openParent error:', err);
    }
  },

  /**
   * Open the next or previous sibling directory.
   */
  async openSibling(delta) {
    if (!_state.directory) return;
    try {
      const result = await invoke('open_sibling', { currentDir: _state.directory, delta, showHidden: _showHidden() });
      _applyDirectoryResult(result);

      _notify();
    } catch (err) {
      console.error('[Core] openSibling error:', err);
    }
  },

  /**
   * Open a native directory picker dialog.
   */
  async openDirectoryDialog() {
    try {
      const { open } = window.__TAURI__.dialog;
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        await this.loadFile(selected);
      }
    } catch (err) {
      console.error('[Core] openDirectoryDialog error:', err);
    }
  },

  async openFileDialog() {
    try {
      const { open } = window.__TAURI__.dialog;
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Images and archives',
            extensions: [...SUPPORTED_IMAGES, ...SUPPORTED_ARCHIVES],
          },
          {
            name: 'Images',
            extensions: [...SUPPORTED_IMAGES],
          },
          {
            name: 'Archives',
            extensions: [...SUPPORTED_ARCHIVES],
          },
        ],
      });
      if (selected) {
        await this.loadFile(selected);
      }
    } catch (err) {
      console.error('[Core] openFileDialog error:', err);
    }
  },
  /**
   * Load the application configuration from Rust backend.
   */
  async loadConfig() {
    try {
      const loaded = await invoke('load_config');
      _state.config = mergeConfig(loaded);
      _state.fitMode = _state.config.frontend_data.fit_mode || DEFAULT_FIT_MODE;
      _state.scalingMode = _state.config.frontend_data.scaling_mode || DEFAULT_SCALING_MODE;
      _notify();
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
        delete _state.config.frontend_data.last_opened_dir;
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
    
    if (fd.continue_last !== false && (fd.last_opened_path || fd.last_opened_dir)) {
      startPath = fd.last_opened_path || fd.last_opened_dir;
    } else if (fd.start_dir) {
      startPath = fd.start_dir;
    }
    
    if (startPath && window.__TAURI__) {
      this.loadFile(startPath);
    }
  }
};

export { SUPPORTED_IMAGES, SUPPORTED_ARCHIVES };
