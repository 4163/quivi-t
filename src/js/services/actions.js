/**
 * actions.js: central registry for user commands and shortcuts.
 */

export const ACTION_REGISTRY = [
  // Navigation
  { id: 'cmd-next', label: 'Next Item', defaultBinds: ['Shift+d', 'Shift+ArrowRight', 'Shift+s', 'Shift+ArrowDown'], category: 'Navigation',
    run: (ctx) => {
      if (ctx.isFavoritesFocused?.()) ctx.navigateHighlightedFavorite(1);
      else ctx.Core.navigate(1);
    }
  },
  { id: 'cmd-prev', label: 'Previous Item', defaultBinds: ['Shift+a', 'Shift+ArrowLeft', 'Shift+w', 'Shift+ArrowUp'], category: 'Navigation',
    run: (ctx) => {
      if (ctx.isFavoritesFocused?.()) ctx.navigateHighlightedFavorite(-1);
      else ctx.Core.navigate(-1);
    }
  },
  { id: 'cmd-history-back', label: 'History Back', defaultBinds: ['Alt+a', 'Alt+w', 'Alt+ArrowLeft', 'Alt+ArrowUp', 'MouseBack'], category: 'Navigation',
    run: (ctx) => {
      const entry = ctx.NavigationHistory.goBack(ctx.Core.getState());
      if (entry) ctx.FsUtils.loadHistoryEntry(entry).catch(console.error);
    }
  },
  { id: 'cmd-history-forward', label: 'History Forward', defaultBinds: ['Alt+d', 'Alt+s', 'Alt+ArrowRight', 'Alt+ArrowDown', 'MouseForward'], category: 'Navigation',
    run: (ctx) => {
      const entry = ctx.NavigationHistory.goForward(ctx.Core.getState());
      if (entry) ctx.FsUtils.loadHistoryEntry(entry).catch(console.error);
    }
  },
  { id: 'cmd-parent', label: 'Open Parent Folder', defaultBinds: 'Backspace', category: 'Navigation',
    run: (ctx) => ctx.FsUtils.openParent()
  },
  { id: 'cmd-open-next-container', label: 'Open Next Folder/Archive', defaultBinds: 'Ctrl+x', category: 'Navigation',
    run: (ctx) => ctx.FsUtils.openSibling(1)
  },
  { id: 'cmd-open-prev-container', label: 'Open Previous Folder/Archive', defaultBinds: 'Ctrl+z', category: 'Navigation',
    run: (ctx) => ctx.FsUtils.openSibling(-1)
  },
  
  // View
  { id: 'cmd-fit-none', label: 'Fit None', defaultBinds: ['r', 'DoubleClick'], category: 'View',
    run: (ctx) => ctx.Core.setFitMode('none', { persist: true })
  },
  { id: 'cmd-fit-width', label: 'Fit Width', defaultBinds: 'Shift+q', category: 'View',
    run: (ctx) => ctx.Core.setFitMode('width', { persist: true })
  },
  { id: 'cmd-fit-height', label: 'Fit Height', defaultBinds: 'Shift+e', category: 'View',
    run: (ctx) => ctx.Core.setFitMode('height', { persist: true })
  },
  { id: 'cmd-fit-best', label: 'Fit Window', description: 'Scale to fit entirely within the viewport, stretching small images', defaultBinds: 'Shift+f', category: 'View',
    run: (ctx) => ctx.Core.setFitMode('window', { persist: true })
  },
  { id: 'cmd-fit-width-if-larger', label: 'Fit Width If Larger', defaultBinds: 'q', category: 'View',
    run: (ctx) => ctx.Core.setFitMode('width-if-larger', { persist: true })
  },
  { id: 'cmd-fit-height-if-larger', label: 'Fit Height If Larger', defaultBinds: 'e', category: 'View',
    run: (ctx) => ctx.Core.setFitMode('height-if-larger', { persist: true })
  },
  { id: 'cmd-fit-window-if-larger', label: 'Fit Window If Larger', description: 'Shrink to fit the viewport, but never enlarge small images', defaultBinds: 'f', category: 'View',
    run: (ctx) => ctx.Core.setFitMode('window-if-larger', { persist: true })
  },
  { id: 'cmd-scale-none', label: 'Scale Pixelated', defaultBinds: [], category: 'View',
    run: (ctx) => ctx.Core.setScalingMode('none', { persist: true })
  },
  { id: 'cmd-scale-bilinear', label: 'Scale Bilinear', defaultBinds: [], category: 'View',
    run: (ctx) => ctx.Core.setScalingMode('bilinear', { persist: true })
  },
  { id: 'cmd-scale-lanczos', label: 'Scale Lanczos', defaultBinds: [], category: 'View',
    run: (ctx) => ctx.Core.setScalingMode('lanczos', { persist: true })
  },
  { id: 'cmd-scale-anime4k', label: 'Scale Anime4K', defaultBinds: [], category: 'View',
    run: (ctx) => ctx.Core.setScalingMode('anime4k', { persist: true })
  },
  { id: 'cmd-toggle-crt-filter', label: 'Toggle Retro CRT Filter', defaultBinds: [], category: 'View',
    run: (ctx) => {
      const state = ctx.Core.getState();
      state.config.frontend_data.crt_filter = !state.config.frontend_data.crt_filter;
      ctx.Core.persistConfig();
      ctx.Core.setState({});
    }
  },
  { id: 'cmd-cycle-scaling-back', label: 'Scale: Previous', defaultBinds: '[', category: 'View',
    run: (ctx) => {
      const modes = ['none', 'bilinear', 'lanczos', 'anime4k'];
      const current = ctx.Core.getState().scalingMode;
      const idx = modes.indexOf(current);
      const next = idx > 0 ? modes[idx - 1] : modes[modes.length - 1];
      ctx.Core.setScalingMode(next, { persist: true });
    }
  },
  { id: 'cmd-cycle-scaling', label: 'Scale: Next', defaultBinds: ']', category: 'View',
    run: (ctx) => {
      const modes = ['none', 'bilinear', 'lanczos', 'anime4k'];
      const current = ctx.Core.getState().scalingMode;
      const next = modes[(modes.indexOf(current) + 1) % modes.length];
      ctx.Core.setScalingMode(next, { persist: true });
    }
  },
  { id: 'cmd-toggle-transparent', label: 'Opaque Canvas', defaultBinds: [], category: 'View',
    run: (ctx) => ctx.Core.toggleTransparentBg()
  },
  
  // Zoom
  { id: 'cmd-zoom-in', label: 'Zoom In', defaultBinds: ['c', 'Ctrl+ScrollUp'], category: 'Zoom',
    run: (ctx, payload) => {
      if (payload?.wheel) ctx.Viewer.zoomAt(1, payload.clientX, payload.clientY);
      else ctx.Viewer.zoomCenter(1);
    }
  },
  { id: 'cmd-zoom-out', label: 'Zoom Out', defaultBinds: ['z', 'Ctrl+ScrollDown'], category: 'Zoom',
    run: (ctx, payload) => {
      if (payload?.wheel) ctx.Viewer.zoomAt(-1, payload.clientX, payload.clientY);
      else ctx.Viewer.zoomCenter(-1);
    }
  },
  { id: 'cmd-zoom-100', label: 'Zoom 100%', defaultBinds: 'x', category: 'Zoom',
    run: (ctx) => ctx.Viewer.setZoom(1)
  },

  // Pan
  { id: 'cmd-pan-drag', label: 'Pan (Drag)', defaultBinds: ['MouseLeft', 'MouseMiddle', 'Space'], category: 'Pan',
    run: () => {} // Handled purely by gestures
  },
  { id: 'cmd-pan-up', label: 'Pan Up', defaultBinds: ['w', 'ArrowUp', 'ScrollUp'], category: 'Pan',
    run: (ctx, payload) => {
      const step = payload?.wheel ? ctx.wheelPanStep : ctx.keyboardPanStep;
      ctx.Viewer.panBy(0, step);
    }
  },
  { id: 'cmd-pan-left', label: 'Pan Left', defaultBinds: ['a', 'ArrowLeft', 'Shift+ScrollUp'], category: 'Pan',
    run: (ctx, payload) => {
      const step = payload?.wheel ? ctx.wheelPanStep : ctx.keyboardPanStep;
      ctx.Viewer.panBy(step, 0);
    }
  },
  { id: 'cmd-pan-down', label: 'Pan Down', defaultBinds: ['s', 'ArrowDown', 'ScrollDown'], category: 'Pan',
    run: (ctx, payload) => {
      const step = payload?.wheel ? ctx.wheelPanStep : ctx.keyboardPanStep;
      ctx.Viewer.panBy(0, -step);
    }
  },
  { id: 'cmd-pan-right', label: 'Pan Right', defaultBinds: ['d', 'ArrowRight', 'Shift+ScrollDown'], category: 'Pan',
    run: (ctx, payload) => {
      const step = payload?.wheel ? ctx.wheelPanStep : ctx.keyboardPanStep;
      ctx.Viewer.panBy(-step, 0);
    }
  },

  // Rotation
  { id: 'cmd-rotate-ccw', label: 'Rotate Counter-clockwise', defaultBinds: 'g', category: 'Rotation',
    run: (ctx) => ctx.Viewer.rotate(-90)
  },
  { id: 'cmd-rotate-cw', label: 'Rotate Clockwise', defaultBinds: 'h', category: 'Rotation',
    run: (ctx) => ctx.Viewer.rotate(90)
  },
  { id: 'cmd-flip-horizontal', label: 'Flip Horizontal', defaultBinds: 'v', category: 'Rotation',
    run: (ctx) => ctx.Viewer.flipHorizontal()
  },
  { id: 'cmd-flip-vertical', label: 'Flip Vertical', defaultBinds: 'b', category: 'Rotation',
    run: (ctx) => ctx.Viewer.flipVertical()
  },

  // Window & UI
  { id: 'cmd-options', label: 'Open Options', defaultBinds: '5', category: 'Window & UI',
    run: async () => {
      if (window.__TAURI__) await window.__TAURI__.core.invoke('open_options').catch(console.error);
    }
  },
  { id: 'cmd-toggle-filelist', label: 'Toggle File List', defaultBinds: '1', category: 'Window & UI',
    run: (ctx) => {
      const visible = !ctx.Core.getState().fileListVisible;
      ctx.Core.setFileListVisible(visible);
      document.getElementById('cmd-toggle-filelist')?.classList.toggle('checked', visible);
    }
  },
  { id: 'cmd-toggle-menubar', label: 'Toggle Menu Bar', defaultBinds: '2', category: 'Window & UI',
    run: (ctx) => ctx.Chrome.toggleMenuBar()
  },
  { id: 'cmd-toggle-statusbar', label: 'Toggle Status Bar', defaultBinds: '3', category: 'Window & UI',
    run: (ctx) => ctx.Chrome.toggleStatusBar()
  },
  { id: 'cmd-fullscreen', label: 'Toggle Fullscreen', defaultBinds: ['4', 'Alt+Enter'], category: 'Window & UI',
    run: (ctx) => ctx.toggleFullscreen()
  },
  { id: 'cmd-exit-fullscreen-hold', label: 'Exit Fullscreen (Hold)', defaultBinds: 'Escape', category: 'Window & UI',
    run: () => {} // Handled purely by fullscreen gestures
  },
  { id: 'cmd-quit', label: 'Quit', defaultBinds: [], category: 'Window & UI',
    run: async () => {
      if (window.__TAURI__) {
        // Triggers the onCloseRequested handler in main.js which flushes config then closes.
        await window.__TAURI__.window.getCurrentWindow().close();
      } else window.close();
    }
  },
  { id: 'cmd-github', label: 'GitHub Repository', defaultBinds: [],
    run: async () => {
      const url = 'https://github.com/4163/quivi-t';
      if (window.__TAURI__?.opener?.openUrl) {
        await window.__TAURI__.opener.openUrl(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    }
  },

  // Files & Folders
  { id: 'cmd-open-dir', label: 'Open Directory', defaultBinds: 'Ctrl+o', category: 'Files & Folders',
    run: (ctx) => ctx.FsUtils.openDirectoryDialog()
  },
  { id: 'cmd-open-file', label: 'Open File/Archive', defaultBinds: 'Ctrl+Shift+o', category: 'Files & Folders',
    run: (ctx) => ctx.FsUtils.openFileDialog()
  },
  { id: 'cmd-refresh', label: 'Refresh Directory', defaultBinds: ['6', 'Ctrl+r'], category: 'Files & Folders',
    run: (ctx) => ctx.FsUtils.refresh()
  },

  // File Operations
  { id: 'cmd-open-explorer', label: 'Reveal in File Explorer', defaultBinds: [], category: 'File Operations',
    run: async (ctx) => {
      const state = ctx.Core.getState();
      if (!window.__TAURI__) return;
      const favorite = ctx.getHighlightedFavorite();
      if (favorite) {
        try {
          if (favorite.is_drive) {
            await window.__TAURI__.core.invoke('open_in_explorer', { path: favorite.path });
          } else {
            const sep = favorite.path.indexOf('|');
            const realPath = sep === -1 ? favorite.path : favorite.path.slice(0, sep);
            await window.__TAURI__.opener.revealItemInDir(realPath);
          }
        } catch (err) {
          console.error('[Action] Failed to open explorer:', err);
        }
        return;
      }
      const entry = state.list[state.index];
      if (!entry) {
        if (state.directory) {
          try {
            await window.__TAURI__.core.invoke('open_in_explorer', { path: state.directory });
          } catch (err) {
            console.error('[Action] Failed to open explorer:', err);
          }
        }
        return;
      }
      try {
        if (entry.is_parent) {
          await window.__TAURI__.core.invoke('open_in_explorer', { path: state.directory });
        } else {
          const sep = entry.path.indexOf('|');
          const realPath = sep === -1 ? entry.path : entry.path.slice(0, sep);
          await window.__TAURI__.opener.revealItemInDir(realPath);
        }
      } catch (err) {
        console.error('[Action] Failed to open explorer:', err);
      }
    }
  },
  { id: 'cmd-open-folder', label: 'Open Folder in Explorer', defaultBinds: [], category: 'File Operations',
    run: async (ctx) => {
      const state = ctx.Core.getState();
      if (!window.__TAURI__) return;
      const favorite = ctx.getHighlightedFavorite();
      if (favorite) {
        try {
          let targetPath;
          if (favorite.is_dir || favorite.is_drive) {
            targetPath = favorite.path;
          } else {
            const sep = favorite.path.indexOf('|');
            const realPath = sep === -1 ? favorite.path : favorite.path.slice(0, sep);
            targetPath = realPath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
          }
          await window.__TAURI__.core.invoke('open_in_explorer', { path: targetPath });
        } catch (err) {
          console.error('[Action] Failed to open folder:', err);
        }
        return;
      }
      const entry = state.list[state.index];
      let targetPath = state.directory;

      if (entry) {
        if (entry.is_dir || entry.is_parent) {
          targetPath = entry.path;
        } else {
          const sep = entry.path.indexOf('|');
          if (sep !== -1) {
            const realPath = entry.path.slice(0, sep);
            targetPath = realPath.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
          }
        }
      }
      try {
        await window.__TAURI__.core.invoke('open_in_explorer', { path: targetPath });
      } catch (err) {
        console.error('[Action] Failed to open folder:', err);
      }
    }
  },
  { id: 'cmd-toggle-favorite', label: 'Toggle Favorite', defaultBinds: [], category: 'File Operations',
    run: (ctx) => ctx.toggleFavoriteCurrent()
  },
  { id: 'cmd-open-metadata', label: 'Open Metadata', defaultBinds: [], category: 'File Operations',
    run: (ctx) => ctx.openMetadataWindow()
  }
];

export const CATEGORIES = [];
export const DEFAULT_KEYBINDS = {};

// Build categories, default keybinds, and the O(1) dispatch map from ACTION_REGISTRY.
const categoryMap = {};
for (const action of ACTION_REGISTRY) {
  DEFAULT_KEYBINDS[action.id] = Array.isArray(action.defaultBinds) ? action.defaultBinds : [action.defaultBinds];

  if (action.category) {
    if (!categoryMap[action.category]) {
      categoryMap[action.category] = { name: action.category, actions: [] };
      CATEGORIES.push(categoryMap[action.category]);
    }
    categoryMap[action.category].actions.push({ id: action.id, label: action.label, description: action.description });
  }
}
const ACTION_MAP = new Map(ACTION_REGISTRY.map(a => [a.id, a]));

/**
 * Dispatches an action by ID, looking it up in the registry.
 * @param {string} actionId 
 * @param {any} payload Context payload from the event (e.g., wheel direction)
 * @param {Object} ctx Dependencies injected from main.js
 */
export async function dispatch(actionId, payload, ctx) {
  const action = ACTION_MAP.get(actionId);
  if (action?.run) await action.run(ctx, payload);
}
