/**
 * metadata.js: QuiviT
 * Detects, fetches, and parses comic metadata files from open archives.
 *
 * Supported formats (priority order):
 *   1. ComicInfo.xml: industry standard (ComicRack schema)
 *   2. CoMet.xml: older alternative standard
 *   3. metadata.opf: Calibre/ePub-style OPF metadata
 *
 * All lookups are case-insensitive. The module is stateless; callers
 * cache the result if they need it.
 */

import { FsUtils } from './fsUtils.js';

// Known metadata filenames, in priority order (lowercase for matching).
const METADATA_FILENAMES = ['comicinfo.xml', 'comet.xml', 'metadata.opf'];

/**
 * Given the list of filenames inside an archive, returns the first metadata
 * filename found (using the original casing from the archive), or null.
 * @param {string[]} fileNames - Array of entry names from the archive.
 * @returns {string|null}
 */
export function findMetadataEntry(fileNames) {
  for (const target of METADATA_FILENAMES) {
    const match = fileNames.find(n => {
      // Strip directory prefix. Only match root-level or bare filenames.
      const bare = n.replace(/\\/g, '/').split('/').pop();
      return bare.toLowerCase() === target;
    });
    if (match) return match;
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
  let xmlText;
  try {
    const resp = await fetch(src);
    if (!resp.ok) return null;
    xmlText = await resp.text();
  } catch {
    return null;
  }

  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return null;

    const name = entry.replace(/\\/g, '/').split('/').pop().toLowerCase();
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

// Parsers

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
