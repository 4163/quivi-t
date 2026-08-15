let _lastTitle = '';

function updateWindowTitle(state, FsUtils) {
  if (!window.__TAURI__) return;
  const win = window.__TAURI__.window?.getCurrentWindow?.();
  if (!win?.setTitle) return;

  let title = 'QuiviT';
  if (state.mode !== 'empty' && state.src) {
    const pos = FsUtils.naturalPagePosition(state.list, state.filename);
    const page = pos && pos.total > 1 ? ` (${pos.current}/${pos.total})` : '';
    if (state.mode === 'archive' && state.archivePath) {
      const name = FsUtils.basename(state.archivePath);
      if (name) title = `${state.filename}${page} ◦ ${name} ◦ QuiviT`;
    } else {
      title = `${state.filename}${page} ◦ QuiviT`;
    }
  }

  if (title !== _lastTitle) {
    _lastTitle = title;
    win.setTitle(title).catch(() => {});
  }
}

export function initLifecycle({ Core, FsUtils }) {
  Core.onStateChange((state) => {
    updateWindowTitle(state, FsUtils);
  });

  if (window.__TAURI__) {
    const { listen } = window.__TAURI__.event;

    let watchTimer = null;
    listen('directory-changed', () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        FsUtils.refresh();
      }, 500);
    }).catch(console.error);

    listen('single-instance-open', (e) => {
      if (e.payload) {
        FsUtils.loadFile(e.payload, { preferInitial: true, restoreLastImage: false }).catch(console.error);
      }
    });

    const mainWindow = window.__TAURI__.window.getCurrentWindow();
    let closingAfterFlush = false;
    mainWindow.onCloseRequested(async (event) => {
      if (closingAfterFlush) return;
      event.preventDefault();
      try {
        await Core.flushConfig();
      } catch (err) {
        console.error('[Main] Failed to flush config on exit:', err);
      }
      closingAfterFlush = true;
      await mainWindow.close();
    });
  }
}
