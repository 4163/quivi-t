const tauri = window.__TAURI__ || {};
const invoke = tauri.core?.invoke?.bind(tauri.core);

export const OPTIONS_MAX_INITIAL_W = 560;
export const META_MAX_INITIAL_H = 600;

let fitWidthTail = Promise.resolve();
export function fitContentWidth() {
  if (!invoke) return Promise.resolve();
  fitWidthTail = fitWidthTail.then(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      const tabs = document.querySelector('.tabs');
      let width = OPTIONS_MAX_INITIAL_W;
      if (tabs) {
        const prev = tabs.style.width;
        tabs.style.width = 'fit-content';
        width = tabs.getBoundingClientRect().width;
        tabs.style.width = prev;
        const pad = getComputedStyle(document.body);
        width += parseFloat(pad.paddingLeft || 0) + parseFloat(pad.paddingRight || 0);
        width = Math.ceil(width);
      }
      invoke('fit_options_window', { width: Math.min(width, OPTIONS_MAX_INITIAL_W) }).then(resolve, resolve);
    });
  }));
  return fitWidthTail;
}

let fitHeightTail = Promise.resolve();
export function fitContentHeight() {
  if (!invoke) return Promise.resolve();
  fitHeightTail = fitHeightTail.then(() => new Promise((resolve) => {
    const rootEl = document.getElementById('metadata-root');
    if (!rootEl) return resolve();
    const contentH = rootEl.scrollHeight;
    const targetH = Math.min(contentH, META_MAX_INITIAL_H);
    invoke('fit_metadata_window', { height: targetH }).then(resolve, resolve);
  }));
  return fitHeightTail;
}
