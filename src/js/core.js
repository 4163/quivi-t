/**
 * core.js — QuiviT
 *
 * State machine and application logic. No DOM access here.
 * Communicates outward exclusively via registered callbacks.
 */

// We rely on window.__TAURI__ since this is a vanilla JS setup without a bundler
const { invoke, convertFileSrc } = window.__TAURI__.core;

const SUPPORTED_IMAGES = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'apng', 'svg', 'bmp', 'ico', 'avif',
]);

const SUPPORTED_ARCHIVES = new Set(['zip', 'cbz', 'rar', 'cbr']);

// --- Internal state -----------------------------------------------------------

const _state = {
  /** @type {'empty'|'image'|'archive'} */
  mode: 'empty',

  /** Currently displayed image src (object URL or asset:// URL) */
  src: '',

  /** File name of the currently displayed image */
  filename: '',

  /** 0-based index within the current file list */
  index: 0,

  /** Flat, sorted array of file names / paths in the current scope */
  list: [],

  /** If mode === 'archive', the handle to the currently open archive */
  archiveHandle: null,

  /** UI State: Is the file list panel visible? */
  fileListVisible: true,

  /** View State: How to fit the image */
  fitMode: 'width-if-larger', 
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

// Convert unix timestamp (ms) from Rust to a short localized date string
function _formatDate(msStr) {
  if (!msStr) return '';
  const ms = parseInt(msStr, 10);
  if (isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString();
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

  setFitMode(mode) {
    _state.fitMode = mode;
    _notify();
  },

  /**
   * Navigate delta items forward or backward.
   */
  navigate(delta) {
    if (_state.list.length <= 1) return;
    const next = (_state.index + delta + _state.list.length) % _state.list.length;
    
    _revokeIfObjectURL(_state.src);
    
    _state.index = next;
    const file = _state.list[next];
    _state.filename = file.name;
    _state.src = convertFileSrc(file.path);
    
    _notify();
  },

  /**
   * Jump directly to an index.
   */
  jumpToIndex(index) {
    if (index < 0 || index >= _state.list.length || _state.list.length === 0) return;
    
    _revokeIfObjectURL(_state.src);
    
    _state.index = index;
    const file = _state.list[index];
    _state.filename = file.name;
    _state.src = convertFileSrc(file.path);
    
    _notify();
  },

  /**
   * Load a dropped File or an absolute path (via dialog).
   * 'input' can be a File object or an absolute path string.
   */
  async loadFile(input) {
    let name = '';
    let isFileObj = false;
    let pathArg = '';

    if (typeof input === 'string') {
      name = input;
      pathArg = input;
    } else if (input instanceof File) {
      name = input.name;
      // Tauri injects an internal 'path' property on dropped files if configured, 
      // but if we are dropping from an external source we should have 'path'.
      pathArg = input.path || input.name; 
      isFileObj = true;
    }

    const ext = _ext(name);

    if (SUPPORTED_ARCHIVES.has(ext)) {
      console.warn('[Core] Archive loading not yet implemented:', name);
      return;
    }

    if (!SUPPORTED_IMAGES.has(ext)) {
      console.warn('[Core] Unsupported file type:', name);
      return;
    }

    try {
      // 1. Call Rust backend to scan the directory
      const result = await invoke('read_directory', { path: pathArg });
      
      // 2. Format dates
      const files = result.files.map(f => ({
        ...f,
        date: _formatDate(f.date)
      }));

      // 3. Update state
      _revokeIfObjectURL(_state.src);
      
      _state.mode = 'image';
      _state.list = files;
      _state.index = result.initial_index;
      _state.filename = files[_state.index].name;
      _state.archiveHandle = null;

      // Ensure we use the proper local asset URL
      _state.src = convertFileSrc(files[_state.index].path);

      _notify();

    } catch (err) {
      console.error('[Core] Error loading file:', err);
    }
  }
};

export { SUPPORTED_IMAGES, SUPPORTED_ARCHIVES };
