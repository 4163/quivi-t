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

function render(payload) {
  const { meta, coverSrc } = payload || {};

  if (!meta) return;

  // Cover image stays hidden until fully decoded to avoid progressive JPEG scan-line rendering.
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

  const createCredit = (svgPath, text) => {
    const span = document.createElement('span');
    span.style.display = 'inline-flex';
    span.style.alignItems = 'center';
    span.style.gap = '4px';
    span.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPath}</svg>`;
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

  // feather (writer)
  addCredit('<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/>', meta.writer);
  // pencil (penciller)
  addCredit('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>', meta.penciller);
  // pen-tool (inker)
  addCredit('<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>', meta.inker);
  // palette (colorist)
  addCredit('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>', meta.colorist);
  // type (letterer)
  addCredit('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>', meta.letterer);
  // image (coverArtist)
  addCredit('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>', meta.coverArtist);
  // edit (editor)
  addCredit('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>', meta.editor);

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
