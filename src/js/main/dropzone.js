const DEFAULT_DROP_MESSAGE = 'Drop images, links, files, or folders here';
const FEEDBACK_DURATION_MS = 3000;

export function initDropZone({ dropOverlay, FsUtils, Core, importActions, isUnmappedSelection, onDropAccepted }) {
  if (!dropOverlay) return;
  const text = dropOverlay.querySelector('.drop-hint p');
  let hovering = false;
  let importing = false;
  let feedback = false;
  let feedbackTimer = null;
  let message = DEFAULT_DROP_MESSAGE;

  function render() {
    const state = Core.getState();
    const blocked = ['password_required', 'password_incorrect'].includes(state.archiveEncryption);
    const empty = state.mode === 'empty' || !state.src || isUnmappedSelection(state);
    dropOverlay.classList.toggle('active', !blocked && empty);
    dropOverlay.classList.toggle('drag-over', hovering);
    if (text) text.textContent = message;
  }

  function showError(err) {
    clearTimeout(feedbackTimer);
    feedback = true;
    message = typeof err === 'string' ? err : err?.message || 'Unable to open dropped content';
    dropOverlay.classList.add('unsupported');
    render();
    feedbackTimer = setTimeout(() => {
      feedback = false;
      dropOverlay.classList.remove('unsupported');
      message = DEFAULT_DROP_MESSAGE;
      render();
    }, FEEDBACK_DURATION_MS);
  }

  importActions.subscribe((activity) => {
    importing = activity.importing;
    hovering = false;
    feedback = false;
    clearTimeout(feedbackTimer);
    dropOverlay.classList.remove('unsupported');
    message = activity.phase === 'receiving' ? 'Receiving image from browser...'
      : activity.phase === 'preparing' ? 'Saving dropped image...'
      : activity.phase === 'resolving' ? 'Importing URL...'
      : activity.phase === 'opening' ? 'Opening...'
      : DEFAULT_DROP_MESSAGE;
    render();
  });
  Core.onStateChange(render);
  render();

  dropOverlay.addEventListener('mousedown', (e) => e.stopPropagation());
  dropOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!importing) FsUtils.openDirectoryDialog();
  });

  function onNativeDrop(event) {
    const { phase, dropId, message: error } = event.payload || {};
    if (phase === 'entered' || phase === 'left') {
      hovering = phase === 'entered';
      if (!importing && !feedback) message = hovering ? 'Drop to open' : DEFAULT_DROP_MESSAGE;
      render();
    } else if (phase === 'accepted') {
      hovering = false;
      try {
        if (importActions.acceptDrop(dropId)) onDropAccepted();
      } catch (err) { showError(err); }
    } else if (phase === 'ready') {
      importActions.completeDrop(dropId).catch(showError);
    } else if (phase === 'failed' && importActions.failDrop(dropId)) {
      showError(error);
    }
  }

  // Prevent WebView navigation even when the native target rejects a payload.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  if (window.__TAURI__) {
    const { listen } = window.__TAURI__.event;
    if (navigator.userAgent.includes('Windows')) {
      listen('quivit-drop', onNativeDrop)
        .then(() => window.__TAURI__.core.invoke('enable_native_drop'))
        .catch(showError);
      return;
    }
    listen('tauri://drag-enter', () => { hovering = true; render(); });
    listen('tauri://drag-leave', () => { hovering = false; render(); });
    listen('tauri://drag-drop', (event) => {
      hovering = false;
      const path = event.payload?.paths?.[0];
      if (path) importActions.openPath(path).catch(showError);
      render();
    });
    return;
  }

  window.addEventListener('drop', (e) => {
    const value = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    const first = value?.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#'))?.trim();
    if (!first) return;
    const operation = /^https?:\/\//i.test(first) ? importActions.openUrl(first) : importActions.openPath(first);
    operation.catch(showError);
  });
}
