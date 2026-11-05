let pendingTheme = Promise.resolve();

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    if (document.documentElement.getAttribute('data-theme') !== theme) {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } else if (document.documentElement.hasAttribute('data-theme')) {
    document.documentElement.removeAttribute('data-theme');
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
    const nextCss = cssText || '';
    if (styleEl.textContent !== nextCss) {
      styleEl.textContent = nextCss;
      window.dispatchEvent(new CustomEvent('quivit-css-applied'));
    }
  }
}
