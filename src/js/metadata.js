/**
 * metadata.js: QuiviT
 * Detects, fetches, and parses comic metadata files from open archives.
 *
 * Supported formats include ComicInfo XML/JSON, gallery meta.json,
 * CoMet XML/JSON, and Calibre/ePub-style OPF metadata.
 *
 * All lookups are case-insensitive. The module is stateless; callers
 * cache the result if they need it.
 */

import { FsUtils } from './fsUtils.js';
import { findMetadataEntry } from './services/metadataFiles.js';

export { findMetadataEntry };

export function parseMetadataText(text, entryName) {
  if (!text || typeof text !== 'string') return null;
  const name = (entryName || '').replace(/\\/g, '/').split('/').pop().toLowerCase();

  if (name.endsWith('.json')) {
    try {
      const data = JSON.parse(text);
      if (name === 'meta.json' || (Array.isArray(data?.tags) && data.tags.some(t => t && typeof t === 'object' && t.type))) {
        return parseGalleryMetaJson(data);
      }
      return parseComicInfoJson(data);
    } catch {
      return null;
    }
  }

  if (name.endsWith('.xml') || name.endsWith('.opf')) {
    try {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      if (doc.querySelector('parsererror')) return null;

      if (name === 'metadata.opf') {
        return parseOpf(doc);
      } else {
        // ComicInfo.xml and CoMet.xml share similar element names.
        return parseComicInfo(doc);
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Fetches and parses metadata from the given archive.
 * @param {string} archivePath - Absolute path to the archive file.
 * @param {string[]} fileNames - Entry names from list_archive().
 * @returns {Promise<ComicMeta|null>} Parsed metadata object or null if none found.
 */
export async function fetchMetadata(archivePath, fileNames) {
  const entry = findMetadataEntry(fileNames);
  if (!entry) return null;

  const src = FsUtils.buildArchiveSrc(archivePath, entry);
  let text;
  try {
    const resp = await fetch(src);
    if (!resp.ok) return null;
    text = await resp.text();
  } catch {
    return null;
  }

  return parseMetadataText(text, entry);
}

/**
 * Fetches and parses metadata for a directory within an imported library.
 * Walks upward through parent directories to inherit metadata.
 * @param {string} dirPath - Absolute path to the directory.
 * @returns {Promise<{ meta: ComicMeta, metaPath: string, dirPath: string }|null>}
 */
export async function fetchDirectoryMetadata(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return null;
  if (!window.__TAURI__) return null;

  try {
    const res = await window.__TAURI__.core.invoke('find_directory_metadata', { dirPath });
    if (!res || !res.content) return null;

    const meta = parseMetadataText(res.content, res.meta_path);
    if (!meta) return null;

    return {
      meta,
      metaPath: res.meta_path,
      dirPath: res.dir_path
    };
  } catch (err) {
    console.warn('[Metadata] Failed to fetch directory metadata:', err);
    return null;
  }
}

// Parsers

/**
 * Parses ComicInfo JSON formats (PascalCase and camelCase).
 * @param {object} raw
 * @returns {ComicMeta|null}
 */
export function parseComicInfoJson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw.ComicInfo || raw;

  const get = (...keys) => {
    for (const key of keys) {
      const v = data[key];
      if (v !== undefined && v !== null) {
        if (Array.isArray(v)) {
          return v.map(x => String(x).trim()).filter(Boolean).join(', ');
        }
        const s = String(v).trim();
        if (s) return s;
      }
    }
    return '';
  };

  const getNum = (...keys) => {
    for (const key of keys) {
      const v = data[key];
      if (v !== undefined && v !== null) {
        const n = parseInt(v, 10);
        if (!isNaN(n)) return n;
      }
    }
    return null;
  };

  const getManga = () => {
    const rawVal = data.Manga ?? data.manga;
    if (rawVal === true) return 'Yes';
    if (rawVal === false) return 'No';
    if (typeof rawVal === 'string') {
      const trimmed = rawVal.trim();
      if (['Yes', 'No', 'YesAndRightToLeft'].includes(trimmed)) return trimmed;
      if (/^yes$/i.test(trimmed)) return 'Yes';
      if (/^no$/i.test(trimmed)) return 'No';
      if (/^rtl|righttoleft$/i.test(trimmed)) return 'YesAndRightToLeft';
    }
    return '';
  };

  const title       = get('Title', 'title');
  const series      = get('Series', 'series');
  const number      = get('Number', 'number', 'issue', 'Issue');
  const count       = get('Count', 'count', 'totalIssues');
  const volume      = get('Volume', 'volume');
  const summary     = get('Summary', 'summary', 'Description', 'description');
  const notes       = get('Notes', 'notes');
  const year        = getNum('Year', 'year');
  const month       = getNum('Month', 'month');
  const writer      = get('Writer', 'writer', 'writers', 'Writers');
  const penciller   = get('Penciller', 'penciller', 'pencillers', 'Pencillers');
  const inker       = get('Inker', 'inker', 'inkers', 'Inkers');
  const colorist    = get('Colorist', 'colorist', 'colorists', 'Colorists');
  const letterer    = get('Letterer', 'letterer', 'letterers', 'Letterers');
  const coverArtist = get('CoverArtist', 'coverArtist', 'cover_artist');
  const editor      = get('Editor', 'editor', 'editors', 'Editors');
  const publisher   = get('Publisher', 'publisher');
  const genre       = get('Genre', 'genre', 'genres', 'Genres');
  const demographic = get('Demographic', 'demographic', 'AgeRating', 'ageRating');
  let tags          = get('Tags', 'tags');
  if (demographic) {
    const normTags = tags.toLowerCase().split(',').map(s => s.trim());
    if (!normTags.includes(demographic.toLowerCase().trim())) {
      tags = tags ? `${demographic}, ${tags}` : demographic;
    }
  }
  const pageCount   = getNum('PageCount', 'pageCount', 'pages', 'Pages');
  const manga       = getManga();
  const languageISO = get('LanguageISO', 'languageISO', 'languageIso', 'language', 'Language');
  const rating      = get('CommunityRating', 'communityRating', 'Rating', 'rating');

  return {
    title, series, number, count, volume,
    summary, notes,
    year, month,
    writer, penciller, inker, colorist, letterer, coverArtist, editor,
    publisher, genre, tags,
    pageCount, manga, languageISO, rating,
  };
}

/**
 * Parses scraper / gallery meta.json structures.
 * @param {object} raw
 * @returns {ComicMeta|null}
 */
export function parseGalleryMetaJson(raw) {
  if (!raw || typeof raw !== 'object') return null;

  let title = '';
  if (typeof raw.title === 'string') {
    title = raw.title.trim();
  } else if (raw.title && typeof raw.title === 'object') {
    title = raw.title.english || raw.title.pretty || raw.title.japanese || '';
    title = String(title).trim();
  }

  const tagList = Array.isArray(raw.tags) ? raw.tags : [];
  const getTagNames = (type) => tagList
    .filter(t => t && typeof t === 'object' && t.type === type && t.name)
    .map(t => String(t.name).trim())
    .filter(Boolean);

  const parodies = getTagNames('parody');
  const series = parodies.join(', ') || (typeof raw.series === 'string' ? raw.series.trim() : '');

  const artists = getTagNames('artist');
  const writer = artists.join(', ') || (typeof raw.artist === 'string' ? raw.artist.trim() : '');
  const penciller = writer;

  const groups = getTagNames('group');
  const publisher = groups.join(', ') || (typeof raw.group === 'string' ? raw.group.trim() : '');

  const categories = getTagNames('category');
  const genre = categories.join(', ') || (typeof raw.category === 'string' ? raw.category.trim() : '');

  const normalTags = getTagNames('tag');
  const characters = getTagNames('character');
  const combinedTags = [...normalTags, ...characters];
  const tags = combinedTags.join(', ');

  const languages = getTagNames('language').filter(l => l.toLowerCase() !== 'translated');
  const languageISO = languages[0] || (typeof raw.language === 'string' ? raw.language.trim() : '');

  let year = null;
  let month = null;
  if (typeof raw.upload_date === 'number' && raw.upload_date > 0) {
    const d = new Date(raw.upload_date * 1000);
    if (!isNaN(d.getTime())) {
      year = d.getUTCFullYear();
      month = d.getUTCMonth() + 1;
    }
  }

  const pageCount = (typeof raw.num_pages === 'number' && raw.num_pages > 0) ? raw.num_pages : null;
  const notes = raw.scanlator ? `Scanlator: ${String(raw.scanlator).trim()}` : '';

  return {
    title,
    series,
    number: '',
    count: '',
    volume: '',
    summary: typeof raw.description === 'string' ? raw.description.trim() : '',
    notes,
    year,
    month,
    writer,
    penciller,
    inker: '',
    colorist: '',
    letterer: '',
    coverArtist: '',
    editor: '',
    publisher,
    genre,
    tags,
    pageCount,
    manga: 'Yes',
    languageISO,
    rating: '',
  };
}

/** @param {Document} doc */
function parseComicInfo(doc) {
  const get = (tag) => doc.querySelector(tag)?.textContent?.trim() || '';
  const getNum = (tag) => {
    const v = parseInt(get(tag), 10);
    return isNaN(v) ? null : v;
  };

  const title       = get('Title');
  const series      = get('Series');
  const number      = get('Number');
  const count       = get('Count');
  const volume      = get('Volume');
  const summary     = get('Summary') || get('Description');
  const notes       = get('Notes');
  const year        = getNum('Year');
  const month       = getNum('Month');
  const writer      = get('Writer');
  const penciller   = get('Penciller');
  const inker       = get('Inker');
  const colorist    = get('Colorist');
  const letterer    = get('Letterer');
  const coverArtist = get('CoverArtist');
  const editor      = get('Editor');
  const publisher   = get('Publisher');
  const genre       = get('Genre');
  const tags        = get('Tags');
  const pageCount   = getNum('PageCount');
  const manga       = get('Manga'); // 'Yes' | 'No' | 'YesAndRightToLeft'
  const languageISO = get('LanguageISO');
  const rating      = get('CommunityRating') || get('Rating');

  return {
    title, series, number, count, volume,
    summary, notes,
    year, month,
    writer, penciller, inker, colorist, letterer, coverArtist, editor,
    publisher, genre, tags,
    pageCount, manga, languageISO, rating,
  };
}

/** @param {Document} doc OPF/Calibre format */
function parseOpf(doc) {
  const ns = 'http://purl.org/dc/elements/1.1/';
  const get = (tag) => doc.getElementsByTagNameNS(ns, tag)[0]?.textContent?.trim() || '';
  const getMeta = (name) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || '';

  return {
    title:      get('title'),
    series:     getMeta('calibre:series'),
    number:     getMeta('calibre:series_index'),
    count:      null,
    volume:     null,
    summary:    get('description'),
    notes:      '',
    year:       parseInt(get('date'), 10) || null,
    month:      null,
    writer:     get('creator'),
    penciller:  '',
    inker:      '',
    colorist:   '',
    letterer:   '',
    coverArtist:'',
    editor:     '',
    publisher:  get('publisher'),
    genre:      get('subject'),
    tags:       '',
    pageCount:  null,
    manga:      '',
    languageISO:get('language'),
    rating:     '',
  };
}

/**
 * @typedef {Object} ComicMeta
 * @property {string} title
 * @property {string} series
 * @property {string} number     - Issue number (string, can be "1" or "1.5")
 * @property {string} count      - Total issues in series
 * @property {string} volume
 * @property {string} summary
 * @property {string} notes
 * @property {number|null} year
 * @property {number|null} month
 * @property {string} writer
 * @property {string} penciller
 * @property {string} inker
 * @property {string} colorist
 * @property {string} letterer
 * @property {string} coverArtist
 * @property {string} editor
 * @property {string} publisher
 * @property {string} genre
 * @property {string} tags
 * @property {number|null} pageCount
 * @property {string} manga      - 'Yes' | 'No' | 'YesAndRightToLeft' | ''
 * @property {string} languageISO
 * @property {string} rating
 */
