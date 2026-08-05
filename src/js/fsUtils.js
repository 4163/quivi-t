import { Core } from './core.js';
import { DirectoryPrefs } from './directoryPrefs.js';

const { invoke, convertFileSrc } = window.__TAURI__.core;

export const SUPPORTED_IMAGES = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'apng', 'svg', 'bmp', 'ico', 'avif',
]);

export const SUPPORTED_ARCHIVES = new Set(['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7', 'cbt', 'tar']);

function _ext(name) {
  return name.split('.').pop().toLowerCase();
}

// Parent of a file/folder path; normalizes Windows drive roots to "E:\"
function parentOf(path) {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (idx === -1) return path;
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? parent + '\\' : parent;
}

function _formatDate(msStr) {
  if (!msStr) return '';
  const ms = parseInt(msStr, 10);
  if (isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString();
}

function _base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const FsUtils = {
  isArchive(name) { return SUPPORTED_ARCHIVES.has(_ext(name)); },
  isImage(name) { return SUPPORTED_IMAGES.has(_ext(name)); },
  isArchiveEntry(entry) { return entry && !entry.is_dir && this.isArchive(entry.name); },
  isImageEntry(entry) { return entry && !entry.is_dir && this.isImage(entry.name); },

  revokeIfObjectURL(src) {
    if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
  },

  buildArchiveSrc(archivePath, entryName) {
    const encoded = _base64Encode(archivePath);
    const isWindows = navigator.userAgent.includes('Windows');
    const base = isWindows ? 'http://quivit.localhost' : 'quivit://localhost';
    return `${base}/archive/${encoded}/${encodeURIComponent(entryName)}`;
  },

  async buildFileSrc(filePath) {
    if (filePath.toLowerCase().endsWith('.ico') && window.__TAURI__) {
      try {
        return await invoke('get_ico_frames', { path: filePath });
      } catch (e) {
        console.error('Failed to extract ICO frames:', e);
        return convertFileSrc(filePath);
      }
    }
    return convertFileSrc(filePath);
  },

  formatEntry(entry) {
    return {
      ...entry,
      rawDate: entry.date ? parseInt(entry.date, 10) : 0,
      date: _formatDate(entry.date),
    };
  },

  buildDirectoryList(result) {
    const files = result.files.map(this.formatEntry);
    if (result.parent_directory) {
      files.unshift({
        name: '..',
        path: result.parent_directory,
        ext: '',
        date: '',
        rawDate: 0,
        is_dir: true,
        is_parent: true,
      });
    }
    return files;
  },

  buildArchiveList(result) {
    const archivePath = result.archive_path;
    return [
      {
        name: '..',
        path: archivePath,
        ext: '',
        date: '',
        rawDate: 0,
        is_dir: true,
        is_parent: true,
      },
      ...result.files.map(this.formatEntry),
    ];
  },

  firstImageIndex(list, preferredIndex = 0) {
    if (this.isImageEntry(list[preferredIndex])) return preferredIndex;
    const next = list.findIndex(e => this.isImageEntry(e));
    return next === -1 ? 0 : next;
  },

  showHidden() {
    const state = Core.getState();
    return state.config.frontend_data?.show_hidden === true;
  },

  persistLastOpened(path) {
    const state = Core.getState();
    if (state.config.frontend_data.continue_last === false) return;
    state.config.frontend_data.last_opened_path = path;
    Core.persistConfig();
  },

  async applyDirectoryResult(result, options = {}) {
    let files = this.buildDirectoryList(result);
    const prefs = DirectoryPrefs.getSortPrefs(result.directory);
    files = DirectoryPrefs.applySort(files, prefs.col, prefs.desc);

    const state = Core.getState();
    let index = 0;
    if (options.preserveFilename && state.filename) {
      const found = files.findIndex(f => f.name === state.filename);
      if (found !== -1) index = found;
    } else {
      const fd = state.config?.frontend_data || {};
      let preferredIndex = -1;

      // Continue from last active image runs only at startup and always wins.
      if (options.restoreLastImage && fd.remember_last_image && fd.last_active_image && fd.last_active_image.container === result.directory) {
        const targetPath = fd.last_active_image.path;
        preferredIndex = files.findIndex(f => f.path === targetPath);
      }

      if (preferredIndex === -1) {
        const offset = result.parent_directory ? 1 : 0;
        preferredIndex = Math.min(files.length - 1, Math.max(0, result.initial_index + offset));
      }

      // options.preferInitial forces the target entry (e.g. highlight the archive
      // you came back from). options.forceFirstImage forces the first image with a
      // first-item fallback (hidden archive). Otherwise the config decides: ON
      // opens the first image, OFF highlights the target entry.
      if (options.forceFirstImage) {
        const idx = this.firstImageIndex(files, preferredIndex);
        index = idx === 0 && files.length > 1 ? 1 : idx;
      } else if (options.preferInitial || !fd.open_first_image) {
        index = preferredIndex;
      } else {
        index = this.firstImageIndex(files, preferredIndex);
      }
    }

    this.revokeIfObjectURL(state.src);

    Core.setState({
      mode: 'image',
      list: files,
      index,
      directory: result.directory,
      parentDirectory: result.parent_directory || '',
      archivePath: '',
      filename: files[index]?.name || '',
      src: this.isImageEntry(files[index]) ? await this.buildFileSrc(files[index].path) : ''
    });

    if (window.__TAURI__) {
      invoke('watch_directory', { path: result.directory }).catch(err => {
        console.warn('[Core] Failed to watch directory:', err);
      });
    }
  },

  async loadArchive(archivePath, targetPath = '', options = {}) {
    try {
      const result = await invoke('list_archive', { archivePath });
      let files = this.buildArchiveList(result);
      const prefs = DirectoryPrefs.getSortPrefs(result.archive_path);
      files = DirectoryPrefs.applySort(files, prefs.col, prefs.desc);

      const state = Core.getState();
      this.revokeIfObjectURL(state.src);

      let index = 1;
      const fd = state.config?.frontend_data || {};
      let preferredIndex = -1;

      if (targetPath) {
        preferredIndex = files.findIndex(f => f.path === targetPath);
      }

      if (preferredIndex === -1 && options?.restoreLastImage && fd.remember_last_image && fd.last_active_image && fd.last_active_image.container === result.archive_path) {
        const targetPath = fd.last_active_image.path;
        preferredIndex = files.findIndex(f => f.path === targetPath);
      }

      if (preferredIndex !== -1) {
        index = preferredIndex;
      } else if (fd.open_first_image) {
        index = this.firstImageIndex(files, 1);
      }

      Core.setState({
        mode: 'archive',
        list: files,
        index,
        archivePath: result.archive_path,
        directory: '',
        parentDirectory: result.archive_path.replace(/[\\/][^\\/]*$/, ''),
        filename: files[index]?.name || '',
        src: this.isImageEntry(files[index]) ? this.buildArchiveSrc(result.archive_path, files[index].name) : ''
      });
      this.persistLastOpened(result.archive_path);

      // Trigger prefetch for initial load
      this.prefetchAhead(result.archive_path, index, 1);

      return;
    } catch (err) {
      console.error('[Core] Error loading archive:', err);
    }
  },

  async loadFile(pathStr, options = {}) {
    const name = typeof pathStr === 'string'
      ? pathStr.replace(/\\/g, '/').split('/').pop()
      : pathStr.name || '';
    const path = typeof pathStr === 'string' ? pathStr : (pathStr.path || pathStr.name);
    
    if (path === '__DRIVES__') {
      try {
        const drives = await invoke('get_drives');
        const result = {
          directory: 'Drives',
          parent_directory: null,
          initial_index: 0,
          files: drives.map(d => ({ name: d, path: d, ext: '', date: '', is_dir: true, is_drive: true }))
        };
        this.applyDirectoryResult(result);
      } catch (err) {
        console.error('[Core] Failed to load drives:', err);
      }
      return;
    }

    // Composite archive-entry path: "<archive path>|<inner entry name>". Used by
    // favorites saved for images inside archives.
    if (path.includes('|')) {
      const sep = path.indexOf('|');
      const archivePath = path.slice(0, sep);
      if (this.isArchive(archivePath)) {
        await this.loadArchive(archivePath, path);
        return;
      }
    }

    const ext = _ext(name);

    try {
      if (SUPPORTED_ARCHIVES.has(ext)) {
        await this.loadArchive(path, '', options);
        return;
      }

      const result = await invoke('read_directory', { path, showHidden: this.showHidden() });
      this.applyDirectoryResult(result, options);
      this.persistLastOpened(result.directory);

    } catch (err) {
      console.error('[Core] Error loading file:', err);
    }
  },

  async openContainer(delta) {
    const state = Core.getState();
    const currentPath = state.mode === 'archive' ? state.archivePath : state.directory;
    if (!currentPath) return;

    try {
      const path = await invoke('open_sibling_container', {
        currentPath,
        delta,
        showHidden: this.showHidden(),
      });
      await this.loadFile(path);
    } catch (err) {
      console.error('[Core] openContainer error:', err);
    }
  },

  async openParent() {
    const state = Core.getState();
    if (state.mode === 'archive' && state.archivePath) {
      try {
        const result = await invoke('read_directory', { path: state.archivePath, showHidden: this.showHidden() });
        // Land on the archive entry when it's present (so it can be re-opened).
        // If it's missing from the listing (e.g. hidden with "show hidden" off),
        // highlight the first image in the folder, else the first item.
        const archiveListed = result.files.some(f => f.path === state.archivePath);
        if (archiveListed) {
          this.applyDirectoryResult(result, { preferInitial: true });
        } else {
          this.applyDirectoryResult(result, { forceFirstImage: true });
        }
        this.persistLastOpened(result.directory);
      } catch (err) {
        // The archive may have been deleted or moved while open — fall back to its
        // parent folder, or to the drives list if that's unreachable too.
        console.error('[Core] openParent archive error:', err);
        try {
          const result = await invoke('read_directory', { path: parentOf(state.archivePath), showHidden: this.showHidden() });
          this.applyDirectoryResult(result);
          this.persistLastOpened(result.directory);
        } catch (parentErr) {
          console.error('[Core] openParent archive parent fallback error:', parentErr);
          const drives = await invoke('get_drives');
          this.applyDirectoryResult({
            directory: 'Drives',
            parent_directory: null,
            initial_index: 0,
            files: drives.map(d => ({ name: d, path: d, ext: '', date: '', is_dir: true, is_drive: true }))
          });
        }
      }
      return;
    }

    if (!state.directory || state.directory === 'Drives') return;
    try {
      const result = await invoke('open_parent', { currentDir: state.directory, showHidden: this.showHidden() });
      // Config handled inside applyDirectoryResult: open_first_image (ON) opens
      // the first image, OFF (default) highlights the folder we came from.
      this.applyDirectoryResult(result);
      this.persistLastOpened(result.directory);
    } catch (err) {
      if (err === 'Already at root') {
        try {
          const drives = await invoke('get_drives');
          const drivesResult = {
            directory: 'Drives',
            parent_directory: null,
            initial_index: 0,
            files: drives.map(d => ({ name: d, path: d, ext: '', date: '', is_dir: true, is_drive: true }))
          };
          this.applyDirectoryResult(drivesResult);
        } catch (driveErr) {
          console.error('[Core] Error fetching drives:', driveErr);
        }
      } else {
        console.error('[Core] openParent error:', err);
      }
    }
  },

  async openSibling(delta) {
    const state = Core.getState();
    const currentPath = state.mode === 'archive' ? state.archivePath : state.directory;
    if (!currentPath || currentPath === 'Drives') return;

    try {
      const parent = parentOf(currentPath);
      const atRoot = parent === currentPath;

      let containers = [];
      let prefsPath = parent;

      if (atRoot) {
        const drives = await invoke('get_drives');
        containers = drives.map(d => ({ name: d, path: d, ext: '', date: '', rawDate: 0, is_dir: true, is_drive: true }));
        prefsPath = null;
      } else {
        const result = await invoke('read_directory', { path: parent, showHidden: this.showHidden() });
        containers = result.files.filter(f => f.is_dir || this.isArchive(f.name)).map(e => this.formatEntry(e));
      }

      if (containers.length === 0) {
        console.error('[Core] openSibling: no sibling folders or archives found');
        return;
      }

      const prefs = DirectoryPrefs.getSortPrefs(prefsPath);
      const sorted = DirectoryPrefs.applySort(containers, prefs.col, prefs.desc);

      const currentIdx = sorted.findIndex(f => f.path === currentPath);
      if (currentIdx === -1) {
        console.error('[Core] openSibling: current folder/archive not found among siblings');
        return;
      }

      const newIdx = ((currentIdx + delta) % sorted.length + sorted.length) % sorted.length;
      await this.loadFile(sorted[newIdx].path);
    } catch (err) {
      console.error('[Core] openSibling error:', err);
    }
  },

  async openDirectoryDialog() {
    try {
      const { open } = window.__TAURI__.dialog;
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        await this.loadFile(selected);
      }
    } catch (err) {
      console.error('[Core] Dialog error:', err);
    }
  },

  async openFileDialog() {
    try {
      const { open } = window.__TAURI__.dialog;
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Images and archives',
            extensions: [...SUPPORTED_IMAGES, ...SUPPORTED_ARCHIVES],
          },
          {
            name: 'Images',
            extensions: [...SUPPORTED_IMAGES],
          },
          {
            name: 'Archives',
            extensions: [...SUPPORTED_ARCHIVES],
          },
        ],
      });
      if (selected) {
        await this.loadFile(selected);
      }
    } catch (err) {
      console.error('[Core] File Dialog error:', err);
    }
  },

  async refresh() {
    const state = Core.getState();
    if (state.mode === 'archive' && state.archivePath) {
      try {
        await this.loadFile(state.archivePath);
      } catch (err) {
        console.error('[Core] refresh error:', err);
      }
    } else if (state.directory) {
      try {
        const result = await invoke('read_directory', { path: state.directory, showHidden: this.showHidden() });
        this.applyDirectoryResult(result, { preserveFilename: true });
      } catch (err) {
        console.error('[Core] refresh error:', err);
      }
    }
  },

  prefetchAhead(archivePath, currentIndex, direction = 1) {
    const state = Core.getState();
    const files = state.list;
    if (!files || files.length === 0 || state.mode !== 'archive' || state.archivePath !== archivePath) return;

    const indicesToPrefetch = [];
    
    // Warm current entry
    if (currentIndex >= 0 && currentIndex < files.length && this.isImageEntry(files[currentIndex])) {
      indicesToPrefetch.push(files[currentIndex].name);
    }

    // 7 ahead
    for (let i = 1; i <= 7; i++) {
      let idx = currentIndex + (direction * i);
      if (idx >= 0 && idx < files.length && this.isImageEntry(files[idx])) {
        indicesToPrefetch.push(files[idx].name);
      }
    }
    // 3 behind
    for (let i = 1; i <= 3; i++) {
      let idx = currentIndex - (direction * i);
      if (idx >= 0 && idx < files.length && this.isImageEntry(files[idx])) {
        indicesToPrefetch.push(files[idx].name);
      }
    }

    if (indicesToPrefetch.length > 0) {
      invoke('prefetch_archive_entries', { 
        archivePath: archivePath, 
        entries: indicesToPrefetch 
      }).catch(err => console.warn('[Prefetch] Error:', err));
    }
  }
};
