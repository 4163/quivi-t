/**
 * metadata-window.js — QuiviT
 * Receives comic metadata from the main window via Tauri event and renders it.
 *
 * The main window stores the serialised ComicMeta object in localStorage under
 * 'quivit-metadata-current' and emits a 'metadata-data' event so this window
 * updates whenever the archive changes.
 */

import { applyTheme, applyCustomCss } from './shared/theme.js';

const coverImg   = document.getElementById('metadata-cover-img');
const titleEl    = document.getElementById('metadata-title');
const seriesEl   = document.getElementById('metadata-series');
const summaryEl  = document.getElementById('metadata-summary');
const gridEl     = document.getElementById('metadata-grid');
const coverWrap  = document.getElementById('metadata-cover-wrap');
const rootEl     = document.getElementById('metadata-root');

function render(payload) {
  const { meta, coverSrc } = payload || {};

  if (!meta) return;

  // Cover image — keep hidden until fully decoded to avoid progressive JPEG scan-line rendering
  if (coverSrc) {
    coverWrap.classList.add('hidden');
    coverImg.onload = () => {
      coverWrap.classList.remove('hidden');
      fitContentHeight().then(showWindow);
    };
    coverImg.onerror = () => { coverWrap.classList.add('hidden'); coverImg.src = ''; showWindow(); };
    coverImg.src = coverSrc;
  } else {
    coverWrap.classList.add('hidden');
    coverImg.onload = null;
    coverImg.onerror = null;
    coverImg.src = '';
  }

  // Title block
  titleEl.textContent = meta.title || '';

  let seriesLine = '';
  if (meta.series) {
    seriesLine = meta.series;
    if (meta.number) seriesLine += ` #${meta.number}`;
    if (meta.count)  seriesLine += ` of ${meta.count}`;
    if (meta.volume) seriesLine += ` · Vol. ${meta.volume}`;
  }
  seriesEl.textContent = seriesLine;
  summaryEl.textContent = meta.summary || '';

  // Detail grid
  const rows = [];
  const addRow = (label, value) => {
    if (!value) return;
    const lbl = document.createElement('span');
    lbl.className = 'meta-label';
    lbl.textContent = label;
    const val = document.createElement('span');
    val.className = 'meta-value';
    val.textContent = value;
    val.title = value;
    rows.push(lbl, val);
  };

  // Credits
  const credits = [];
  if (meta.writer)      credits.push(`✍ ${meta.writer}`);
  if (meta.penciller)   credits.push(`✏ ${meta.penciller}`);
  if (meta.inker)       credits.push(`🖊 ${meta.inker}`);
  if (meta.colorist)    credits.push(`🎨 ${meta.colorist}`);
  if (meta.letterer)    credits.push(`🔠 ${meta.letterer}`);
  if (meta.coverArtist) credits.push(`🖼 ${meta.coverArtist}`);
  if (meta.editor)      credits.push(`📝 ${meta.editor}`);
  if (credits.length)   addRow('Credits', credits.join(' · '));

  if (meta.publisher) addRow('Publisher', meta.publisher);
  if (meta.genre)     addRow('Genre', meta.genre);
  if (meta.tags)      addRow('Tags', meta.tags);

  let dateStr = '';
  if (meta.year) {
    dateStr = String(meta.year);
    if (meta.month) dateStr += `-${String(meta.month).padStart(2, '0')}`;
  }
  if (dateStr) addRow('Date', dateStr);
  if (meta.pageCount)   addRow('Pages', String(meta.pageCount));
  if (meta.languageISO) addRow('Language', meta.languageISO.toUpperCase());
  if (meta.rating)      addRow('Rating', meta.rating);
  if (meta.manga && meta.manga !== 'No') {
    addRow('Reading', meta.manga === 'YesAndRightToLeft' ? 'Right-to-Left' : 'Manga');
  }
  if (meta.notes) addRow('Notes', meta.notes);

  gridEl.replaceChildren(...rows);
}

import { fitContentHeight } from './shared/windowFit.js';

// Render from localStorage immediately (data written before window opened)
// The window opens hidden; show it once the content-fit settles.
try {
  const stored = localStorage.getItem('quivit-metadata-current');
  if (stored) {
    const payload = JSON.parse(stored);
    render(payload);
    // With a cover, render()'s onload shows the window after the re-fit;
    // without one, show after the initial fit.
    if (!payload || !payload.coverSrc) {
      fitContentHeight().then(showWindow);
    }
  } else {
    render(null);
    fitContentHeight().then(showWindow);
  }
} catch (e) { showWindow(); }

// The window is built hidden (config.rs) so it never paints at the pre-fit
// height. Show it only after the content-fit settles — avoids the visible
// shrink flicker. Guarded so live updates don't re-trigger it.
let windowShown = false;
function showWindow() {
  if (windowShown || !window.__TAURI__) return;
  windowShown = true;
  window.__TAURI__.window.getCurrentWindow().show().catch(() => {});
}

// Stay live: update when the main window changes archive
if (window.__TAURI__) {
  window.__TAURI__.event.listen('metadata-data', (e) => {
    render(e.payload);
    // Re-fit to the new content height (render() also re-fits after the cover
    // decodes, but the window should shrink immediately even without a cover).
    fitContentHeight();
    // Keep localStorage in sync so re-opens don't need to wait for an event
    try { localStorage.setItem('quivit-metadata-current', JSON.stringify(e.payload)); } catch (_) {}
  }).catch(console.error);

  // Architectural Standard (Live Previews): Secondary windows must intercept Tauri events
  // emitted by the Options window to instantly reflect in-progress theme/CSS changes.
  window.__TAURI__.event.listen('theme-preview', (e) => applyTheme(e.payload)).catch(console.error);
  window.__TAURI__.event.listen('css-preview', (e) => applyCustomCss(e.payload)).catch(console.error);
}

// Architectural Standard (Permanent State): Secondary windows tap into the native JS `storage` 
// event to catch finalized config changes. `main.js` is the sole writer to `quivit-theme` / 
// `quivit-custom-css` in localStorage, which natively broadcasts to all open webviews.
window.addEventListener('storage', (e) => {
  if (e.key === 'quivit-theme') applyTheme(e.newValue);
  if (e.key === 'quivit-custom-css') applyCustomCss(e.newValue);
});
