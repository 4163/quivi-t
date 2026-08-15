/**
 * shellBackground.js — mirrors the app's main surface color (--surface) into
 * the native window background so the shell behind the webview matches the
 * visible page background. Self-contained leaf module: include it on any page
 * (Tauri or plain browser); no-ops outside Tauri. Re-syncs automatically when
 * the theme or custom CSS changes, so future pages get shell sync for free.
 *
 * Why not use the official `@tauri-apps/api` `Window#setBackgroundColor`?
 * Its wrapper invokes `plugin:window|set_background_color` with `{ color }`,
 * but the backend command parameter is named `value`. Because both `label`
 * and `value` are `Option`, Tauri's IPC silently turns the missing key into
 * `None` (see the `deserialize_option` CommandItem impl) instead of erroring —
 * so the wrapper actually *resets* the background to the default (black) and
 * the real color never arrives. We therefore bypass the wrapper and invoke
 * the command directly with the correct `value` key.
 */
(function () {
  if (!window.__TAURI__?.core?.invoke) return;

  let timer = null;
  function surfaceColor() {
    const probe = document.getElementById('measure-probe');
    if (!probe) return null;
    const bg = getComputedStyle(probe).backgroundColor;
    const m = bg.match(
      /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/
    );
    if (!m) return null;
    return {
      red: +m[1],
      green: +m[2],
      blue: +m[3],
      alpha: m[4] !== undefined ? Math.round(+m[4] * 255) : 255,
    };
  }

  function sync() {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      const color = surfaceColor();
      if (!color) return;
      try {
        await window.__TAURI__.core.invoke('plugin:window|set_background_color', {
          value: color,
        });
      } catch (err) {
        console.error('[Shell] Failed to sync background color:', err);
      }
    }, 20);
  }

  sync();

  if (window.__TAURI__) {
    window.__TAURI__.event.listen('theme-preview', sync).catch(console.error);
    window.__TAURI__.event.listen('css-preview', sync).catch(console.error);
  }

  window.addEventListener('storage', (e) => {
    if (e.key === 'quivit-theme' || e.key === 'quivit-custom-css') {
      sync();
    }
  });
})();
