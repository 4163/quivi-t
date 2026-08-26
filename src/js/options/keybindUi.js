import { formatKeysCombo, normalizeCombo, normalizeList } from '../services/keyCombo.js';
import {
  CATEGORIES,
  SINGLE_INPUT_ACTIONS,
  validateKeybindSafety,
  getConflictColors,
  hasUsableMenubarBind,
  isLockedBinding,
  MENUBAR_ACTION,
} from '../services/keybindDomain.js';

export { validateKeybindSafety };

export function initKeybindUi(containerId, config, showStatus) {
  let isCapturing = false;
  let _scrollHold = null;
  let _scrollToggle = null;

  function showLockedBindingStatus(actionId, bind) {
    if (actionId === 'cmd-exit-fullscreen-hold' && normalizeCombo(bind) === 'Escape') {
      showStatus('Fullscreen requires Esc as a fallback.');
    }
  }

  function captureKeybind(actionId, index, element, initiatingEvent) {
    if (isCapturing) return;
    const binds = config.frontend_data.keybinds;
    let currentBinds = normalizeList(binds[actionId]);
    if (isLockedBinding(actionId, currentBinds[index])) {
      showLockedBindingStatus(actionId, currentBinds[index]);
      return;
    }

    isCapturing = true;
    const singleOnly = SINGLE_INPUT_ACTIONS.has(actionId);
  
    element.classList.add('capturing');
    element.textContent = 'Listening...';
    
    let activeKeys = new Set();
    let activeButtons = new Set();
    let maxKeys = new Set();
    let maxButtons = new Set();
    let isFinalizing = false;

    // Double-click gestures: a pure mouse click waits a short window so a rapid
    // second press on the same button/position can be captured as DoubleClick
    // or DoubleRightClick instead of a single MouseLeft / MouseRight.
    const DOUBLE_CLICK_MS = 350;
    let mousePress = null;
    let doubleCombo = null;
    let mouseTimer = null;

    // The click that started capture (on the tag / + button) counts as the
    // first press of a double-click gesture, so clicking a tag then clicking
    // once more within the window captures DoubleClick naturally.
    if (initiatingEvent && initiatingEvent.button === 0 && !singleOnly) {
      mousePress = {
        button: 0,
        x: initiatingEvent.clientX,
        y: initiatingEvent.clientY,
        time: Date.now(),
      };
    }

    // Wheel bindings settle after the scroll gesture stops, keeping the page
    // from scrolling during (and right after) the capture.
    const WHEEL_SETTLE_MS = 300;
    let wheelTimer = null;

    const clearWheelTimer = () => {
      if (wheelTimer) {
        clearTimeout(wheelTimer);
        wheelTimer = null;
      }
    };

    const clearMouseTimer = () => {
      if (mouseTimer) {
        clearTimeout(mouseTimer);
        mouseTimer = null;
      }
    };
    
    const finish = (finalCombo) => {
      if (isFinalizing) return;
      isFinalizing = true;
      cleanup();
      
      if (finalCombo) {
        let currentBinds = normalizeList(binds[actionId]);
  
        if (finalCombo === 'Delete') {
          const bindToRemove = currentBinds[index];
          const candidateBinds = currentBinds.filter((_, i) => i !== index);
          if (isLockedBinding(actionId, bindToRemove)) {
            showLockedBindingStatus(actionId, bindToRemove);
          } else if (actionId === MENUBAR_ACTION && !hasUsableMenubarBind(binds, candidateBinds)) {
            showStatus('Toggle Menu Bar needs at least one non-conflicting binding.');
          } else {
            currentBinds.splice(index, 1);
          }
        } else {
          const candidateBinds = [...currentBinds];
          candidateBinds[index] = normalizeCombo(finalCombo);
          if (actionId === MENUBAR_ACTION && !hasUsableMenubarBind(binds, candidateBinds)) {
            showStatus('Toggle Menu Bar needs at least one non-conflicting binding.');
          } else {
            currentBinds = candidateBinds;
          }
        }
        
        binds[actionId] = currentBinds;
      }
      renderKeybinds();
    };
  
    const cleanup = () => {
      clearMouseTimer();
      clearWheelTimer();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('wheel', onWheel, true);
      // Keep suppressing the browser context menu until capture ends.
      // A right-click mousedown followed by contextmenu would otherwise pop the
      // native menu.
      setTimeout(() => {
        isCapturing = false;
        window.removeEventListener('contextmenu', onContextMenu, true);
      }, 100);
    };
  
    const updateState = () => {
      if ((activeKeys.size + activeButtons.size) > (maxKeys.size + maxButtons.size)) {
        maxKeys = new Set(activeKeys);
        maxButtons = new Set(activeButtons);
      }
      
      const maxCombo = formatKeysCombo(maxKeys, maxButtons);
      element.textContent = doubleCombo || maxCombo || 'Listening...';

      if (singleOnly) {
        if (activeKeys.size === 0 && activeButtons.size === 0 && maxCombo) {
          finish(maxCombo);
        }
        return;
      }
      
      if (activeKeys.size === 0 && activeButtons.size === 0 && (maxCombo || doubleCombo)) {
        const hasNonModifier = Array.from(maxKeys).some(k => !['control', 'shift', 'alt', 'meta'].includes(k)) 
          || maxButtons.size > 0
          || (maxCombo.includes('+') && !maxCombo.endsWith('Ctrl') && !maxCombo.endsWith('Shift') && !maxCombo.endsWith('Alt'));

        const finalCombo = doubleCombo || (hasNonModifier ? maxCombo : null);

        if (finalCombo) {
          if (doubleCombo) {
            doubleCombo = null;
            clearMouseTimer();
            finish(finalCombo);
          } else if (maxButtons.size > 0 && maxKeys.size === 0
                     && [...maxButtons].every(b => b === 0 || b === 2)) {
            // Left/right buttons can become a double-click gesture. Wait the
            // window. Middle/back/forward have no double state, so commit now.
            clearMouseTimer();
            mouseTimer = setTimeout(() => {
              mouseTimer = null;
              finish(finalCombo);
            }, DOUBLE_CLICK_MS);
          } else {
            finish(finalCombo);
          }
        } else {
          // Modifier-only press (Ctrl/Shift/Alt/Meta held then released with no
          // other key/button) is not a valid binding. Exit capture entirely
          // (same as Escape) instead of lingering in the listening state.
          finish(null);
        }
      }
    };
  
    const onKeyDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        finish(null);
        return;
      }
      if (e.key === 'Delete') {
        finish('Delete');
        return;
      }
      if (singleOnly) {
        const mods = ['control', 'shift', 'alt', 'meta'];
        if (mods.includes(e.key.toLowerCase())) return;
        if (activeKeys.size + activeButtons.size > 0) return;
        activeKeys.add(e.key.toLowerCase());
        updateState();
        return;
      }
      activeKeys.add(e.key.toLowerCase());
      updateState();
    };
    
    const onKeyUp = (e) => {
      e.preventDefault();
      e.stopPropagation();
      activeKeys.delete(e.key.toLowerCase());
      updateState();
    };
  
    const onMouseDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (singleOnly) {
        if (activeKeys.size + activeButtons.size > 0) return;
        activeButtons.add(e.button);
        updateState();
        return;
      }
      if (e.button === 0 || e.button === 2) {
        const now = Date.now();
        const isDouble = mousePress && mousePress.button === e.button
          && now - mousePress.time < DOUBLE_CLICK_MS
          && Math.abs(e.clientX - mousePress.x) < 8
          && Math.abs(e.clientY - mousePress.y) < 8;
        if (isDouble) {
          clearMouseTimer();
          doubleCombo = e.button === 0 ? 'DoubleClick' : 'DoubleRightClick';
          mousePress = null;
        } else {
          mousePress = { button: e.button, x: e.clientX, y: e.clientY, time: now };
        }
      }
      activeButtons.add(e.button);
      updateState();
    };
    
    const onMouseUp = (e) => {
      e.preventDefault();
      e.stopPropagation();
      activeButtons.delete(e.button);
      updateState();
    };
  
    const onContextMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Show scroll bindings while scrolling, then finish once the gesture
    // settles. That keeps later wheel events from scrolling the options page.
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isFinalizing) return;
      if (singleOnly) return;
      const scrollDir = e.deltaY < 0 ? 'ScrollUp' : 'ScrollDown';
      // Only modifier keys combine with the scroll direction. Non-modifier
      // keys and mouse buttons are ignored so scroll combos stay consistent
      // with the double-click gestures (no key/button + gesture).
      const mods = new Set(Array.from(activeKeys).filter(k => ['control', 'shift', 'alt', 'meta'].includes(k.toLowerCase())));
      const wheelCombo = formatKeysCombo(mods, new Set(), scrollDir);
      element.textContent = wheelCombo;
      clearWheelTimer();
      wheelTimer = setTimeout(() => {
        wheelTimer = null;
        finish(wheelCombo);
      }, WHEEL_SETTLE_MS);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('contextmenu', onContextMenu, true);
  }

  function syncScrollModeToggle() {
    if (!_scrollHold || !_scrollToggle) {
      _scrollHold = document.querySelector('#scroll-mode-toggle [data-mode="hold"]');
      _scrollToggle = document.querySelector('#scroll-mode-toggle [data-mode="toggle"]');
      if (!_scrollHold || !_scrollToggle) return;
    }
    const active = config.frontend_data.scroll_zoom_modifier === 'toggle' ? 'toggle' : 'hold';
    _scrollHold.classList.toggle('active', active === 'hold');
    _scrollToggle.classList.toggle('active', active === 'toggle');
  }

  function initScrollModeToggle() {
    _scrollHold = document.querySelector('#scroll-mode-toggle [data-mode="hold"]');
    _scrollToggle = document.querySelector('#scroll-mode-toggle [data-mode="toggle"]');
    if (!_scrollHold || !_scrollToggle) return;
    // Directly mutates caller-owned config — matches existing keybinds pattern in this file.
    _scrollHold.addEventListener('click', () => {
      config.frontend_data.scroll_zoom_modifier = 'hold';
      syncScrollModeToggle();
    });
    _scrollToggle.addEventListener('click', () => {
      config.frontend_data.scroll_zoom_modifier = 'toggle';
      syncScrollModeToggle();
    });
    syncScrollModeToggle();
  }

  function renderKeybinds() {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // options.html contains the category headers, action labels, and tag slots
    // before this runs. Add a matching slot there when adding an action to
    // CATEGORIES in actions.js.
    
    const binds = config.frontend_data.keybinds;
    const slots = container.querySelectorAll('.keybind-tags[data-action]');
    
    slots.forEach(tagsContainer => {
      const actionId = tagsContainer.dataset.action;
      const { conflictColorMap: newColors } = getConflictColors(config.frontend_data.keybinds);
      
      tagsContainer.innerHTML = '';
      let currentBinds = normalizeList(binds[actionId] || []);

      currentBinds.forEach((bind, idx) => {
        const tag = document.createElement('button');
        tag.className = 'keybind-tag';

        const conflictColor = newColors[bind];
        if (conflictColor) {
          tag.style.color = conflictColor;
          tag.style.borderColor = conflictColor;
        }
        
        const textSpan = document.createElement('span');
        textSpan.textContent = bind;
        tag.appendChild(textSpan);

        const removeBinding = () => {
          if (isLockedBinding(actionId, bind)) {
            showLockedBindingStatus(actionId, bind);
            return;
          }
          const candidateBinds = currentBinds.filter((_, i) => i !== idx);
          if (actionId === MENUBAR_ACTION && !hasUsableMenubarBind(binds, candidateBinds)) {
            showStatus('Toggle Menu Bar needs at least one non-conflicting binding.');
            return;
          }
          currentBinds.splice(idx, 1);
          binds[actionId] = currentBinds;
          renderKeybinds();
        };
        
        const xBtn = document.createElement('span');
        xBtn.className = 'remove-btn';
        xBtn.textContent = '×';
        if (isLockedBinding(actionId, bind)) {
          xBtn.title = 'Required binding';
        }
        
        xBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeBinding();
        });
        
        tag.addEventListener('mousedown', (e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          e.stopPropagation();
        });
        tag.addEventListener('mouseup', (e) => {
          if (e.button !== 1 || isCapturing) return;
          e.preventDefault();
          e.stopPropagation();
          removeBinding();
        });
        
        tag.appendChild(xBtn);
        tag.addEventListener('click', (e) => captureKeybind(actionId, idx, tag, e));
        tagsContainer.appendChild(tag);
      });

      const addBtn = document.createElement('button');
      addBtn.className = 'keybind-tag add-btn';
      addBtn.textContent = '+';
      addBtn.addEventListener('click', (e) => captureKeybind(actionId, currentBinds.length, addBtn, e));
      tagsContainer.appendChild(addBtn);
    });
  }

  // Initial render.
  initScrollModeToggle();
  renderKeybinds();
  
  // Options can call this after resetting keybinds.
  return {
    renderKeybinds,
    syncScrollModeToggle
  };
}
