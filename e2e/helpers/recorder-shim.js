/**
 * recorder-shim.js: Injected in-browser shim for recording user command actions,
 * sidebar clicks, and rich rendering context across navigation.
 * Zero impact on production build: lives strictly under e2e/ and injected via WebDriver.
 */

export function initRecorderShim(options = {}) {
  if (window.__QUIVIT_RECORDER__) return;

  const actions = [];
  let isDone = false;
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
      },
    };
  }

  // Floating UI badge
  const badge = document.createElement('div');
  badge.id = 'quivit-recorder-badge';
  badge.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <span id="quivit-recorder-dot" style="width:10px;height:10px;border-radius:50%;background:#ff4d4f;display:inline-block;box-shadow:0 0 6px #ff4d4f;"></span>
      <span style="font-weight:600;font-size:12px;color:#fff;">RECORDING HARNESS</span>
      <span id="quivit-recorder-count" style="font-size:12px;color:#bbb;background:rgba(255,255,255,0.12);padding:2px 6px;border-radius:4px;">0 actions</span>
    </div>
      <div style="font-size:11px;color:#888;margin-top:4px;">Press Esc or click Finish to complete</div>
    </div>
    <div id="quivit-recorder-info" style="font-size:11px;color:#aaa;margin-top:4px;">Ready to record actions...</div>
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button id="quivit-recorder-reset-btn" style="flex:1;padding:6px 0;background:#3a3a3c;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;">Reset</button>
      <button id="quivit-recorder-done-btn" style="flex:2;padding:6px 0;background:#1890ff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;">Finish Recording</button>
    </div>
  `;
  badge.style.cssText = `
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: 2147483647;
    background: rgba(20, 20, 24, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 8px;
    padding: 10px 14px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    user-select: none;
    pointer-events: auto;
  `;
  document.body.appendChild(badge);

  function updateBadge(lastActionLabel) {
    const countEl = document.getElementById('quivit-recorder-count');
    if (countEl) countEl.textContent = `${actions.length} action${actions.length === 1 ? '' : 's'}`;
    const infoEl = document.getElementById('quivit-recorder-info');
    if (infoEl) {
      infoEl.textContent = lastActionLabel ? `Last: ${lastActionLabel}` : 'Ready to record actions...';
    }
  }

  function resetRecording() {
    if (isDone) return;
    actions.length = 0;
    initialSnapshot = getContextSnapshot();
    updateBadge();
    const infoEl = document.getElementById('quivit-recorder-info');
    if (infoEl) infoEl.textContent = 'Recording reset (0 actions).';
  }

  function finish() {
    if (isDone) return;
    isDone = true;
    badge.style.background = 'rgba(20, 44, 24, 0.95)';
    badge.innerHTML = `
      <div style="font-weight:600;font-size:12px;color:#52c41a;">RECORDING COMPLETE</div>
      <div style="font-size:11px;color:#bbb;margin-top:4px;">Captured ${actions.length} action${actions.length === 1 ? '' : 's'}. Writing scenario...</div>
    `;
  }

  const resetBtn = document.getElementById('quivit-recorder-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetRecording();
    });
  }

  const doneBtn = document.getElementById('quivit-recorder-done-btn');
  if (doneBtn) {
    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      finish();
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      finish();
    }
  }, true);

  async function recordStep(actionId, trigger = 'command', extra = {}) {
    if (isDone) return;
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
          recordStep(action.id, 'command');
          return originalRun.call(this, ctx, payload);
        };
      }
    }
  }).catch(() => {
    // Fallback: listen to clicks on menu items
    document.addEventListener('click', (e) => {
      if (isDone) return;
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
      if (isDone) return;
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
      if (!isDone) recordStep('cmd-toggle-filelist-view-mode', 'click');
    }, true);
  }

  // Track favorites list clicks
  const favList = document.getElementById('favorites-list');
  if (favList) {
    favList.addEventListener('click', (e) => {
      if (isDone) return;
      const li = e.target.closest('li');
      if (li && li.dataset.path) {
        recordStep('open-favorite', 'click', { path: li.dataset.path });
      }
    }, true);
  }

  window.__QUIVIT_RECORDER__ = {
    get isDone() { return isDone; },
    get actions() { return [...actions]; },
    finish,
    getTrace() {
      return {
        initialState: initialSnapshot || getContextSnapshot(),
        actions: [...actions],
      };
    },
  };
}
