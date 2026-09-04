import { FsUtils } from '../fsUtils.js';

const FIT_LABELS = Object.freeze({
  'window': 'Window',
  'width': 'Width',
  'height': 'Height',
  'none': 'None',
  'width-if-larger': 'Width if larger',
  'height-if-larger': 'Height if larger',
  'window-if-larger': 'Window if larger'
});

const FIT_TITLES = Object.freeze({
  'window': 'Scale to fit entirely within the viewport, stretching small images',
  'window-if-larger': 'Shrink to fit the viewport, but never enlarge small images'
});
let statusbar;
let statusName;
let statusDims;
let statusIndex;
let statusZoom;
let statusFit;
let statusScrollZoom;

export const Statusbar = {
  init() {
    statusbar = document.getElementById('statusbar');
    statusName = document.querySelector('.status-filename');
    statusDims = document.querySelector('.status-dims');
    statusIndex = document.querySelector('.status-index');
    statusZoom = document.querySelector('.status-zoom');
    statusFit = document.querySelector('.status-fit');
    statusScrollZoom = document.querySelector('.status-scroll-zoom');
  },

  // Called from Core.onStateChange. Owns fit mode, formatted index,
  // and non-image placeholders. For non-image entries also writes filename
  // since viewer.js won't fire for those.
  update(state) {
    if (!statusbar) return;

    if (statusFit) {
      const mode = state.fitMode ?? 'window';
      const text = `Fit: ${FIT_LABELS[mode] || mode}`;
      if (statusFit.textContent !== text) {
        statusFit.textContent = text;
        statusFit.title = FIT_TITLES[mode] || '';
      }
    }

    if (statusIndex) {
      const text = FsUtils.formatStatusIndex(state);
      if (statusIndex.textContent !== text) statusIndex.textContent = text;
    }

    // Non-image entries (folders, archives, `..`, drives) have no dimensions
    // or zoom level. Write N/A placeholders and the entry filename (viewer.js
    // won't fire for these since there is no image to load).
    const currentEntry = state.list?.[state.index];
    const isImage = !!currentEntry && FsUtils.isImageEntry(currentEntry) && state.src;
    if (!isImage) {
      if (statusDims) statusDims.textContent = 'N/A';
      if (statusZoom) statusZoom.textContent = 'N/A';
      if (statusName) {
        statusName.textContent = state.filename || '';
        statusName.title = state.filename || '';
      }
    }
  },

  // Called by viewer.js to report image lifecycle events. Writes filename,
  // dims, and zoom at the exact moment they become valid.
  setImage({ filename, dims, zoom, isError, isLoading }) {
    if (isLoading) {
      if (statusName) statusName.textContent = 'Loading...';
      return;
    }
    if (isError) {
      if (statusDims) statusDims.textContent = 'Error';
      if (statusZoom) statusZoom.textContent = 'N/A';
      return;
    }
    if (statusName && filename !== undefined) {
      statusName.textContent = filename;
    }
    if (statusDims && dims !== undefined) {
      statusDims.textContent = dims;
    }
    if (statusZoom && zoom !== undefined) {
      statusZoom.textContent = `${Math.round(zoom * 100)}%`;
    }
  },

  // Hot-path zoom update from _applyTransform.
  setZoom(scale) {
    if (statusZoom) {
      const text = `${Math.round(scale * 100)}%`;
      if (statusZoom.textContent !== text) statusZoom.textContent = text;
    }
  },

  // Scroll-zoom indicator: toggles classes on #statusbar to match CSS selectors
  // (#statusbar.action-held / #statusbar.action-latched).
  setScrollIndicatorState(text, held, latched) {
    if (!statusbar || !statusScrollZoom) return;

    if (statusScrollZoom.textContent !== text) statusScrollZoom.textContent = text;

    if (statusbar.classList.contains('action-held') !== held) {
      statusbar.classList.toggle('action-held', held);
    }
    if (statusbar.classList.contains('action-latched') !== latched) {
      statusbar.classList.toggle('action-latched', latched);
    }
  }
};
