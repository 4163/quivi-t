import { Core } from './core.js';
import { DirectoryPrefs } from './directoryPrefs.js';
import { createHistoryEntry, recordNavigation } from './navigationHistory.js';

const { invoke, convertFileSrc } = window.__TAURI__.core;

export const SUPPORTED_IMAGES = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'apng', 'svg', 'bmp', 'ico', 'avif',
]);

export const SUPPORTED_ARCHIVES = new Set(['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7', 'cbt', 'tar']);

function _ext(name) {
  return name.split('.').pop().toLowerCase();
}

let _navigationGeneration = 0;
let _archivePrefetchTimer = null;
let _archivePrefetchSeq = 0;

function _nextNavigationGeneration() {
  _navigationGeneration += 1;
  return _navigationGeneration;
}

function _isCurrentGeneration(generation) {
  return generation === undefined || generation === _navigationGeneration;
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

function _basename(path) {
  return String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

export const FsUtils = {
  isArchive(name) { return SUPPORTED_ARCHIVES.has(_ext(name)); },
  isImage(name) { return SUPPORTED_IMAGES.has(_ext(name)); },
  isIco(name) { return _ext(name) === 'ico'; },
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

  async buildArchiveEntrySrc(archivePath, entryName) {
    if (this.isIco(entryName) && window.__TAURI__) {
      try {
        return await invoke('get_archive_ico_frames', { archivePath, entryName });
      } catch (e) {
        console.error('Failed to extract archive ICO frames:', e);
      }
    }
    return this.buildArchiveSrc(archivePath, entryName);
  },

  async buildFileSrc(filePath) {
    if (filePath.startsWith('blob:')) return filePath;
    if (this.isIco(filePath) && window.__TAURI__) {
      try {
        return await invoke('get_ico_frames', { path: filePath });
      } catch (e) {
        console.error('Failed to extract ICO frames:', e);
      }
    }
    return window.__TAURI__.core.convertFileSrc(filePath);
  },

  // Synchronous variant for the DOM image pool; ICO files need async
  // processing so they are excluded and handled via the async path.
  buildFileSrcSync(filePath) {
    if (filePath.startsWith('blob:')) return filePath;
    return window.__TAURI__.core.convertFileSrc(filePath);
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

  // Sort-independent page position of an image: among images only, in natural
  // ascending filename order (matching the app's default Name sort), regardless
  // of the active sort column/direction. Returns { current, total } (1-based)
  // or null when the filename isn't an image / isn't in the list.
  naturalPagePosition(list, filename) {
    if (!Array.isArray(list) || !filename) return null;
    const images = list.filter(e => this.isImageEntry(e));
    if (!images.length) return null;
    const sorted = [...images].sort((a, b) =>
      DirectoryPrefs.naturalCompare(a.name.toLowerCase(), b.name.toLowerCase()));
    const idx = sorted.findIndex(e => e.name === filename);
    if (idx === -1) return null;
    return { current: idx + 1, total: sorted.length };
  },

  // Statusbar index — legacy counting (folders/archives/files all count) with
  // the '..' parent row excluded from both numerator and denominator. '..' is
  // always list[0] when present.
  formatStatusIndex(state) {
    if (!state || !Array.isArray(state.list) || state.list.length < 2) return '';
    const hasParent = state.list[0]?.name === '..' ? 1 : 0;
    return `${state.index + 1 - hasParent} / ${state.list.length - hasParent}`;
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
    if (!_isCurrentGeneration(options.generation)) return;

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

      if (preferredIndex === -1 && options.targetPath) {
        preferredIndex = files.findIndex(f => f.path === options.targetPath);
      }

      if (preferredIndex === -1 && options.targetName) {
        preferredIndex = files.findIndex(f => f.name === options.targetName);
      }

      if (preferredIndex === -1 && result.target_filename) {
        // Find by name after sorting — initial_index is stale if sort order differs
        preferredIndex = files.findIndex(f => f.name === result.target_filename);
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

    const selectedSrc = this.isImageEntry(files[index]) ? await this.buildFileSrc(files[index].path) : '';
    if (!_isCurrentGeneration(options.generation)) return;

    Core.setState({
      mode: 'image',
      list: files,
      index,
      directory: result.directory,
      parentDirectory: result.parent_directory || '',
      archivePath: '',
      filename: files[index]?.name || '',
      src: selectedSrc,
    });
    recordNavigation(options.previousEntry, Core.getState(), options);

    if (window.__TAURI__) {
      invoke('watch_directory', { path: result.directory }).catch(err => {
        console.warn('[Core] Failed to watch directory:', err);
      });
    }
  },

  async loadFallbackAncestor(path, options = {}) {
    let current = path;
    while (true) {
      const parent = parentOf(current);
      if (parent === current) {
        return this.loadFile('__DRIVES__', options);
      }
      try {
        return await this.loadFile(parent, options);
      } catch (err) {
        console.error(`[Core] Fallback load failed for ${parent}, walking up...`, err);
        current = parent;
      }
    }
  },

  async loadArchive(archivePath, targetPath = '', options = {}) {
    if (options.generation === undefined) {
      options = { ...options, generation: _nextNavigationGeneration() };
    }

    try {
      const result = await invoke('list_archive', { archivePath });
      if (!_isCurrentGeneration(options.generation)) return;

      const metaFiles = result.files.filter(f => /\.(xml|opf)$/i.test(f.name)).map(f => f.name);
      const imgFiles = result.files.filter(f => !/\.(xml|opf)$/i.test(f.name));

      let files = this.buildArchiveList({ ...result, files: imgFiles });
      const prefs = DirectoryPrefs.getSortPrefs(result.archive_path);
      files = DirectoryPrefs.applySort(files, prefs.col, prefs.desc);

      const state = Core.getState();
      this.revokeIfObjectURL(state.src);

      let index = 1;
      const fd = state.config?.frontend_data || {};
      let preferredIndex = -1;

      if (targetPath) {
        preferredIndex = files.findIndex(f => f.path === targetPath);
        // Also try matching by entry name (used by refresh/targetName)
        if (preferredIndex === -1) {
          preferredIndex = files.findIndex(f => f.name === targetPath);
        }
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

      const selectedSrc = this.isImageEntry(files[index])
        ? await this.buildArchiveEntrySrc(result.archive_path, files[index].name)
        : '';
      if (!_isCurrentGeneration(options.generation)) return;

      Core.setState({
        mode: 'archive',
        list: files,
        index,
        archivePath: result.archive_path,
        archiveMetadataFiles: metaFiles,
        directory: '',
        parentDirectory: result.archive_path.replace(/[\\/][^\\/]*$/, ''),
        filename: files[index]?.name || '',
        src: selectedSrc
      });
      recordNavigation(options.previousEntry, Core.getState(), options);
      if (!_isCurrentGeneration(options.generation)) return;
      this.persistLastOpened(result.archive_path);

      // Trigger prefetch for initial load
      this.prefetchAhead(result.archive_path, index, 1);

      return;
    } catch (err) {
      if (options.isStartup) {
        console.error(`[Core] Startup loadArchive failed for ${archivePath}, falling back:`, err);
        return this.loadFallbackAncestor(archivePath, options);
      }
      if (_isCurrentGeneration(options.generation)) {
        const state = Core.getState();
        this.revokeIfObjectURL(state.src);
        Core.setState({
          mode: state.mode === 'empty' ? 'image' : state.mode,
          src: '',
          filename: `Failed to open archive: ${_basename(archivePath) || archivePath}`,
        });
      }
      throw err;
    }
  },

  async loadFile(pathStr, options = {}) {
    if (options.generation === undefined) {
      options = { ...options, generation: _nextNavigationGeneration() };
    }
    if (options.previousEntry === undefined) {
      options = { ...options, previousEntry: createHistoryEntry(Core.getState()) };
    }

    const name = typeof pathStr === 'string'
      ? pathStr.replace(/\\/g, '/').split('/').pop()
      : pathStr.name || '';
    let path = typeof pathStr === 'string' ? pathStr : (pathStr.path || pathStr.name);

    // Windows CLSID paths (e.g. 'This PC') → route to drive list
    if (path && path.startsWith('::{')) {
      path = '__DRIVES__';
    }
    
    if (path === '__DRIVES__') {
      try {
        const drives = await invoke('get_drives');
        if (!_isCurrentGeneration(options.generation)) return;
        const result = {
          directory: 'Drives',
          parent_directory: null,
          initial_index: 0,
          files: drives.map(d => ({ name: d, path: d, ext: '', date: '', is_dir: true, is_drive: true }))
        };
        this.applyDirectoryResult(result, options);
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
        await this.loadArchive(archivePath, path, options);
        return;
      }
    }

    const ext = _ext(name);

    try {
      if (SUPPORTED_ARCHIVES.has(ext)) {
        return this.loadArchive(path, options.targetName || options.targetPath || '', options);
      } else {
        const result = await invoke('read_directory', { path, showHidden: this.showHidden(), targetName: options.targetName });
        if (!_isCurrentGeneration(options.generation)) return;
        this.applyDirectoryResult(result, options);
        this.persistLastOpened(result.directory);
      }
    } catch (err) {
      if (options.isStartup) {
        console.error(`[Core] Startup loadFile failed for ${path}, falling back:`, err);
        return this.loadFallbackAncestor(path, options);
      }
      throw err;
    }
  },

  async openContainer(delta) {
    const generation = _nextNavigationGeneration();
    const state = Core.getState();
    const currentPath = state.mode === 'archive' ? state.archivePath : state.directory;
    if (!currentPath) return;

    try {
      const path = await invoke('open_sibling_container', {
        currentPath,
        delta,
        showHidden: this.showHidden(),
      });
      if (!_isCurrentGeneration(generation)) return;
      await this.loadFile(path, { generation });
    } catch (err) {
      console.error('[Core] openContainer error:', err);
    }
  },

  async openParent() {
    const generation = _nextNavigationGeneration();
    const state = Core.getState();
    const previousEntry = createHistoryEntry(state);
    if (state.mode === 'archive' && state.archivePath) {
      try {
        const result = await invoke('read_directory', { path: state.archivePath, showHidden: this.showHidden() });
        if (!_isCurrentGeneration(generation)) return;
        // Land on the archive entry when it's present (so it can be re-opened).
        // If it's missing from the listing (e.g. hidden with "show hidden" off),
        // highlight the first image in the folder, else the first item.
        const archiveListed = result.files.some(f => f.path === state.archivePath);
        if (archiveListed) {
          this.applyDirectoryResult(result, { preferInitial: true, generation, previousEntry });
        } else {
          this.applyDirectoryResult(result, { forceFirstImage: true, generation, previousEntry });
        }
        this.persistLastOpened(result.directory);
      } catch (err) {
        console.error('[Core] openParent archive error, falling back:', err);
        await this.loadFallbackAncestor(state.archivePath, { generation, previousEntry });
      }
      return;
    }

    if (!state.directory || state.directory === 'Drives') return;
    try {
      const result = await invoke('open_parent', { currentDir: state.directory, showHidden: this.showHidden() });
      if (!_isCurrentGeneration(generation)) return;
      // Highlight the folder we came from (same behavior as archives)
      this.applyDirectoryResult(result, { preferInitial: true, generation, previousEntry });
      this.persistLastOpened(result.directory);
    } catch (err) {
      if (err === 'Already at root') {
        await this.loadFile('__DRIVES__', { generation, previousEntry });
      } else {
        console.error('[Core] openParent error, falling back:', err);
        await this.loadFallbackAncestor(state.directory, { generation, previousEntry });
      }
    }
  },

  async openSibling(delta) {
    const generation = _nextNavigationGeneration();
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

      if (!_isCurrentGeneration(generation)) return;

      let attempts = 0;
      let currentIndexToCheck = currentIdx;

      while (attempts < sorted.length) {
        currentIndexToCheck = ((currentIndexToCheck + delta) % sorted.length + sorted.length) % sorted.length;
        
        // If we wrapped all the way back to the current item, there are no valid alternatives.
        if (currentIndexToCheck === currentIdx) break;

        try {
          await this.loadFile(sorted[currentIndexToCheck].path, { generation });
          return; // Successfully loaded a sibling, exit loop
        } catch (err) {
          console.error(`[Core] Skipping inaccessible sibling container: ${sorted[currentIndexToCheck].path}`, err);
          attempts++;
        }
      }

      console.error('[Core] openSibling error: All other sibling containers are inaccessible or corrupted.');
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
        await this.loadFile(selected, { preferInitial: true, restoreLastImage: false });
      }
    } catch (err) {
      console.error('[Core] File Dialog error:', err);
    }
  },

  async refresh() {
    const generation = _nextNavigationGeneration();
    const state = Core.getState();
    window.dispatchEvent(new CustomEvent('quivit-refresh-start'));
    try {
      if (state.mode === 'archive' && state.archivePath) {
        await this.loadFile(state.archivePath, { generation, history: 'skip', targetName: state.filename });
      } else if (state.directory) {
        const result = await invoke('read_directory', { path: state.directory, showHidden: this.showHidden(), targetName: state.filename });
        if (!_isCurrentGeneration(generation)) return;
        this.applyDirectoryResult(result, { preserveFilename: true, generation, history: 'skip' });
      }
    } catch (err) {
      console.error('[Core] refresh error, navigating to parent:', err);
      this.openParent();
    } finally {
      window.dispatchEvent(new CustomEvent('quivit-refresh-end'));
    }
  },

  async loadHistoryEntry(entry) {
    if (!entry) return;
    const options = {
      history: 'skip',
      preferInitial: true,
      targetPath: entry.selectedPath,
      targetName: entry.selectedName,
      restoreLastImage: false,
    };

    if (entry.containerKind === 'archive') {
      await this.loadArchive(entry.containerPath, entry.selectedPath, options);
      return;
    }

    await this.loadFile(entry.containerPath, options);
  },

  prefetchAhead(archivePath, currentIndex, direction = 1) {
    const state = Core.getState();
    const files = state.list;
    if (!files || files.length === 0 || state.mode !== 'archive' || state.archivePath !== archivePath) return;

    const indicesToPrefetch = [];
    
    // ── Symmetric window: 7 ahead, 7 behind ──
    const PREFETCH_HALF = 7;
    for (let i = 1; i <= PREFETCH_HALF; i++) {
      const ahead = currentIndex + (direction * i);
      if (ahead >= 0 && ahead < files.length && this.isImageEntry(files[ahead])) {
        indicesToPrefetch.push(files[ahead].name);
      }
      const behind = currentIndex - (direction * i);
      if (behind >= 0 && behind < files.length && this.isImageEntry(files[behind])) {
        indicesToPrefetch.push(files[behind].name);
      }
    }

    if (indicesToPrefetch.length > 0) {
      const seq = ++_archivePrefetchSeq;
      clearTimeout(_archivePrefetchTimer);
      _archivePrefetchTimer = setTimeout(() => {
        const latest = Core.getState();
        if (
          seq !== _archivePrefetchSeq ||
          latest.mode !== 'archive' ||
          latest.archivePath !== archivePath ||
          latest.index !== currentIndex
        ) {
          return;
        }

        invoke('prefetch_archive_entries', {
          archivePath: archivePath,
          entries: indicesToPrefetch,
        }).catch(err => console.warn('[Prefetch] Error:', err));
      }, 75);
    }
  }
};
