export function applyTheme(theme) {
  document.documentElement.removeAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function applyCustomCss(cssText) {
  const styleEl = document.getElementById('custom-css');
  if (styleEl) {
    styleEl.textContent = cssText || '';
    window.dispatchEvent(new CustomEvent('quivit-css-applied'));
  }
}
