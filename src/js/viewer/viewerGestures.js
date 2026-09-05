import { Core } from '../core.js';
import { activeKeys } from '../shortcuts.js';
import { MOUSE_BUTTON_NAMES } from '../services/keyCombo.js';

export function createViewerGestures(viewportState) {
  let _isPanning = false;
  let _panStartX = 0;
  let _panStartY = 0;
  let _panOriginTx = 0;
  let _panOriginTy = 0;
  const _panButtonsDown = new Set();

  const PAN_BUTTONS = Object.fromEntries(
    Object.entries(MOUSE_BUTTON_NAMES).map(([num, name]) => [name.toLowerCase(), Number(num)])
  );

  const _panMouseButtons = new Set([0, 1]); // MouseLeft, MouseMiddle
  const _panKeyboardKeys = new Set([' ']); // Space

  function _updatePanKeysCache() {
    const binds = Core.getState().config?.frontend_data?.keybinds || {};
    let keys = binds['cmd-pan-drag'];
    if (!Array.isArray(keys)) {
      keys = typeof keys === 'string' ? [keys] : ['MouseLeft', 'MouseMiddle', 'Space'];
    }
    
    _panMouseButtons.clear();
    _panKeyboardKeys.clear();
    
    for (const key of keys) {
      const token = String(key).trim().toLowerCase();
      const btnId = PAN_BUTTONS[token];
      if (btnId !== undefined) {
        _panMouseButtons.add(btnId);
      } else {
        _panKeyboardKeys.add(token === 'space' ? ' ' : token);
      }
    }
  }

  // Idle cursor auto-hide
  let _idleCursorTimer = null;
  let _cursorHidden = false;
  let _autoHideToggleOverride = null;

  function _isMouseOverViewportNow() {
    const state = Core.getState();
    if (!state.src || state.mode === 'empty') return false;

    const dropOverlay = document.getElementById('drop-overlay');
    if (dropOverlay && !dropOverlay.classList.contains('hidden') && dropOverlay.classList.contains('active')) {
      return false;
    }
    const pwOverlay = document.getElementById('password-overlay');
    if (pwOverlay && pwOverlay.classList.contains('active')) {
      return false;
    }

    const vp = document.getElementById('viewport');
    if (!vp) return false;

    if (_lastMouseX !== 0 || _lastMouseY !== 0) {
      const target = document.elementFromPoint(_lastMouseX, _lastMouseY);
      if (!target || target.closest('#drop-overlay') || target.closest('#password-overlay') || target.closest('#file-panel, #menubar, #statusbar')) {
        return false;
      }
      return !!target.closest('#viewport');
    }

    return vp.matches(':hover');
  }

  function _isAutoHideEnabled() {
    if (_autoHideToggleOverride !== null) return _autoHideToggleOverride;
    const delaySec = Core.getState().config?.frontend_data?.hide_cursor_delay_sec ?? 2;
    return delaySec > 0;
  }

  function _getDelayMs() {
    const delaySec = Core.getState().config?.frontend_data?.hide_cursor_delay_sec;
    const sec = (typeof delaySec === 'number' && delaySec > 0) ? delaySec : 2;
    return sec * 1000;
  }

  function _showCursor() {
    if (_cursorHidden) {
      _cursorHidden = false;
      const vp = document.getElementById('viewport');
      vp?.classList.remove('cursor-hidden');
    }
  }

  function _hideCursor() {
    if (!_isMouseOverViewportNow()) return;
    if (!_cursorHidden && !_isPanning && _panButtonsDown.size === 0 && !_keyPanHeld(null)) {
      _cursorHidden = true;
      const vp = document.getElementById('viewport');
      vp?.classList.add('cursor-hidden');
    }
  }

  function _armIdleCursorTimer() {
    clearTimeout(_idleCursorTimer);
    if (!_isAutoHideEnabled()) {
      _showCursor();
      return;
    }
    _idleCursorTimer = setTimeout(_hideCursor, _getDelayMs());
  }

  function toggleCursorAutoHide() {
    const enabled = _isAutoHideEnabled();
    _autoHideToggleOverride = !enabled;
    if (!_autoHideToggleOverride) {
      clearTimeout(_idleCursorTimer);
      _showCursor();
    } else {
      if (_isMouseOverViewportNow()) {
        _armIdleCursorTimer();
      }
    }
  }

  function _onConfigLoaded() {
    _updatePanKeysCache();
    _autoHideToggleOverride = null;
    if (_isMouseOverViewportNow()) {
      _armIdleCursorTimer();
    } else {
      _showCursor();
    }
  }
  window.addEventListener('quivit-config-loaded', _onConfigLoaded);
  _updatePanKeysCache();

  function _keyPanHeld(exceptKey) {
    for (const held of _panKeyboardKeys) {
      if (held !== exceptKey && activeKeys.has(held)) return true;
    }
    return false;
  }

  function _isMousePanKey(e) {
    return _panMouseButtons.has(e.button);
  }

  function _panActive() {
    return _panButtonsDown.size > 0 || _keyPanHeld(null);
  }

  function _startPan(clientX, clientY) {
    _isPanning = true;
    _panStartX = clientX;
    _panStartY = clientY;
    _panOriginTx = viewportState.getTx();
    _panOriginTy = viewportState.getTy();
    document.body.classList.toggle('cursor-move', true);
    if (_keyPanHeld(null)) _startCursorPoll();
  }

  function _stopPan() {
    _isPanning = false;
    _panButtonsDown.clear();
    _stopCursorPoll();
    document.body.classList.toggle('cursor-move', false);
    if (_isMouseOverViewport) {
      _armIdleCursorTimer();
    }
  }

  let _cursorPolling = false;
  let _cursorPollTimer = null;
  let _cursorPollInFlight = false;
  let _winClientOriginX = 0;
  let _winClientOriginY = 0;
  let _winScaleFactor = 1;
  let _unlistenWinMove = null;

  function _cursorToClient(pos) {
    return {
      x: (pos.x - _winClientOriginX) / _winScaleFactor,
      y: (pos.y - _winClientOriginY) / _winScaleFactor,
    };
  }

  async function _startCursorPoll() {
    if (_cursorPolling || !window.__TAURI__?.window) return;
    _cursorPolling = true;
    const win = window.__TAURI__.window.getCurrentWindow();
    try {
      const [origin, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
      if (!_cursorPolling) return;
      _winClientOriginX = origin.x;
      _winClientOriginY = origin.y;
      _winScaleFactor = scale;
      _unlistenWinMove = await win.onMoved(async () => {
        try {
          const origin = await win.innerPosition();
          _winClientOriginX = origin.x;
          _winClientOriginY = origin.y;
        } catch {}
      });
    } catch {
      _cursorPolling = false;
      return;
    }
    if (!_cursorPolling) {
      if (_unlistenWinMove) {
        _unlistenWinMove();
        _unlistenWinMove = null;
      }
      return;
    }
    _cursorPollTimer = setInterval(_pollCursor, 16);
  }

  function _stopCursorPoll() {
    _cursorPolling = false;
    if (_cursorPollTimer) {
      clearInterval(_cursorPollTimer);
      _cursorPollTimer = null;
    }
    if (_unlistenWinMove) {
      _unlistenWinMove();
      _unlistenWinMove = null;
    }
  }

  async function _pollCursor() {
    if (!_cursorPolling || _cursorPollInFlight) return;
    _cursorPollInFlight = true;
    try {
      const pos = await window.__TAURI__.window.cursorPosition();
      const { x, y } = _cursorToClient(pos);
      _updatePan(x, y);
    } catch {}
    _cursorPollInFlight = false;
  }

  function _updatePan(clientX, clientY) {
    if (!_isPanning) return;
    viewportState.panTo(
      _panOriginTx + (clientX - _panStartX),
      _panOriginTy + (clientY - _panStartY)
    );
  }

  function _onMouseDown(e) {
    if (!_isMouseOverViewportNow()) return;
    const isPanKey = _isMousePanKey(e) || (e.button === 0 && _keyPanHeld(null));
    if (!isPanKey) return;
    e.preventDefault();
    if (_isMousePanKey(e)) _panButtonsDown.add(e.button);
    _startPan(e.clientX, e.clientY);
  }

  let _lastMouseX = 0;
  let _lastMouseY = 0;

  function _onMouseMove(e) {
    _lastMouseX = e.clientX;
    _lastMouseY = e.clientY;

    if (!_panActive()) {
      if (_isPanning) _stopPan();
      return;
    }
    if (!_isPanning) {
      if (!_isMouseOverViewportNow()) return;
      _startPan(e.clientX, e.clientY);
    }
    _updatePan(e.clientX, e.clientY);
  }

  function _onMouseUp(e) {
    _panButtonsDown.delete(e.button);
    if (_isPanning && !_panActive()) _stopPan();
  }

  const viewport = document.getElementById('viewport');
  if (viewport) {
    viewport.addEventListener('mousedown', (e) => {
      _showCursor();
      _armIdleCursorTimer();
      _onMouseDown(e);
    });
    viewport.addEventListener('contextmenu', (e) => {
      if (_panMouseButtons.has(2)) e.preventDefault();
    });
    viewport.addEventListener('mouseenter', () => {
      _showCursor();
      _armIdleCursorTimer();
    });
    viewport.addEventListener('pointermove', () => {
      _showCursor();
      _armIdleCursorTimer();
    });
    viewport.addEventListener('mouseleave', () => {
      if (!_isMouseOverViewportNow()) {
        clearTimeout(_idleCursorTimer);
        _showCursor();
      }
    });
    viewport.addEventListener('wheel', () => {
      _showCursor();
      _armIdleCursorTimer();
    }, { passive: true });
  }
  window.addEventListener('mousemove', _onMouseMove);
  window.addEventListener('mouseup', _onMouseUp);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    setTimeout(() => {
      if (!_isMouseOverViewportNow()) return;
      if (!_isPanning && _panButtonsDown.size === 0 && _keyPanHeld(null)) {
        _startPan(_lastMouseX, _lastMouseY);
      }
    }, 0);
  });

  window.addEventListener('keyup', (e) => {
    const released = e.key.toLowerCase();
    if (_isPanning && _panButtonsDown.size === 0 && !_keyPanHeld(released)) _stopPan();
  });

  window.addEventListener('blur', () => {
    if (_isPanning && _panButtonsDown.size === 0) _stopPan();
    _showCursor();
    clearTimeout(_idleCursorTimer);
  });

  return {
    toggleCursorAutoHide,
    showCursor: _showCursor,
    hideCursor: _hideCursor
  };
}
