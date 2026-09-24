/**
 * metadata-window.js: QuiviT
 * Receives comic metadata from the main window via Tauri event and renders it.
 *
 * The main window stores the serialised ComicMeta object in localStorage under
 * 'quivit-metadata-current' and emits a 'metadata-data' event so this window
 * updates whenever the archive changes.
 */

import { applyTheme, applyCustomCss } from './shared/theme.js';
import { fitContentHeight } from './shared/windowFit.js';

const coverImg   = document.getElementById('metadata-cover-img');
const titleEl    = document.getElementById('metadata-title');
const seriesEl   = document.getElementById('metadata-series');
const summaryEl  = document.getElementById('metadata-summary');
const gridEl     = document.getElementById('metadata-grid');
const coverWrap  = document.getElementById('metadata-cover-wrap');
const topEl      = document.getElementById('metadata-top');

// Wide covers stack above the title block; portrait keeps the side-by-side row.
// Near-square counts as square so off-by-a-few-px thumbs don't flip layouts.
function applyCoverOrientation() {
  const w = coverImg.naturalWidth || 0;
  const h = coverImg.naturalHeight || 0;
  if (!w || !h) {
    topEl.removeAttribute('data-orientation');
    return;
  }
  const ratio = w / h;
  if (ratio > 1.1) topEl.setAttribute('data-orientation', 'landscape');
  else if (ratio < 0.9) topEl.setAttribute('data-orientation', 'portrait');
  else topEl.setAttribute('data-orientation', 'square');
}

function render(payload) {
  const { meta, coverSrc } = payload || {};

  if (!meta) return;

  // Cover image stays hidden until fully decoded to avoid progressive JPEG scan-line rendering.
  if (coverSrc) {
    coverWrap.classList.add('hidden');
    coverImg.onload = () => {
      applyCoverOrientation();
      coverWrap.classList.remove('hidden');
      fitContentHeight().then(showWindow);
    };
    coverImg.onerror = () => { topEl.removeAttribute('data-orientation'); coverWrap.classList.add('hidden'); coverImg.src = ''; showWindow(); };
    coverImg.src = coverSrc;
  } else {
    topEl.removeAttribute('data-orientation');
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
  const applyValue = (key, value) => {
    const lbl = gridEl.querySelector(`.meta-label[data-key="${key}"]`);
    const val = gridEl.querySelector(`.meta-value[data-key="${key}"]`);
    if (!lbl || !val) return;
    if (value) {
      if (Array.isArray(value)) {
        val.replaceChildren(...value);
        val.title = val.textContent;
      } else {
        val.textContent = value;
        val.title = value;
      }
      lbl.classList.remove('hidden');
      val.classList.remove('hidden');
    } else {
      val.textContent = '';
      val.title = '';
      lbl.classList.add('hidden');
      val.classList.add('hidden');
    }
  };

  const createCredit = (icon, text) => {
    const span = document.createElement('span');
    span.className = 'meta-credit';
    const img = document.createElement('img');
    img.className = 'meta-credit-icon';
    img.src = `/assets/metadata-icons/${icon}.svg`;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.draggable = false;
    span.appendChild(img);
    span.appendChild(document.createTextNode(text));
    return span;
  };

  const createSeparator = () => {
    const span = document.createElement('span');
    span.textContent = ' · ';
    return span;
  };

  // Credits
  const credits = [];
  const addCredit = (svg, text) => {
    if (!text) return;
    if (credits.length) credits.push(createSeparator());
    credits.push(createCredit(svg, text));
  };

  // writer (fountain pen)
  addCredit('writer', meta.writer);
  // penciller (pencil)
  addCredit('penciller', meta.penciller);
  // inker (nib)
  addCredit('inker', meta.inker);
  // colorist (artist palette)
  addCredit('colorist', meta.colorist);
  // letterer (thought balloon)
  addCredit('letterer', meta.letterer);
  // cover artist (framed picture)
  addCredit('cover-artist', meta.coverArtist);
  // editor (memo)
  addCredit('editor', meta.editor);

  applyValue('credits', credits.length ? credits : null);

  applyValue('publisher', meta.publisher);
  applyValue('genre', meta.genre);
  applyValue('tags', meta.tags);

  let dateStr = '';
  if (meta.year) {
    dateStr = String(meta.year);
    if (meta.month) dateStr += `-${String(meta.month).padStart(2, '0')}`;
  }
  applyValue('date', dateStr || null);
  applyValue('pages', meta.pageCount ? String(meta.pageCount) : null);
  applyValue('language', meta.languageISO ? meta.languageISO.toUpperCase() : null);
  applyValue('rating', meta.rating);
  
  let readingStr = null;
  if (meta.manga && meta.manga !== 'No') {
    readingStr = meta.manga === 'YesAndRightToLeft' ? 'Right-to-Left' : 'Manga';
  }
  applyValue('reading', readingStr);
  applyValue('notes', meta.notes);
}


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
// height. Show it only after the content-fit settles. This avoids the visible
// shrink flicker. Guarded so live updates don't re-trigger it.
let windowShown = false;
function showWindow() {
  if (windowShown || !window.__TAURI__) return;
  windowShown = true;
  window.__TAURI__.window.getCurrentWindow().show().catch(() => {});
}

// Update when the main window changes archives.
if (window.__TAURI__) {
  window.__TAURI__.event.listen('metadata-data', (e) => {
    render(e.payload);
    // Re-fit to the new content height (render() also re-fits after the cover
    // decodes, but the window should shrink immediately even without a cover).
    fitContentHeight();
    // Keep localStorage in sync so reopened windows do not wait for an event.
    try { localStorage.setItem('quivit-metadata-current', JSON.stringify(e.payload)); } catch (_) {}
  }).catch(console.error);

  // Options sends preview events while the user edits the theme or CSS.
  window.__TAURI__.event.listen('theme-preview', (e) => applyTheme(e.payload)).catch(console.error);
  window.__TAURI__.event.listen('css-preview', (e) => applyCustomCss(e.payload)).catch(console.error);
}

// Finalized theme and CSS changes arrive through the native `storage` event.
// `main.js` writes the localStorage values shared by open webviews.
window.addEventListener('storage', (e) => {
  if (e.key === 'quivit-theme') applyTheme(e.newValue);
  if (e.key === 'quivit-custom-css') applyCustomCss(e.newValue);
});
