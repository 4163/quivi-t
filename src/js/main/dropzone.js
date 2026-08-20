let dropMessageTimer = null;
const DEFAULT_DROP_MESSAGE = 'Drop files here, or click to open a folder';
let _dropOverlay = null;



function showDropMessage(message, tone = 'default') {
  if (!_dropOverlay) return;
  const textEl = _dropOverlay.querySelector('.drop-hint p');
  if (!textEl) return;
  clearTimeout(dropMessageTimer);
  textEl.textContent = message;
  _dropOverlay.classList.toggle('unsupported', tone === 'error');
  if (tone === 'error') {
    dropMessageTimer = setTimeout(() => {
      textEl.textContent = DEFAULT_DROP_MESSAGE;
      _dropOverlay.classList.remove('unsupported');
    }, 1800);
  }
}

function resetDropMessage() {
  showDropMessage(DEFAULT_DROP_MESSAGE);
}

async function loadDroppedPath(path, FsUtils) {
  if (!path) return;
  if (window.__TAURI__) {
    const kind = await window.__TAURI__.core.invoke('get_path_kind', { path }).catch(() => 'missing');
    if (kind === 'file') {
      const name = FsUtils.basename(path);
      if (!FsUtils.isImage(name) && !FsUtils.isArchive(name)) {
        showDropMessage('File type not supported', 'error');
        return;
      }
    } else if (kind === 'missing') {
      showDropMessage('Path not found', 'error');
      return;
    }
  } else {
    const name = FsUtils.basename(path);
    if (name.includes('.') && !FsUtils.isImage(name) && !FsUtils.isArchive(name)) {
      showDropMessage('File type not supported', 'error');
      return;
    }
  }

  FsUtils.loadFile(path, { preferInitial: true, restoreLastImage: false });
}

export function initDropZone({ dropOverlay, FsUtils }) {
  _dropOverlay = dropOverlay;

  if (!_dropOverlay) return;

  _dropOverlay.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  _dropOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    FsUtils.openDirectoryDialog();
  });

  if (window.__TAURI__) {
    const { listen } = window.__TAURI__.event;

    listen('tauri://drag-enter', () => {
      _dropOverlay.classList.add('drag-over');
      showDropMessage('Drop to open');
    });
    listen('tauri://drag-leave', () => {
      _dropOverlay.classList.remove('drag-over');
      resetDropMessage();
    });
    listen('tauri://drag-drop', (e) => {
      _dropOverlay.classList.remove('drag-over');
      const paths = e.payload.paths;
      if (paths && paths.length > 0) {
        loadDroppedPath(paths[0], FsUtils).catch(err => {
          console.error('[Drop] Failed to open path:', err);
          showDropMessage('Unable to open file', 'error');
        });
      }
    });
    return;
  }

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    _dropOverlay.classList.add('drag-over');
    showDropMessage('Drop to open');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      _dropOverlay.classList.remove('drag-over');
      resetDropMessage();
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    _dropOverlay.classList.remove('drag-over');

    const file = e.dataTransfer.getData('text/plain');
    if (file) {
      loadDroppedPath(file, FsUtils).catch(err => {
        console.error('[Drop] Failed to open path:', err);
        showDropMessage('Unable to open file', 'error');
      });
    }
  });
}
