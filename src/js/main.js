/**
 * main.js — QuiviT
 *
 * DOM bindings ONLY. Handles:
 *   - Drag-and-drop events on the window
 *   - Keyboard navigation (arrow keys)
 *   - Updating UI elements (statusbar, drop overlay) in response to state callbacks
 *
 * Business logic lives in core.js.
 * Rendering logic lives in viewer.js.
 * Communication with both is via the Core state callback API.
 */

import { Core } from './core.js';

// --- DOM refs -----------------------------------------------------------------
const dropOverlay  = document.getElementById('drop-overlay');
const statusbar    = document.getElementById('statusbar');
const statusName   = document.getElementById('status-filename');
const statusIndex  = document.getElementById('status-index');

// --- State subscription -------------------------------------------------------
// Update the UI whenever Core fires a state change.

Core.onStateChange((state) => {
  if (state.mode === 'empty') {
    dropOverlay.classList.add('active');
    statusbar.classList.add('hidden');
    document.body.classList.remove('has-image');
    return;
  }

  // Image or archive loaded
  dropOverlay.classList.remove('active');
  statusbar.classList.remove('hidden');
  document.body.classList.add('has-image');

  statusName.textContent = state.filename;

  if (state.list.length > 1) {
    statusIndex.textContent = `${state.index + 1} / ${state.list.length}`;
  } else {
    statusIndex.textContent = '';
  }
});

// --- Drag-and-drop ------------------------------------------------------------ 

// Prevent default browser behavior (opening the file in the tab)
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropOverlay.classList.add('drag-over');
});

window.addEventListener('dragleave', (e) => {
  // Only fire when leaving the window entirely
  if (e.relatedTarget === null) {
    dropOverlay.classList.remove('drag-over');
  }
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropOverlay.classList.remove('drag-over');

  const file = e.dataTransfer?.files?.[0];
  if (!file) return;

  Core.loadFile(file);
});

// --- Keyboard navigation ------------------------------------------------------ 

window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault();
      Core.navigate(+1);
      break;

    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault();
      Core.navigate(-1);
      break;

    default:
      break;
  }
});
