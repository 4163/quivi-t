import { FsUtils } from '../fsUtils.js';
import { Core } from '../core.js';
import { activeFilterId, FILTER_BY_ID } from '../services/registry.js';
import { getEffectiveScaling } from '../services/viewerMath.js';

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

const SCALING_LABELS = Object.freeze({
  'none': 'Pixelated',
  'bilinear': 'Bilinear',
  'lanczos': 'Lanczos'
});

let statusbar;
let statusName;
let statusDims;
let statusIndex;
let statusZoom;
let statusFit;
let statusScaling;
let statusFilter;
let statusScrollZoom;
let statusSpread;
let spreadIndicator;
let statusManhwa;
let manhwaIndicator;
const MIN_REFRESH_DURATION_MS = 200;
const FLASH_MESSAGE_DURATION_MS = 3000;
let _refreshTimer = null;
let _refreshStartTime = 0;
let _flashText = '';
let _flashTimer = null;

export const Statusbar = {
  init() {
    statusbar = document.getElementById('statusbar');
    statusName = document.querySelector('.status-filename');
    statusDims = document.querySelector('.status-dims');
    statusIndex = document.querySelector('.status-index');
    statusZoom = document.querySelector('.status-zoom');
    statusFit = document.querySelector('.status-fit');
    statusScaling = document.querySelector('.status-scaling');
    statusFilter = document.querySelector('.status-filter');
    statusScrollZoom = document.querySelector('.status-scroll-zoom');
    statusSpread = document.querySelector('.status-spread');
    spreadIndicator = document.getElementById('spread-indicator');
    statusManhwa = document.querySelector('.status-manhwa');
    manhwaIndicator = document.getElementById('manhwa-indicator');
    this.syncSpreadIndicator(Core.getState());
    this.syncManhwaIndicator(Core.getState());
    this.update(Core.getState());

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('quivit-download-complete', () => {
        this.update(Core.getState());
      });

      window.addEventListener('quivit-download-status', () => {
        this.update(Core.getState());
      });

      window.addEventListener('quivit-import-status', () => {
        this.update(Core.getState());
      });

      window.addEventListener('quivit-refresh-start', () => {
        if (!statusbar) return;
        clearTimeout(_refreshTimer);
        _refreshStartTime = performance.now();
        statusbar.classList.remove('refreshing');
        if (statusbar) void statusbar.offsetWidth;
        statusbar.classList.add('refreshing');
      });

      window.addEventListener('quivit-refresh-end', () => {
        if (!statusbar) return;
        const elapsed = performance.now() - _refreshStartTime;
        const remaining = Math.max(0, MIN_REFRESH_DURATION_MS - elapsed);
        _refreshTimer = setTimeout(() => {
          statusbar?.classList.remove('refreshing');
        }, remaining);
      });

      // Transient one-line notices (e.g. failed Library delete). Painted
      // over the filename slot by update(); never owned by other modules.
      window.addEventListener('quivit-status-flash', (e) => {
        _flashText = e?.detail?.message || '';
        clearTimeout(_flashTimer);
        if (!_flashText) return;
        _flashTimer = setTimeout(() => {
          _flashText = '';
          this.update(Core.getState());
        }, FLASH_MESSAGE_DURATION_MS);
        this.update(Core.getState());
      });
    }
  },

  syncSpreadIndicator(state) {
    if (!statusSpread && !spreadIndicator) return;
    const s = state || Core.getState();
    const spreadEnabled = !!(s.spreadEnabled ?? s.config?.frontend_data?.spread_enabled);
    const isSpreadActive = spreadEnabled && !!s.isSpread && ['width', 'width-if-larger'].includes(s.fitMode);
    const spreadText = isSpreadActive ? `[Spread ${s.spreadStep || 1}/2]` : '';
    const isStatusBarHidden = !statusbar || statusbar.classList.contains('hidden');

    if (isStatusBarHidden) {
      if (spreadIndicator && spreadIndicator.textContent !== spreadText) {
        spreadIndicator.textContent = spreadText;
      }
      if (statusSpread && statusSpread.textContent !== '') {
        statusSpread.textContent = '';
      }
    } else {
      if (statusSpread && statusSpread.textContent !== spreadText) {
        statusSpread.textContent = spreadText;
      }
      if (spreadIndicator && spreadIndicator.textContent !== '') {
        spreadIndicator.textContent = '';
      }
    }
  },

  syncManhwaIndicator(state, options = {}) {
    if (!statusManhwa && !manhwaIndicator) return;
    const s = state || Core.getState();
    const manhwaEnabled = !!(s.manhwaEnabled ?? s.config?.frontend_data?.manhwa_enabled);
    const isManhwaActive = manhwaEnabled && s.mode !== 'empty' && (!s.list || s.list.length > 0);
    const isStatusBarHidden = !statusbar || statusbar.classList.contains('hidden');

    if (options.preserveSpace) {
      if (isStatusBarHidden) {
        if (statusManhwa && statusManhwa.textContent !== '') {
          statusManhwa.textContent = '';
        }
        if (manhwaIndicator) {
          manhwaIndicator.textContent = isManhwaActive ? '[Manhwa View]' : '';
        }
      } else {
        if (statusManhwa) {
          statusManhwa.textContent = '[Manhwa View]';
          statusManhwa.classList.toggle('hold-flicker-hidden', !isManhwaActive);
        }
        if (manhwaIndicator && manhwaIndicator.textContent !== '') {
          manhwaIndicator.textContent = '';
        }
      }
      return;
    }

    if (statusManhwa) {
      statusManhwa.classList.remove('hold-flicker-hidden');
    }

    const manhwaText = isManhwaActive ? '[Manhwa View]' : '';
    if (isStatusBarHidden) {
      if (manhwaIndicator && manhwaIndicator.textContent !== manhwaText) {
        manhwaIndicator.textContent = manhwaText;
      }
      if (statusManhwa && statusManhwa.textContent !== '') {
        statusManhwa.textContent = '';
      }
    } else {
      if (statusManhwa && statusManhwa.textContent !== manhwaText) {
        statusManhwa.textContent = manhwaText;
      }
      if (manhwaIndicator && manhwaIndicator.textContent !== '') {
        manhwaIndicator.textContent = '';
      }
    }
  },

  isCurrentEntryDownloading(state) {
    const s = state || Core.getState();
    const currentEntry = s.list?.[s.index];
    if (!currentEntry || currentEntry.is_dir || currentEntry.is_parent) return false;
    const targetPath = currentEntry.path || (currentEntry.name && s.directory ? `${s.directory}\\${currentEntry.name}` : null);
    if (!targetPath) return false;
    return typeof Core.isDownloading === 'function' && Core.isDownloading(targetPath);
  },

  // Called from Core.onStateChange. Owns fit mode, formatted index,
  // and non-image placeholders. For non-image entries also writes filename
  // since viewer.js won't fire for those.
  update(state) {
    if (!statusbar) return;
    this.syncSpreadIndicator(state);
    this.syncManhwaIndicator(state);

    if (statusFit) {
      const mode = state.fitMode ?? 'window';
      const text = `Fit: ${FIT_LABELS[mode] || mode}`;
      if (statusFit.textContent !== text) {
        statusFit.textContent = text;
        statusFit.title = FIT_TITLES[mode] || '';
      }
    }

    if (statusScaling) {
      const isAnimated = !!state.isAnimated;
      const rawScaling = state.scalingMode ?? state.config?.frontend_data?.scaling_mode ?? 'bilinear';
      const effective = getEffectiveScaling(rawScaling, isAnimated, false);
      const label = SCALING_LABELS[effective] || SCALING_LABELS[rawScaling] || 'Bilinear';
      const text = `Scale: ${label}`;
      if (statusScaling.textContent !== text) {
        statusScaling.textContent = text;
      }
    }

    if (statusFilter) {
      const fid = activeFilterId(state.config?.frontend_data || {});
      const filterObj = fid ? FILTER_BY_ID.get(fid) : null;
      const label = filterObj ? filterObj.label : 'Off';
      const text = `Filter: ${label}`;
      if (statusFilter.textContent !== text) {
        statusFilter.textContent = text;
      }
    }

    if (statusIndex) {
      const text = FsUtils.formatStatusIndex(state);
      if (statusIndex.textContent !== text) statusIndex.textContent = text;
    }

    // Importing state shows 'Importing...' in status-filename and N/A dims/zoom.
    const isImporting = typeof document !== 'undefined' && document.body?.classList?.contains('is-importing-url');
    if (isImporting) {
      if (statusDims) statusDims.textContent = 'N/A';
      if (statusZoom) statusZoom.textContent = 'N/A';
      if (statusName) {
        statusName.textContent = 'Importing...';
        statusName.title = 'Importing...';
      }
      return;
    }

    // Downloading entries show 'Downloading...' in status-filename and N/A dims/zoom.
    const isDownloading = this.isCurrentEntryDownloading(state);
    if (isDownloading) {
      if (statusDims) statusDims.textContent = 'N/A';
      if (statusZoom) statusZoom.textContent = 'N/A';
      if (statusName) {
        statusName.textContent = 'Downloading...';
        statusName.title = state.filename ? `${state.filename} (Downloading...)` : 'Downloading...';
      }
      return;
    }

    // Non-media entries (folders, archives, `..`, drives) have no dimensions
    // or zoom level. Write N/A placeholders and the entry filename (viewer.js
    // won't fire for these since there is no image or video to load).
    const currentEntry = state.list?.[state.index];
    const isMedia = !!currentEntry && (FsUtils.isImageEntry(currentEntry) || FsUtils.isVideoEntry?.(currentEntry)) && state.src;
    if (!isMedia) {
      if (statusDims && statusDims.textContent !== 'N/A') statusDims.textContent = 'N/A';
      if (statusZoom && statusZoom.textContent !== 'N/A') statusZoom.textContent = 'N/A';
      if (statusName) {
        if (statusName.textContent !== (state.filename || '')) statusName.textContent = state.filename || '';
        if (statusName.title !== (state.filename || '')) statusName.title = state.filename || '';
      }
    } else if (statusName && state.filename && statusName.textContent !== state.filename) {
      statusName.textContent = state.filename;
      statusName.title = state.filename;
    }

    if (_flashText && statusName) {
      statusName.textContent = _flashText;
      statusName.title = _flashText;
    }
  },

  // Called by viewer.js to report image lifecycle events. Writes filename,
  // dims, and zoom at the exact moment they become valid.
  setImage({ filename, dims, zoom, isError, isLoading }) {
    if (this.isCurrentEntryDownloading() || (typeof document !== 'undefined' && document.body?.classList?.contains('is-importing-url'))) {
      return;
    }
    if (isLoading) {
      if (statusName && !statusName.textContent) {
        const liveName = filename || Core.getState().filename || '';
        statusName.textContent = liveName;
        statusName.title = liveName;
      }
      return;
    }
    if (isError) {
      if (statusDims && statusDims.textContent !== 'Error') statusDims.textContent = 'Error';
      if (statusZoom && statusZoom.textContent !== 'N/A') statusZoom.textContent = 'N/A';
      if (statusName && filename !== undefined && statusName.textContent !== filename) {
        statusName.textContent = filename;
        statusName.title = filename;
      }
      return;
    }
    if (statusName && filename !== undefined && statusName.textContent !== filename) {
      statusName.textContent = filename;
      statusName.title = filename;
    }
    if (statusDims && dims && statusDims.textContent !== dims) {
      statusDims.textContent = dims;
    }
    if (statusZoom && zoom !== undefined) {
      const zoomText = `${Math.round(zoom * 100)}%`;
      if (statusZoom.textContent !== zoomText) {
        statusZoom.textContent = zoomText;
      }
    }
    this.syncSpreadIndicator(Core.getState());
    this.syncManhwaIndicator(Core.getState());
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
