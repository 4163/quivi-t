/**
 * ipcProtocolProbe.js: In-browser probe for Tauri IPC command invocations
 * and quivit:// / asset:// custom protocol fetch latencies and status errors.
 */

export function createIpcProtocolProbe() {
  let isInitialized = false;

  function ensureInitialized() {
    if (isInitialized) return;
    isInitialized = true;

    const diag = window.__QUIVIT_DIAGNOSTICS__;
    if (!diag) return;

    // 1. Wrap window.__TAURI__.core.invoke
    const tauriCore = window.__TAURI__?.core || window.__TAURI__;
    if (tauriCore && typeof tauriCore.invoke === 'function') {
      const originalInvoke = tauriCore.invoke;
      tauriCore.invoke = async function(cmd, args, options) {
        const startTime = performance.now();
        const argKeys = args && typeof args === 'object' ? Object.keys(args) : [];

        diag.recordEvent('ipc', 'invoke-start', { cmd, argKeys });

        try {
          const result = await originalInvoke.call(this, cmd, args, options);
          const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
          diag.recordEvent('ipc', 'invoke-end', { cmd, elapsedMs });
          return result;
        } catch (err) {
          const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
          diag.recordAnomaly('ipc-error', {
            cmd,
            elapsedMs,
            message: err?.message || String(err),
          });
          throw err;
        }
      };
    }

    // 2. Wrap window.fetch for custom protocol routes
    if (typeof window.fetch === 'function') {
      const originalFetch = window.fetch;
      window.fetch = async function(input, init) {
        const urlStr = typeof input === 'string' ? input : (input?.url || '');
        const isQuivit = urlStr.includes('quivit://') || urlStr.includes('quivit.localhost');
        const isAsset = urlStr.includes('asset://') || urlStr.includes('asset.localhost');

        if (!isQuivit && !isAsset) {
          return originalFetch.apply(this, arguments);
        }

        let route = 'other';
        if (urlStr.includes('/archive/')) route = 'archive';
        else if (urlStr.includes('/thumb/')) route = 'thumb';
        else if (urlStr.includes('/icon/')) route = 'icon';
        else if (isAsset) route = 'asset';

        const startTime = performance.now();
        diag.recordEvent('protocol', 'fetch-start', { route });

        try {
          const response = await originalFetch.apply(this, arguments);
          const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
          const status = response.status;

          if (status >= 400) {
            diag.recordAnomaly('protocol-status-error', {
              route,
              status,
              elapsedMs,
            });
          } else {
            diag.recordEvent('protocol', 'fetch-end', {
              route,
              status,
              elapsedMs,
            });
          }

          return response;
        } catch (err) {
          const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
          diag.recordAnomaly('protocol-fetch-fail', {
            route,
            elapsedMs,
            message: err?.message || String(err),
          });
          throw err;
        }
      };
    }
  }

  return {
    onStepStart(step) {
      ensureInitialized();
    },
  };
}
