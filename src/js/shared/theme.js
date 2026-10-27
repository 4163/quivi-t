let pendingTheme = Promise.resolve();

export function applyTheme(theme) {
  document.documentElement.removeAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  }

  if (window.__TAURI__ && window.__TAURI__.core) {
    const tauriTheme = (theme === 'light' || theme === 'dark') ? theme : null;
    pendingTheme = window.__TAURI__.core.invoke('update_theme', { theme: tauriTheme }).catch(() => {});
  }
  return pendingTheme;
}

export function waitForTheme() {
  return pendingTheme;
}

export function applyCustomCss(cssText) {
  const styleEl = document.getElementById('custom-css');
  if (styleEl) {
    styleEl.textContent = cssText || '';
    window.dispatchEvent(new CustomEvent('quivit-css-applied'));
  }
}
