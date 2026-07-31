/**
 * core.js — QuiviT
 *
 * State machine and application logic. No DOM access here.
 * Communicates outward exclusively via registered callbacks.
 *
 * Exported API surface:
 *   Core.onStateChange(fn)   — subscribe to state updates
 *   Core.loadFile(file)      — load a File object (image or archive)
 *   Core.navigate(delta)     — navigate by +1 / -1 through the file list
 *   Core.getState()          — snapshot of current state
 */

const SUPPORTED_IMAGES = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'apng', 'svg', 'bmp', 'ico', 'avif',
]);

const SUPPORTED_ARCHIVES = new Set(['zip', 'cbz']);

// --- Internal state -----------------------------------------------------------

const _state = {
  /** @type {'empty'|'image'|'archive'} */
  mode: 'empty',

  /** Currently displayed image src (object URL or data URL) */
  src: '',

  /** File name of the currently displayed image */
  filename: '',

  /** 0-based index within the current file list */
  index: 0,

  /** Flat, sorted array of file names / paths in the current scope */
  list: [],

  /** If mode === 'archive', the handle to the currently open archive */
  archiveHandle: null,
};

/** @type {Array<(state: typeof _state) => void>} */
const _listeners = [];

// --- Helpers ------------------------------------------------------------------

function _ext(name) {
  return name.split('.').pop().toLowerCase();
}

function _isImage(name) {
  return SUPPORTED_IMAGES.has(_ext(name));
}

function _naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function _notify() {
  const snapshot = { ..._state };
  for (const fn of _listeners) fn(snapshot);
}

function _revokeIfObjectURL(src) {
  if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
}

// --- Public API ---------------------------------------------------------------

export const Core = {

  /** Register a callback that fires whenever state changes. */
  onStateChange(fn) {
    _listeners.push(fn);
  },

  /** Snapshot of the current state (read-only copy). */
  getState() {
    return { ..._state };
  },

  /**
   * Load a File object (either an image or a ZIP/CBZ archive).
   * When loading an image, the sibling list from the same directory
   * is populated from the FileSystemDirectoryEntry if available (Phase 2).
   * For Phase 1 we just load the single file and notify.
   *
   * @param {File} file
   */
  async loadFile(file) {
    const ext = _ext(file.name);

    if (SUPPORTED_IMAGES.has(ext)) {
      _revokeIfObjectURL(_state.src);

      _state.mode = 'image';
      _state.filename = file.name;
      _state.src = URL.createObjectURL(file);
      _state.list = [file.name];
      _state.index = 0;
      _state.archiveHandle = null;

      _notify();
      return;
    }

    if (SUPPORTED_ARCHIVES.has(ext)) {
      // Archive support stubbed here — implemented in Phase 4
      console.warn('[Core] Archive loading not yet implemented:', file.name);
      return;
    }

    console.warn('[Core] Unsupported file type:', file.name);
  },

  /**
   * Navigate to the next (+1) or previous (-1) file in the list.
   * Wraps around at boundaries.
   *
   * @param {number} delta  +1 or -1
   */
  navigate(delta) {
    if (_state.list.length <= 1) return;

    const next = (_state.index + delta + _state.list.length) % _state.list.length;
    _state.index = next;
    _state.filename = _state.list[next];

    // In Phase 2 this will fetch the actual next file from the FS.
    // For now, navigation only has one file loaded, so nothing changes visually.
    _notify();
  },
};

// Re-export supported type sets so other modules can reference them
export { SUPPORTED_IMAGES, SUPPORTED_ARCHIVES };
