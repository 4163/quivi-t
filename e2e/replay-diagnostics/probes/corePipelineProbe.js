/**
 * corePipelineProbe.js: In-browser probe for Core state machine and actions dispatch.
 * Hooks into actions.dispatch, Core.onStateChange, Core.navigate, and Core.persistConfig
 * to capture action lifecycles, state diffs, navigation attempts, and silent config flushes.
 */

export function createCorePipelineProbe() {
  let isInitialized = false;

  async function ensureInitialized() {
    if (isInitialized) return;
    isInitialized = true;

    const diag = window.__QUIVIT_DIAGNOSTICS__;
    if (!diag) return;

    // 1. Hook action dispatch in services/actions.js
    try {
      const actionsModule = await import('/js/services/actions.js');
      if (actionsModule && typeof actionsModule.dispatch === 'function' && actionsModule.ACTION_MAP) {
        const originalDispatch = actionsModule.dispatch;
        actionsModule.dispatch = async function(actionId, payload, ctx) {
          const startTime = performance.now();
          const exists = actionsModule.ACTION_MAP.has(actionId);

          if (!exists) {
            diag.recordAnomaly('unknown-action', { actionId });
            return;
          }

          const payloadSummary = payload && typeof payload === 'object'
            ? { wheel: payload.wheel, clientX: payload.clientX, clientY: payload.clientY }
            : null;

          diag.recordEvent('action', 'dispatch-start', { actionId, payload: payloadSummary });

          try {
            const result = await originalDispatch.call(this, actionId, payload, ctx);
            const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
            diag.recordEvent('action', 'dispatch-end', { actionId, elapsedMs });
            return result;
          } catch (err) {
            diag.recordAnomaly('action-error', {
              actionId,
              message: err?.message || String(err),
            });
            throw err;
          }
        };
      }
    } catch (err) {
      diag.recordAnomaly('probe-init-error', { module: 'actions.js', message: String(err) });
    }

    // 2. Hook Core state machine in core.js
    try {
      const { Core } = await import('/js/core.js');
      if (Core && typeof Core.getState === 'function') {
        let previousState = { ...Core.getState() };

        const trackedKeys = [
          'mode',
          'index',
          'filename',
          'src',
          'archivePath',
          'archiveEncryption',
          'isSpread',
          'spreadStep',
          'spreadEnabled',
          'spreadDirection',
          'fitMode',
          'scalingMode',
          'fileListViewMode',
        ];

        // Subscribe to state changes to capture scalar property diffs
        Core.onStateChange((state) => {
          const diff = {};
          let hasChanges = false;

          for (const key of trackedKeys) {
            if (previousState[key] !== state[key]) {
              diff[key] = [previousState[key], state[key]];
              hasChanges = true;
            }
          }

          const prevLen = previousState.list?.length ?? 0;
          const nextLen = state.list?.length ?? 0;
          if (prevLen !== nextLen) {
            diff.listLength = [prevLen, nextLen];
            hasChanges = true;
          }

          previousState = { ...state };

          if (hasChanges) {
            diag.recordEvent('core', 'state-change', diff);
          }
        });

        // Hook navigate to track step parameters and spread absorption
        if (typeof Core.navigate === 'function') {
          const originalNavigate = Core.navigate.bind(Core);
          Core.navigate = function(delta) {
            const st = Core.getState();
            diag.recordEvent('core', 'navigate-call', {
              delta,
              fromIndex: st.index,
              spreadStep: st.spreadStep,
              isSpread: st.isSpread,
              spreadEnabled: st.spreadEnabled,
              listLength: st.list?.length ?? 0,
            });
            return originalNavigate(delta);
          };
        }

        // Hook persistConfig to track silent background writes
        if (typeof Core.persistConfig === 'function') {
          const originalPersistConfig = Core.persistConfig.bind(Core);
          Core.persistConfig = function(options) {
            const fd = Core.getState().config?.frontend_data;
            diag.recordEvent('core', 'persist-config', {
              immediate: options?.immediate || false,
              debounceMs: options?.debounceMs || 1500,
              lastOpenedPath: fd?.last_opened_path,
              lastActiveImage: fd?.last_active_image,
              scrollZoomLatched: fd?.scroll_zoom_latched,
            });
            return originalPersistConfig(options);
          };
        }
      }
    } catch (err) {
      diag.recordAnomaly('probe-init-error', { module: 'core.js', message: String(err) });
    }
  }

  return {
    onStepStart(step) {
      ensureInitialized();
    },
  };
}
