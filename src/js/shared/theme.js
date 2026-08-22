export function applyTheme(theme) {
  document.documentElement.removeAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  }

  if (window.__TAURI__ && window.__TAURI__.core) {
    const tauriTheme = (theme === 'light' || theme === 'dark') ? theme : null;
    window.__TAURI__.core.invoke('update_theme', { theme: tauriTheme }).catch(() => {});
  }
}

export function applyCustomCss(cssText) {
  const styleEl = document.getElementById('custom-css');
  if (styleEl) {
    styleEl.textContent = cssText || '';
    window.dispatchEvent(new CustomEvent('quivit-css-applied'));
  }
}
