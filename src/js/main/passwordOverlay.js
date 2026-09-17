/**
 * main/passwordOverlay.js: password prompt for encrypted archives.
 *
 * Owns #password-overlay. Listens for 'quivit-password-required'
 * events (dispatched by fsUtils) and self-hides when the archive
 * loads successfully or the user navigates away.
 */

let _overlay = null;
let _input = null;
let _errorEl = null;
let _FsUtils = null;
let _Core = null;

let _lockedArchivePath = '';
let _focusFileList = null;
let _isFileListFocused = null;

function _show(archivePath, encryption, shouldFocus = true) {
  _lockedArchivePath = archivePath;
  _input.value = '';
  _errorEl.textContent = '';
  _overlay.classList.remove('error');
  _overlay.classList.add('active');

  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(new CustomEvent('quivit-reset-held-keys'));
  }

  if (encryption === 'password_incorrect') {
    _errorEl.textContent = 'Incorrect password';
    _overlay.classList.add('error');
  }

  if (shouldFocus) {
    requestAnimationFrame(() => _input.focus());
  }
}

function _hide() {
  _overlay.classList.remove('active', 'error');
  _lockedArchivePath = '';
  _input.value = '';
  _errorEl.textContent = '';
}

async function _submit() {
  const password = _input.value;
  if (!password || !_lockedArchivePath) return;

  _errorEl.textContent = '';
  _overlay.classList.remove('error');

  _FsUtils.loadArchive(_lockedArchivePath, '', { password });
}

export function initPasswordOverlay({ overlay, Core, FsUtils, focusFileList, isFileListFocused }) {
  _overlay = overlay;
  _Core = Core;
  _FsUtils = FsUtils;
  _focusFileList = focusFileList || (() => {});
  _isFileListFocused = isFileListFocused || (() => false);
  _input = overlay.querySelector('#password-input');
  _errorEl = overlay.querySelector('.password-error');

  overlay.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    _submit();
  });

  _input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') {
      e.stopPropagation();
    }
  });

  _input.addEventListener('paste', () => {
    window.dispatchEvent?.(new CustomEvent('quivit-reset-held-keys'));
  });

  // Block mousedown so viewport pan doesn't start through the overlay.
  overlay.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) {
      const state = _Core.getState();
      if (state.mode !== 'archive') {
        _Core.selectIndex(-1);
      }
    }
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      const state = _Core.getState();
      if (state.mode === 'archive') {
        _FsUtils.openParent();
      } else {
        _Core.selectIndex(-1);
        _focusFileList();
      }
    }
  });

  Core.onStateChange((state) => {
    const enc = state.archiveEncryption;
    const isLocked = enc === 'password_required' || enc === 'password_incorrect';

    if (isLocked && state.archivePath && (state.mode === 'archive' || state.index !== -1)) {
      if (!_overlay.classList.contains('active') || _lockedArchivePath !== state.archivePath || enc === 'password_incorrect') {
        const isFocused = _isFileListFocused();
        const shouldFocus = (state.mode === 'archive' && !state.isSiblingNavigation) || (!isFocused && enc === 'password_incorrect');
        _show(state.archivePath, enc, shouldFocus);
      }
    } else {
      if (_overlay.classList.contains('active')) {
        _hide();
      }
    }
  });
}
