const tauri = window.__TAURI__ || {};
const emit = tauri.event?.emit?.bind(tauri.event);

export let previewing = false;

export function setPreviewing(val) {
  previewing = val;
}

export async function revertPreviewChanges(savedTheme, savedCss) {
  if (!previewing) return;
  previewing = false;
  if (emit) {
    await Promise.all([emit('theme-preview', savedTheme), emit('css-preview', savedCss)]);
  }
}

export function previewTheme(theme) {
  previewing = true;
  if (emit) emit('theme-preview', theme);
}

export function previewCss(css) {
  previewing = true;
  if (emit) emit('css-preview', css);
}

export function resetPreviewCss() {
  previewing = true;
  if (emit) emit('css-preview', '');
}

export async function emergencyCssReset(config) {
  previewing = false;
  localStorage.removeItem('quivit-custom-css');
  resetPreviewCss();
  if (config && config.frontend_data) {
    config.frontend_data.custom_css = "";
    if (window.__TAURI__?.core?.invoke) {
      try {
        await window.__TAURI__.core.invoke('save_config', { config });
        if (emit) emit('config-updated');
      } catch (err) {
        console.error('Failed emergency reset save:', err);
      }
    }
  }
  window.location.reload();
}
