export function applyTheme(theme) {
  document.documentElement.removeAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function applyCustomCss(cssText) {
  let styleEl = document.getElementById('custom-css');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'custom-css';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = cssText || '';
}
