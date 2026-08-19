/**
 * shellBackground.js: mirrors --surface into the native window background.
 * That keeps the shell behind the webview from flashing a mismatched color.
 * Include this on any page. It no-ops outside Tauri and re-syncs when the
 * theme or custom CSS changes.
 *
 * Why not use the official `@tauri-apps/api` `Window#setBackgroundColor`?
 * Its wrapper invokes `plugin:window|set_background_color` with `{ color }`,
 * but the backend command parameter is named `value`. Because both `label`
 * and `value` are `Option`, Tauri's IPC silently turns the missing key into
 * `None` (see the `deserialize_option` CommandItem impl) instead of erroring,
 * so the wrapper *resets* the background to the default (black) and
 * the real color never arrives. Bypass the wrapper and invoke
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
