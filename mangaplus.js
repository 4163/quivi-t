// quivit-deps: shared/mangaplus.js, shared/sanitize.js
// quivit-needs: fetchBytes, requestHeaders, xorDecrypt
/**
 * mangaplus.js: MangaPlus by Shueisha chapter extractor.
 *
 * Thin entry shell over the shared viewer client. Matches direct
 * viewer and title URLs; series feeds resolve through mangadex.js stubs.
 */

import { parseViewerId, fetchMangaPlusChapter, buildMangaPlusImages } from './shared/mangaplus.js';
import { sanitizePathSegment } from './shared/sanitize.js';

const MANGAPLUS_CHAPTER_RE = /^https?:\/\/mangaplus\.shueisha\.co\.jp\/viewer\/(\d+)/i;
const MANGAPLUS_TITLE_RE = /^https?:\/\/mangaplus\.shueisha\.co\.jp\/titles\/(\d+)/i;

export function match(url) {
  return MANGAPLUS_CHAPTER_RE.test(url) || MANGAPLUS_TITLE_RE.test(url);
}

export async function extract(html, url, context) {
  const titleMatch = url.match(MANGAPLUS_TITLE_RE);
  if (titleMatch) {
    return {
      error: 'MangaPlus title pages are not supported. Open a specific chapter URL instead.',
      skipReason: 'title-page'
    };
  }

  const viewerId = parseViewerId(url);
  if (!viewerId) {
    return { error: `URL does not match a MangaPlus chapter: ${url}` };
  }

  let viewer;
  try {
    viewer = await fetchMangaPlusChapter(viewerId, context);
  } catch (err) {
    return { error: err?.message || 'MangaPlus chapter request failed.' };
  }
  const { titleId, viewToken, pages } = viewer;

  if (pages.length === 0) {
    return { error: 'No pages found in chapter - it may have expired or require a subscription.' };
  }

  const seriesDir = sanitizePathSegment(`MangaPlus ${titleId}`);
  const chapterDir = sanitizePathSegment(`Chapter ${viewerId}`);
  const images = buildMangaPlusImages(pages, viewToken);

  return {
    provider: 'MangaPlus',
    title: `MangaPlus ${titleId} - Chapter ${viewerId}`,
    gallery: {
      id: `mangaplus-${viewerId}`,
      relativePath: [seriesDir, chapterDir]
    },
    images,
    nextPageUrl: null
  };
}
