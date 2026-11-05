import { listenWorkspaceEvent } from '../shared/workspaceSession.js';

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
    message = importing ? 'Loading...' : DEFAULT_DROP_MESSAGE;
    render();
  });
  Core.onStateChange(render);
  render();

  dropOverlay.addEventListener('mousedown', (e) => e.stopPropagation());
  dropOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!importing) FsUtils.openDirectoryDialog();
  });

  async function onNativeDrop(event) {
    const { phase, dropId, message: error } = event.payload || {};
    if (phase === 'entered' || phase === 'left') {
      hovering = phase === 'entered';
      if (!importing && !feedback) message = hovering ? 'Drop to open' : DEFAULT_DROP_MESSAGE;
      render();
    } else if (phase === 'accepted') {
      hovering = false;
      try {
        if (await importActions.acceptDrop(dropId)) onDropAccepted();
      } catch (err) { showError(err); }
    } else if (phase === 'ready') {
      await importActions.completeDrop(dropId).catch(showError);
    } else if (phase === 'failed' && await importActions.failDrop(dropId)) {
      showError(error);
    }
  }

  // Prevent WebView navigation even when the native target rejects a payload.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  if (window.__TAURI__) {
    if (navigator.userAgent.includes('Windows')) {
      listenWorkspaceEvent('quivit-drop', onNativeDrop, { owner: 'main' })
        .then(unlisten => {
          if (unlisten) return window.__TAURI__.core.invoke('enable_native_drop');
        })
        .catch(showError);
      return;
    }
    listenWorkspaceEvent('tauri://drag-enter', () => { hovering = true; render(); });
    listenWorkspaceEvent('tauri://drag-leave', () => { hovering = false; render(); });
    listenWorkspaceEvent('tauri://drag-drop', (event) => {
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
