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
      // Keep suppressing the browser context menu until the capture window ends:
      // the contextmenu event that trails a finalizing right-click press
      // (mousedown → contextmenu) would otherwise pop the native menu.
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
            // Left/right buttons can become a double-click gesture — wait the
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
          // other key/button) is not a valid binding — exit capture entirely
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

    // Scroll wheel bindings: ScrollUp / ScrollDown (optionally combined with
    // modifiers) show live while scrolling and finalize once the gesture
    // settles, so continued scrolling never bleeds past capture and scrolls
    // the options page.
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isFinalizing) return;
      if (singleOnly) return;
      const scrollDir = e.deltaY < 0 ? 'ScrollUp' : 'ScrollDown';
      // Only modifier keys combine with the scroll direction — non-modifier
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

  function createScrollModeToggle() {
    const wrap = document.createElement('div');
    wrap.className = 'scroll-mode-toggle';

    const label = document.createElement('span');
    label.className = 'scroll-mode-label';
    label.textContent = 'Modifier Key';

    const btnHold = document.createElement('button');
    btnHold.type = 'button';
    btnHold.className = 'scroll-mode-btn';
    btnHold.textContent = 'Hold';
    btnHold.title = 'Temporarily switch zoom/pan states.';

    const btnToggle = document.createElement('button');
    btnToggle.type = 'button';
    btnToggle.className = 'scroll-mode-btn';
    btnToggle.textContent = 'Toggle';
    btnToggle.title = 'Persistently switch zoom/pan states.';

    const apply = () => {
      const active = config.frontend_data.scroll_zoom_modifier === 'toggle' ? 'toggle' : 'hold';
      btnHold.classList.toggle('active', active === 'hold');
      btnToggle.classList.toggle('active', active === 'toggle');
    };

    btnHold.addEventListener('click', () => {
      config.frontend_data.scroll_zoom_modifier = 'hold';
      apply();
    });
    btnToggle.addEventListener('click', () => {
      config.frontend_data.scroll_zoom_modifier = 'toggle';
      apply();
    });

    apply();
    wrap.appendChild(label);
    wrap.appendChild(btnHold);
    wrap.appendChild(btnToggle);
    return wrap;
  }

  function renderKeybinds() {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    
    const binds = config.frontend_data.keybinds;
    
    CATEGORIES.forEach(category => {
      const header = document.createElement('h3');
      header.textContent = category.name;
      header.className = 'keybind-category-header';
      container.appendChild(header);
  
      category.actions.forEach(action => {
        const row = document.createElement('div');
        row.className = 'keybind-item';
        
        const label = document.createElement('span');
        label.className = 'keybind-name';
        label.textContent = action.label;
        
        const tagsContainer = document.createElement('div');
        tagsContainer.className = 'keybind-tags';
  
        const renderTags = () => {
          const { conflictColorMap: newColors } = getConflictColors(config.frontend_data.keybinds);
          tagsContainer.innerHTML = '';
          let currentBinds = binds[action.id];
          currentBinds = normalizeList(currentBinds);
  
          currentBinds.forEach((bind, idx) => {
            const tag = document.createElement('button');
            tag.className = 'keybind-tag';
            tag.title = 'Click to rebind';
  
            const conflictColor = newColors[bind];
            if (conflictColor) {
              tag.style.color = conflictColor;
              tag.style.borderColor = conflictColor;
            }
            
            const textSpan = document.createElement('span');
            textSpan.textContent = bind;
            tag.appendChild(textSpan);

            const removeBinding = () => {
              if (isLockedBinding(action.id, bind)) {
                showLockedBindingStatus(action.id, bind);
                return;
              }
              const candidateBinds = currentBinds.filter((_, i) => i !== idx);
              if (action.id === MENUBAR_ACTION && !hasUsableMenubarBind(binds, candidateBinds)) {
                showStatus('Toggle Menu Bar needs at least one non-conflicting binding.');
                return;
              }
              currentBinds.splice(idx, 1);
              binds[action.id] = currentBinds;
              renderKeybinds();
            };
            
            const xBtn = document.createElement('span');
            xBtn.className = 'remove-btn';
            xBtn.textContent = '×';
            xBtn.title = isLockedBinding(action.id, bind) ? 'Required binding' : 'Remove binding';
            
            xBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              removeBinding();
            });
            
            // Middle-click on a tag also removes that binding (alternative to ×).
            // preventDefault on the middle mousedown blocks the browser's native
            // autoscroll (which would otherwise swallow the click); removal
            // happens on mouseup. During keybind capture the window capture-phase
            // listener stopPropagates these events, so middle mouse stays bindable.
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
            tag.addEventListener('click', (e) => captureKeybind(action.id, idx, tag, e));
            tagsContainer.appendChild(tag);
          });
  
          const addBtn = document.createElement('button');
          addBtn.className = 'keybind-tag add-btn';
          addBtn.textContent = '+';
          addBtn.title = currentBinds.length > 0 ? 'Add alternative keybind' : 'Add keybind';
          addBtn.addEventListener('click', (e) => captureKeybind(action.id, currentBinds.length, addBtn, e));
          tagsContainer.appendChild(addBtn);
        };
  
        renderTags();
        row.appendChild(label);
        row.appendChild(tagsContainer);
        container.appendChild(row);
      });

      if (category.name === 'Pan') {
        const scrollHeader = document.createElement('h3');
        scrollHeader.textContent = 'Wheel Behaviour';
        scrollHeader.className = 'keybind-category-header';
        container.appendChild(scrollHeader);
        container.appendChild(createScrollModeToggle());
      }
    });
  }

  // Initial render
  renderKeybinds();
  
  // Return the render function in case it needs to be called externally
  return {
    renderKeybinds
  };
}
