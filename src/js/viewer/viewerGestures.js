import { Core } from '../core.js';
import { activeKeys, MOUSE_BUTTON_NAMES } from '../shortcuts.js';

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
  window.addEventListener('quivit-config-loaded', _updatePanKeysCache);

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
    document.body.style.cursor = 'move';
    if (_keyPanHeld(null)) _startCursorPoll();
  }

  function _stopPan() {
    _isPanning = false;
    _panButtonsDown.clear();
    _stopCursorPoll();
    document.body.style.cursor = '';
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
    const isPanKey = _isMousePanKey(e) || (e.button === 0 && _keyPanHeld(null));
    if (!isPanKey) return;
    e.preventDefault();
    if (_isMousePanKey(e)) _panButtonsDown.add(e.button);
    _startPan(e.clientX, e.clientY);
  }

  function _onMouseMove(e) {
    if (!_panActive()) {
      if (_isPanning) _stopPan();
      return;
    }
    if (!_isPanning) {
      if (_panButtonsDown.size === 0 && e.target.closest?.('#file-panel, .menubar, .dropdown-menu, #statusbar')) return;
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
    viewport.addEventListener('mousedown', _onMouseDown);
    viewport.addEventListener('contextmenu', (e) => {
      if (_panMouseButtons.has(2)) e.preventDefault();
    });
  }
  window.addEventListener('mousemove', _onMouseMove);
  window.addEventListener('mouseup', _onMouseUp);

  window.addEventListener('keyup', (e) => {
    const released = e.key.toLowerCase();
    if (_isPanning && _panButtonsDown.size === 0 && !_keyPanHeld(released)) _stopPan();
  });

  window.addEventListener('blur', () => {
    if (_isPanning && _panButtonsDown.size === 0) _stopPan();
  });
}
