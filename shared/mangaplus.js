// quivit-deps: shared/proto.js
/**
 * shared/mangaplus.js: MANGA Plus viewer client shared by extractors.
 *
 * Pure functions of (viewerId, context). No match/extract exports,
 * never a manifest entry. Consumed by the MANGA Plus entry shell and
 * by mangadex.js for externalUrl chapters.
 *
 * Rate limiting uses adaptive timestamp throttling so the initial request fires
 * immediately without artificial sleep delay.
 */

import { ProtoReader, readFields } from './proto.js';

const API_BASE = 'https://jumpg-webapi.tokyo-cdn.com';
const RATE_LIMIT_MS = 500;
let lastMangaPlusRequestTime = 0;

async function throttleMangaPlusRequest() {
  const now = Date.now();
  const elapsed = now - lastMangaPlusRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastMangaPlusRequestTime = Date.now();
}

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
// TitleDetailView (SuccessResult field 8): field 1 = title,
// field 28 = chapter_list_group. Title: 1 = title_id, 2 = name,
// 3 = author. ChapterListGroup: 2 = first_chapter_list,
// 4 = last_chapter_list. Chapter: 2 = chapter_id, 3 = name,
// 4 = sub_title (null when expired).
const F_TITLE_DETAIL_VIEW = 8;
const F_TD_TITLE = 1;
const F_T_NAME = 2;
const F_T_AUTHOR = 3;
const F_T_LANGUAGE = 7;
const F_T_PORTRAIT = 4;
const F_TD_OVERVIEW = 3;
const F_CHAPTER_LIST_GROUP = 28;
const F_FIRST_CHAPTERS = 2;
const F_LAST_CHAPTERS = 4;
const F_CH_ID = 2;
const F_CH_NAME = 3;
const F_CH_SUBTITLE = 4;
const F_CH_THUMBNAIL = 5;
// TitleDetailView: field 7 = viewing_period_description,
// field 8 = non_appearance_info, field 31 = genre_list.
// TagName: field 1 = name, field 2 = slug.
const F_VIEWING_PERIOD = 7;
const F_NON_APPEARANCE = 8;
const F_GENRE_LIST = 31;
const F_TAG_NAME = 1;
const F_TAG_SLUG = 2;

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

export function padIndex(index, total) {
  const width = Math.max(2, Math.ceil(Math.log10(Math.max(2, total + 1))));
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
    throw new Error(`MANGA Plus API request rejected - ${detail}`);
  }

  const successFields = readFields(new ProtoReader(successEntry.value));
  const viewerEntry = successFields.get(F_MANGA_VIEWER)?.[0];
  if (!viewerEntry || viewerEntry.wire !== 2) {
    throw new Error('MANGA Plus API response does not contain a manga viewer - chapter may not be available');
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
    throw new Error('MANGA Plus requires a newer version of QuiviT with binary fetch support.');
  }

  const sessionToken = generateSessionToken();
  const headers = { 'SESSION-TOKEN': sessionToken };
  const apiUrl = `${API_BASE}/api/manga_viewer_v3?chapter_id=${viewerId}&split=no&img_quality=super_high&clang=eng`;

  await throttleMangaPlusRequest();

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

export async function fetchMangaTitleDetail(titleId, context = {}) {
  const fetchBytes = context?.fetchBytes;
  if (typeof fetchBytes !== 'function') {
    throw new Error('MANGA Plus requires a newer version of QuiviT with binary fetch support.');
  }

  const headers = { 'SESSION-TOKEN': generateSessionToken() };
  const apiUrl = `${API_BASE}/api/title_detailV3?title_id=${titleId}&clang=eng`;

  await throttleMangaPlusRequest();

  const bytes = await fetchBytes(apiUrl, headers);
  const response = readFields(new ProtoReader(bytes));
  const successEntry = response.get(F_SUCCESS)?.[0];
  if (!successEntry || successEntry.wire !== 2) {
    const detail = parseErrorDetail(response) || 'request may have been rejected';
    throw new Error(`MANGA Plus API request rejected - ${detail}`);
  }

  const successFields = readFields(new ProtoReader(successEntry.value));
  const tdEntry = successFields.get(F_TITLE_DETAIL_VIEW)?.[0];
  if (!tdEntry || tdEntry.wire !== 2) {
    throw new Error('MANGA Plus title detail unavailable.');
  }

  const tdFields = readFields(new ProtoReader(tdEntry.value));
  let name = '';
  let author = '';
  let language = -1;
  let overview = '';
  let portraitImageUrl = '';
  const titleEntry = tdFields.get(F_TD_TITLE)?.[0];
  if (titleEntry?.wire === 2) {
    const tFields = readFields(new ProtoReader(titleEntry.value));
    name = readString(tFields, F_T_NAME);
    author = readString(tFields, F_T_AUTHOR);
    const langEntry = tFields.get(F_T_LANGUAGE)?.[0];
    if (langEntry?.wire === 0) language = langEntry.value;
    portraitImageUrl = readString(tFields, F_T_PORTRAIT);
  }
  overview = readString(tdFields, F_TD_OVERVIEW);

  const genres = [];
  for (const tagEntry of tdFields.get(F_GENRE_LIST) || []) {
    if (tagEntry.wire !== 2) continue;
    const tagFields = readFields(new ProtoReader(tagEntry.value));
    const tagName = readString(tagFields, F_TAG_NAME);
    if (tagName) genres.push({ name: tagName, slug: readString(tagFields, F_TAG_SLUG) });
  }

  const viewingPeriod = readString(tdFields, F_VIEWING_PERIOD);
  const nonAppearance = readString(tdFields, F_NON_APPEARANCE);

  const chapters = [];
  for (const groupEntry of tdFields.get(F_CHAPTER_LIST_GROUP) || []) {
    if (groupEntry.wire !== 2) continue;
    const gFields = readFields(new ProtoReader(groupEntry.value));
    for (const listNum of [F_FIRST_CHAPTERS, F_LAST_CHAPTERS]) {
      for (const chEntry of gFields.get(listNum) || []) {
        if (chEntry.wire !== 2) continue;
        const cFields = readFields(new ProtoReader(chEntry.value));
        const cid = cFields.get(F_CH_ID)?.[0];
        chapters.push({
          chapterId: cid?.wire === 0 ? cid.value : 0,
          name: readString(cFields, F_CH_NAME),
          subTitle: readString(cFields, F_CH_SUBTITLE) || null,
          thumbnailUrl: readString(cFields, F_CH_THUMBNAIL) || null
        });
      }
    }
  }

  return { name, author, language, overview, portraitImageUrl, genres, viewingPeriod, nonAppearance, chapters };
}

const COMPLETED_RE = /completado|completed?|completo|latest 0 chapters/i;
const HIATUS_RE = /on a hiatus/i;

export function resolveMangaPlusStatus(viewingPeriod, nonAppearance, genreSlugs = []) {
  const combined = `${nonAppearance || ''}\n${viewingPeriod || ''}`;
  if (genreSlugs.includes('one-shot') || COMPLETED_RE.test(combined)) return 'Completed';
  if (HIATUS_RE.test(combined)) return 'On hiatus';
  return 'Ongoing';
}
