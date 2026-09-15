/**
 * recorder-shim.js: Injected in-browser shim for recording user command actions,
 * sidebar clicks, and rich rendering context across navigation.
 * Zero impact on production build: lives strictly under e2e/ and injected via WebDriver.
 */

export function initRecorderShim(options = {}) {
  if (window.__QUIVIT_RECORDER__) return;

  const actions = [];
  let isDone = false;
  let isRecording = false;
  let CoreInstance = null;
  let initialSnapshot = null;

  function getContextSnapshot() {
    let state = null;
    if (CoreInstance && typeof CoreInstance.getState === 'function') {
      state = CoreInstance.getState();
    }

    const filename = state?.filename || document.querySelector('#statusbar .status-filename, #statusbar .filename')?.textContent?.trim() || '';
    const ext = filename.includes('.') ? (filename.split('.').pop() || '').toLowerCase() : '';
    const isArchive = state?.mode === 'archive';
    const container = isArchive ? (state?.archivePath || '') : (state?.directory || '');
    const isAnimated = !!state?.isAnimated;
    const dims = (state?.naturalWidth && state?.naturalHeight)
      ? `${state.naturalWidth} × ${state.naturalHeight}`
      : (document.querySelector('#statusbar .dims')?.textContent?.trim() || '');

    const scaling = state?.scalingMode || document.querySelector('#scaling-current-label')?.textContent?.trim() || 'Bilinear';
    const filter = state?.config?.frontend_data?.active_filter || document.querySelector('#filter-current-label')?.textContent?.trim() || 'Off';
    const fitMode = state?.fitMode || document.querySelector('#statusbar .fit')?.textContent?.trim() || 'Window';
    const spread = (state?.spreadEnabled && state?.spreadDirection) ? state.spreadDirection : 'Off';
    const viewMode = state?.fileListViewMode || 'list';

    const transparentBg = !!state?.config?.frontend_data?.transparent_bg;

    return {
      container,
      isArchive,
      filename,
      format: ext,
      dims,
      isAnimated,
      index: state?.index ?? -1,
      totalItems: state?.list?.length ?? 0,
      pipeline: {
        scaling,
        filter,
        fitMode,
        spread,
        viewMode,
        transparentBg,
        opaqueCanvas: !transparentBg,
      },
    };
  }

  // Floating UI badge
  const badge = document.createElement('div');
  badge.id = 'quivit-recorder-badge';
  badge.setAttribute('data-ui', 'true');
  badge.innerHTML = `
    <div id="quivit-recorder-header" style="display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:grab;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="color:rgba(255,255,255,0.35);font-size:12px;user-select:none;">⠿</span>
        <span id="quivit-recorder-dot" style="width:8px;height:8px;border-radius:50%;background:#888;display:inline-block;transition:all 0.2s ease;"></span>
        <span id="quivit-recorder-status" style="font-weight:700;font-size:11px;letter-spacing:0.5px;color:#fff;">READY</span>
      </div>
      <span id="quivit-recorder-count" style="font-size:11px;font-weight:600;color:#bbb;background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;">0 actions</span>
    </div>
    <div id="quivit-recorder-info" style="font-size:11px;color:#999;margin-top:6px;min-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;">Click Start or press F9 to begin</div>
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button id="quivit-recorder-toggle-btn" style="flex:1.4;padding:6px 8px;background:#16a34a;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:4px;transition:background 0.15s ease;">
        <span id="quivit-recorder-toggle-icon" style="pointer-events:none;">▶</span>
        <span id="quivit-recorder-toggle-label" style="pointer-events:none;">Start</span>
      </button>
      <button id="quivit-recorder-stop-btn" style="flex:1.1;padding:6px 8px;background:#dc2626;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:11px;font-weight:700;transition:background 0.15s ease;">
        ⏹ Stop
      </button>
      <button id="quivit-recorder-reset-btn" style="flex:1;padding:6px 8px;background:#27272a;color:#e4e4e7;border:1px solid rgba(255,255,255,0.12);border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;transition:background 0.15s ease;">
        ↺ Reset
      </button>
    </div>
  `;
  badge.style.cssText = `
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: 2147483647;
    background: rgba(18, 18, 22, 0.94);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 9px;
    padding: 10px 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.65);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    user-select: none;
    pointer-events: auto;
    width: 250px;
    box-sizing: border-box;
  `;
  document.body.appendChild(badge);

  let lastWidgetInteractionTime = 0;
  function markWidgetInteraction() {
    lastWidgetInteractionTime = performance.now();
  }

  // Prevent widget clicks and wheel events from triggering outside handlers
  ['click', 'dblclick', 'contextmenu', 'wheel'].forEach((evtType) => {
    badge.addEventListener(evtType, (e) => {
      markWidgetInteraction();
      e.stopPropagation();
    });
  });

  // Dragging support so user can move badge away from viewport elements
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const header = document.getElementById('quivit-recorder-header');

  if (header) {
    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      markWidgetInteraction();
      header.style.cursor = 'grabbing';
      const rect = badge.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      badge.style.left = `${rect.left}px`;
      badge.style.top = `${rect.top}px`;
      badge.style.right = 'auto';
      badge.style.bottom = 'auto';
      e.preventDefault();
      e.stopPropagation();
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    markWidgetInteraction();
    const x = Math.max(8, Math.min(window.innerWidth - badge.offsetWidth - 8, e.clientX - dragOffsetX));
    const y = Math.max(8, Math.min(window.innerHeight - badge.offsetHeight - 8, e.clientY - dragOffsetY));
    badge.style.left = `${x}px`;
    badge.style.top = `${y}px`;
  });

  function stopDrag() {
    if (isDragging) {
      isDragging = false;
      markWidgetInteraction();
      if (header) header.style.cursor = 'grab';
    }
  }

  window.addEventListener('mouseup', stopDrag, { capture: true });
  window.addEventListener('blur', stopDrag);

  function updateBadge(lastActionLabel) {
    const dot = document.getElementById('quivit-recorder-dot');
    const status = document.getElementById('quivit-recorder-status');
    const count = document.getElementById('quivit-recorder-count');
    const info = document.getElementById('quivit-recorder-info');
    const toggleBtn = document.getElementById('quivit-recorder-toggle-btn');
    const toggleIcon = document.getElementById('quivit-recorder-toggle-icon');
    const toggleLabel = document.getElementById('quivit-recorder-toggle-label');

    if (count) {
      count.textContent = `${actions.length} action${actions.length === 1 ? '' : 's'}`;
    }

    if (isDone) {
      if (dot) {
        dot.style.background = '#22c55e';
        dot.style.boxShadow = '0 0 8px #22c55e';
      }
      if (status) {
        status.textContent = 'SAVED';
        status.style.color = '#22c55e';
      }
      if (info) {
        info.textContent = `Captured ${actions.length} action(s). Writing scenario...`;
        info.style.color = '#a1a1aa';
      }
      return;
    }

    if (isRecording) {
      if (dot) {
        dot.style.background = '#ef4444';
        dot.style.boxShadow = '0 0 8px #ef4444';
      }
      if (status) {
        status.textContent = 'RECORDING';
        status.style.color = '#ef4444';
      }
      if (toggleBtn) {
        toggleBtn.style.background = '#d97706';
      }
      if (toggleIcon) toggleIcon.textContent = '⏸';
      if (toggleLabel) toggleLabel.textContent = 'Pause';
      if (info) {
        info.textContent = lastActionLabel ? `Last: ${lastActionLabel}` : 'Recording active...';
        info.style.color = '#e4e4e7';
      }
    } else {
      if (actions.length > 0) {
        if (dot) {
          dot.style.background = '#eab308';
          dot.style.boxShadow = '0 0 6px #eab308';
        }
        if (status) {
          status.textContent = 'PAUSED';
          status.style.color = '#eab308';
        }
        if (toggleBtn) {
          toggleBtn.style.background = '#16a34a';
        }
        if (toggleIcon) toggleIcon.textContent = '▶';
        if (toggleLabel) toggleLabel.textContent = 'Resume';
        if (info) {
          info.textContent = 'Paused (actions ignored)';
          info.style.color = '#a1a1aa';
        }
      } else {
        if (dot) {
          dot.style.background = '#71717a';
          dot.style.boxShadow = 'none';
        }
        if (status) {
          status.textContent = 'READY';
          status.style.color = '#d4d4d8';
        }
        if (toggleBtn) {
          toggleBtn.style.background = '#16a34a';
        }
        if (toggleIcon) toggleIcon.textContent = '▶';
        if (toggleLabel) toggleLabel.textContent = 'Start';
        if (info) {
          info.textContent = 'Click Start or press F9 to begin';
          info.style.color = '#a1a1aa';
        }
      }
    }
  }

  function startRecording() {
    if (isDone || isRecording) return;
    if (!initialSnapshot || actions.length === 0) {
      initialSnapshot = getContextSnapshot();
    }
    isRecording = true;
    updateBadge();
  }

  function pauseRecording() {
    if (isDone || !isRecording) return;
    isRecording = false;
    updateBadge();
  }

  function toggleRecording() {
    if (isRecording) {
      pauseRecording();
    } else {
      startRecording();
    }
  }

  function resetRecording() {
    isDone = false;
    isRecording = false;
    actions.length = 0;
    initialSnapshot = null;
    updateBadge();
    const infoEl = document.getElementById('quivit-recorder-info');
    if (infoEl) infoEl.textContent = 'Reset (0 actions). Click Start to record.';
  }

  function finish() {
    if (isDone) return;
    isDone = true;
    isRecording = false;
    updateBadge();
  }

  const toggleBtn = document.getElementById('quivit-recorder-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      markWidgetInteraction();
      e.stopPropagation();
      e.preventDefault();
      toggleRecording();
    });
  }

  const resetBtn = document.getElementById('quivit-recorder-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      markWidgetInteraction();
      e.stopPropagation();
      e.preventDefault();
      resetRecording();
    });
  }

  const stopBtn = document.getElementById('quivit-recorder-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', (e) => {
      markWidgetInteraction();
      e.stopPropagation();
      e.preventDefault();
      finish();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F9' || (e.altKey && e.key.toLowerCase() === 'r')) {
      e.stopPropagation();
      e.preventDefault();
      toggleRecording();
    }
  }, true);

  async function recordStep(actionId, trigger = 'command', extra = {}) {
    if (isDone || !isRecording) return;
    if (isDragging) return;
    await Promise.resolve();
    const context = getContextSnapshot();
    actions.push({
      action: actionId,
      trigger,
      ...extra,
      context,
    });
    updateBadge(actionId);
  }

  // Import Core to observe state
  import('/js/core.js').then(({ Core }) => {
    CoreInstance = Core;
  }).catch(() => {});

  // Hook ACTION_REGISTRY via dynamic import to capture all dispatched commands
  import('/js/services/actions.js').then(({ ACTION_REGISTRY }) => {
    if (Array.isArray(ACTION_REGISTRY)) {
      for (const action of ACTION_REGISTRY) {
        if (!action || typeof action.run !== 'function') continue;
        const originalRun = action.run;
        action.run = function(ctx, payload) {
          if (isDragging) {
            return originalRun.call(this, ctx, payload);
          }
          recordStep(action.id, 'command');
          return originalRun.call(this, ctx, payload);
        };
      }
    }
  }).catch(() => {
    // Fallback: listen to clicks on menu items
    document.addEventListener('click', (e) => {
      if (isDone || !isRecording) return;
      if (e.target.closest('#quivit-recorder-badge, [data-ui]')) return;
      const cmdEl = e.target.closest('[id^="cmd-"]');
      if (cmdEl && cmdEl.id) {
        recordStep(cmdEl.id, 'menu-click');
      }
    }, true);
  });

  // Track clicks in file panel list
  const fileList = document.getElementById('file-list');
  if (fileList) {
    fileList.addEventListener('click', (e) => {
      if (isDone || !isRecording) return;
      const row = e.target.closest('li[role="option"]');
      if (row && row.dataset.index !== undefined) {
        const index = parseInt(row.dataset.index, 10);
        const name = row.querySelector('.item-label, .item-thumbnail-title')?.textContent?.trim() || '';
        if (e.detail === 2) {
          recordStep('jump-to-index', 'dblclick', { index, name });
        } else if (e.detail === 1) {
          recordStep('select-index', 'click', { index, name });
        }
      }
    }, true);
  }

  // Track thumbnail mode toggle button clicks
  const viewModeBtn = document.getElementById('btn-toggle-view-mode');
  if (viewModeBtn) {
    viewModeBtn.addEventListener('click', () => {
      if (!isDone && isRecording) recordStep('cmd-toggle-filelist-view-mode', 'click');
    }, true);
  }

  // Track favorites list clicks
  const favList = document.getElementById('favorites-list');
  if (favList) {
    favList.addEventListener('click', (e) => {
      if (isDone || !isRecording) return;
      const li = e.target.closest('li');
      if (li && li.dataset.path) {
        recordStep('open-favorite', 'click', { path: li.dataset.path });
      }
    }, true);
  }

  window.__QUIVIT_RECORDER__ = {
    get isDone() { return isDone; },
    get isRecording() { return isRecording; },
    get actions() { return [...actions]; },
    start: startRecording,
    pause: pauseRecording,
    toggle: toggleRecording,
    reset: resetRecording,
    finish,
    getTrace() {
      return {
        initialState: initialSnapshot || getContextSnapshot(),
        actions: [...actions],
      };
    },
  };
}
