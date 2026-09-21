// quivit-deps: shared/proto.js
/**
 * shared/mangaplus.js: MangaPlus viewer client shared by extractors.
 *
 * Pure functions of (viewerId, context). No match/extract exports,
 * never a manifest entry. Consumed by the MangaPlus entry shell and
 * by mangadex.js for externalUrl chapters.
 */

import { ProtoReader, readFields } from './proto.js';

const API_BASE = 'https://jumpg-webapi.tokyo-cdn.com';
const RATE_LIMIT_MS = 500;

const MANGAPLUS_VIEWER_RE = /^https?:\/\/mangaplus\.shueisha\.co\.jp\/viewer\/(\d+)/i;

// Protobuf field numbers from the current v3 schema.
// Response: field 1 = success, field 2 = error (ErrorResult)
// SuccessResult: field 10 = manga_viewer (MangaViewer)
// ErrorResult: field 2 = english popup
// MangaViewer: field 1 = pages, field 9 = title_id, field 19 = view_token
// Page: field 1 = manga_page
// MangaPage: field 1 = image_url, field 5 = encryption_key (no type field)
const F_SUCCESS = 1;
const F_ERROR = 2;
const F_MANGA_VIEWER = 10;
const F_PAGES = 1;
const F_TITLE_ID = 9;
const F_VIEW_TOKEN = 19;
const F_MANGA_PAGE = 1;
const F_IMAGE_URL = 1;
const F_ENCRYPTION_KEY = 5;
const F_POPUP = 2;
const F_SUBJECT = 1;
const F_BODY = 2;

function generateSessionToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function hexToBase64(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return btoa(String.fromCharCode(...bytes));
}

function padIndex(index, total) {
  const width = Math.max(1, Math.ceil(Math.log10(Math.max(2, total + 1))));
  return String(index + 1).padStart(width, '0');
}

function readString(fields, num) {
  const entry = fields.get(num)?.[0];
  return entry?.wire === 2 ? new TextDecoder().decode(entry.value) : '';
}

function parseErrorDetail(response) {
  const errorEntry = response.get(F_ERROR)?.[0];
  if (!errorEntry || errorEntry.wire !== 2) return null;
  const popup = readFields(new ProtoReader(errorEntry.value)).get(F_POPUP)?.[0];
  if (!popup || popup.wire !== 2) return null;
  const popupFields = readFields(new ProtoReader(popup.value));
  const subject = readString(popupFields, F_SUBJECT);
  const body = readString(popupFields, F_BODY);
  if (!subject && !body) return null;
  return body ? `${subject}: ${body}` : subject;
}

function parseMangaViewer(bytes) {
  const response = readFields(new ProtoReader(bytes));
  const successEntry = response.get(F_SUCCESS)?.[0];
  if (!successEntry || successEntry.wire !== 2) {
    const detail = parseErrorDetail(response) || 'request may have been rejected';
    throw new Error(`MangaPlus API request rejected - ${detail}`);
  }

  const successFields = readFields(new ProtoReader(successEntry.value));
  const viewerEntry = successFields.get(F_MANGA_VIEWER)?.[0];
  if (!viewerEntry || viewerEntry.wire !== 2) {
    throw new Error('MangaPlus API response does not contain a manga viewer - chapter may not be available');
  }

  const viewerFields = readFields(new ProtoReader(viewerEntry.value));

  const titleId = viewerFields.get(F_TITLE_ID)?.[0]?.wire === 0
    ? viewerFields.get(F_TITLE_ID)[0].value : 0;
  const viewToken = readString(viewerFields, F_VIEW_TOKEN);

  const pageEntries = viewerFields.get(F_PAGES) || [];
  const pages = [];

  for (const pageEntry of pageEntries) {
    if (pageEntry.wire !== 2) continue;
    const pageFields = readFields(new ProtoReader(pageEntry.value));
    const mangaPageEntry = pageFields.get(F_MANGA_PAGE)?.[0];
    if (!mangaPageEntry || mangaPageEntry.wire !== 2) continue;

    const mpFields = readFields(new ProtoReader(mangaPageEntry.value));
    const imageUrl = readString(mpFields, F_IMAGE_URL);
    const encryptionKey = readString(mpFields, F_ENCRYPTION_KEY) || null;

    if (!imageUrl) continue;
    pages.push({ imageUrl, encryptionKey });
  }

  return { titleId, viewToken, pages };
}

export function parseViewerId(externalUrl) {
  if (!externalUrl || typeof externalUrl !== 'string') return null;
  const clean = externalUrl.split(/[?#]/, 1)[0];
  const m = clean.match(MANGAPLUS_VIEWER_RE);
  return m ? m[1] : null;
}

export function cleanViewerUrl(externalUrl) {
  if (!externalUrl || typeof externalUrl !== 'string') return null;
  const clean = externalUrl.split(/[?#]/, 1)[0];
  return parseViewerId(clean) ? clean : null;
}

export async function fetchMangaPlusChapter(viewerId, context = {}) {
  const fetchBytes = context?.fetchBytes;
  if (typeof fetchBytes !== 'function') {
    throw new Error('MangaPlus requires a newer version of QuiviT with binary fetch support.');
  }

  const sessionToken = generateSessionToken();
  const headers = { 'SESSION-TOKEN': sessionToken };
  const apiUrl = `${API_BASE}/api/manga_viewer_v3?chapter_id=${viewerId}&split=no&img_quality=super_high&clang=eng`;

  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));

  const bytes = await fetchBytes(apiUrl, headers);
  return parseMangaViewer(bytes);
}

export function buildMangaPlusImages(pages, viewToken) {
  const imageHeaders = viewToken ? { 'Plus-Vw-Token': viewToken } : {};
  return pages.map((page, i) => {
    const ext = page.imageUrl.match(/\.(\w+)(?:\?|$)/)?.[1] || 'jpg';
    const filename = `${padIndex(i, pages.length)}.${ext}`;
    const image = { url: page.imageUrl, filename, headers: imageHeaders };
    if (page.encryptionKey) {
      image.decryption = { algorithm: 'xor', key: hexToBase64(page.encryptionKey) };
    }
    return image;
  });
}
