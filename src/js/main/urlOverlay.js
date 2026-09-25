/**
 * main/urlOverlay.js: modal prompt for entering gallery URLs.
 *
 * Owns #url-overlay. Handles focus management, input validation,
 * submission, Esc dismissal, and transitions out when the user
 * interacts with the file list or backdrop.
 */

let _overlay = null;
let _input = null;
let _errorEl = null;
let _focusFileList = null;
let _onSubmit = null;
let _filePanel = null;
let _Core = null;
let _lastObservedSrc = null;
let _lastObservedDirectory = null;

function _show() {
  if (!_overlay) return;
  _input.disabled = false;
  const submitBtn = _overlay.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = false;
  _overlay.classList.remove('loading');
  _input.value = '';
  _errorEl.textContent = '';
  _overlay.classList.remove('error');
  _overlay.classList.add('active');

  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(new CustomEvent('quivit-reset-held-keys'));
  }

  if (_Core) {
    const state = _Core.getState();
    _lastObservedSrc = state.src;
    _lastObservedDirectory = state.directory || state.archivePath || '';
  }

  requestAnimationFrame(() => _input.focus());
}

function _hide(opts = {}) {
  if (!_overlay || !_overlay.classList.contains('active')) return;
  _input.disabled = false;
  const submitBtn = _overlay.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = false;
  _overlay.classList.remove('active', 'error', 'loading');
  if (document.body?.classList?.contains('is-importing-url')) {
    document.body.classList.remove('is-importing-url');
    window.dispatchEvent?.(new CustomEvent('quivit-import-status', { detail: { importing: false } }));
  }
  _input.blur();

  if (opts.restoreFocus !== false && _focusFileList) {
    _focusFileList();
  }
}

function _errorText(err) {
  // Tauri IPC rejections arrive as plain strings without `.message`.
  // Prefer the real backend text over the generic fallback.
  if (typeof err === 'string' && err) return err;
  if (typeof err?.message === 'string' && err.message) return err.message;
  return 'Failed to open URL';
}

function _setError(message) {
  if (!_overlay || !_errorEl) return;
  _errorEl.textContent = message || '';
  _overlay.classList.toggle('error', Boolean(message));
}

async function _handleSubmit() {
  if (_overlay?.classList.contains('loading')) return;
  _input.blur();
  const url = _input.value.trim();
  if (!url) {
    _setError('Please enter a URL');
    return;
  }

  _setError('');

  const submitBtn = _overlay.querySelector('button[type="submit"]');
  _input.disabled = true;
  if (submitBtn) submitBtn.disabled = true;
  _overlay.classList.add('loading');
  document.body?.classList?.add('is-importing-url');
  window.dispatchEvent?.(new CustomEvent('quivit-import-status', { detail: { importing: true } }));

  try {
    if (_onSubmit) await _onSubmit(url);
    _hide({ restoreFocus: true });
  } catch (err) {
    _setError(_errorText(err));
  } finally {
    _input.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
    _overlay.classList.remove('loading');
    if (document.body?.classList?.contains('is-importing-url')) {
      document.body.classList.remove('is-importing-url');
      window.dispatchEvent?.(new CustomEvent('quivit-import-status', { detail: { importing: false } }));
    }
  }
}

export function initUrlOverlay({ overlay, filePanel, Core, focusFileList, onSubmit }) {
  _overlay = overlay;
  _filePanel = filePanel || null;
  _Core = Core || null;
  _focusFileList = focusFileList || (() => {});
  _onSubmit = onSubmit || null;
  _input = overlay.querySelector('#url-input');
  _errorEl = overlay.querySelector('.url-error');

  overlay.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    _input.blur();
    _handleSubmit();
  });

  _input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      _input.blur();
      _handleSubmit();
      return;
    }
    if (e.key !== 'Escape') {
      e.stopPropagation();
    }
  });

  _input.addEventListener('paste', () => {
    window.dispatchEvent?.(new CustomEvent('quivit-reset-held-keys'));
  });

  // Clicking overlay backdrop outside prompt dismisses the overlay.
  overlay.addEventListener('pointerdown', (e) => {
    if (_overlay?.classList.contains('loading')) return;
    if (e.target === overlay) {
      _hide({ restoreFocus: false }, 'backdrop_pointerdown');
    }
  });

  // Block mousedown and wheel so viewport pan and shortcuts do not trigger through the overlay.
  overlay.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  overlay.addEventListener('wheel', (e) => {
    e.stopPropagation();
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (_overlay?.classList.contains('loading')) return;
      e.preventDefault();
      _hide({ restoreFocus: true }, 'escape_key');
    }
  });

  const EXCLUDED_INTERACTION_SELECTOR = [
    '#panel-resize-handle',
    '.col-resizer',
    '.file-panel-actions',
    '#file-panel-bookmarks-header',
    '.file-panel-bookmarks-header',
    '#file-panel-header-top',
    '.file-panel-header-top',
    '#file-panel-header',
    '.file-panel-header',
    '.header-cell',
    '.bookmark-remove',
    '#file-panel-library-header',
    '.library-provider-header',
    '.lib-remove'
  ].join(', ');

  function _isExcludedInteraction(e) {
    if (document.body?.classList?.contains('resizing-panel') || document.body?.classList?.contains('resizing-col')) {
      return true;
    }
    return Boolean(e?.target?.closest?.(EXCLUDED_INTERACTION_SELECTOR));
  }

  // Transition out when clicking an entry in the file list.
  if (_filePanel) {
    _filePanel.addEventListener('pointerdown', (e) => {
      if (_overlay?.classList.contains('loading')) return;
      if (_isExcludedInteraction(e)) return;
      const isFileListTarget = e.target?.closest?.('#file-list, #favorites-list li, #bookmarks-list li, .library-provider-list li');
      if (isFileListTarget && _overlay?.classList.contains('active')) {
        _hide({ restoreFocus: false }, 'filepanel_pointerdown');
      }
    }, { capture: true });
  }

  // Dismiss if user navigates images or directories while overlay is open.
  if (_Core) {
    _Core.onStateChange((state) => {
      if (!_overlay?.classList.contains('active') || _overlay?.classList.contains('loading')) return;
      const currentDir = state.directory || state.archivePath || '';
      if (state.src !== _lastObservedSrc || currentDir !== _lastObservedDirectory) {
        const oldSrc = _lastObservedSrc;
        const oldDir = _lastObservedDirectory;
        _lastObservedSrc = state.src;
        _lastObservedDirectory = currentDir;
        _hide({ restoreFocus: false, oldSrc, newSrc: state.src, oldDir, newDir: currentDir }, 'core_state_change');
      }
    });
  }

  return {
    show: _show,
    hide: _hide,
    setError: _setError
  };
}
