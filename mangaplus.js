// quivit-deps: shared/mangaplus.js, shared/sanitize.js
// quivit-needs: fetchBytes, requestHeaders, xorDecrypt
/**
 * mangaplus.js: MANGA Plus by Shueisha chapter extractor.
 *
 * Thin entry shell over the shared viewer client. Matches direct
 * viewer and title URLs; series feeds resolve through mangadex.js stubs.
 */

import { parseViewerId, fetchMangaPlusChapter, fetchMangaTitleDetail, buildMangaPlusImages, resolveMangaPlusStatus } from './shared/mangaplus.js';
import { sanitizePathSegment } from './shared/sanitize.js';

const MANGAPLUS_CHAPTER_RE = /^https?:\/\/mangaplus\.shueisha\.co\.jp\/viewer\/(\d+)/i;
const MANGAPLUS_TITLE_RE = /^https?:\/\/mangaplus\.shueisha\.co\.jp\/titles\/(\d+)/i;
const MANGAPLUS_CDN_RE = /^https?:\/\/[a-z0-9-]+\.tokyo-cdn\.com\/(.+?)(?:\.([a-z0-9]+))(?:[?#].*)?$/i;
const CDN_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']);

// Language codes from the title detail response. The folder always carries
// the language so editions in different languages never share a directory.
const LANGUAGE_NAMES = {
  0: 'English',
  1: 'Spanish',
  2: 'French',
  3: 'Indonesian',
  4: 'Portuguese',
  5: 'Russian',
  6: 'Thai',
  7: 'German',
  9: 'Vietnamese'
};
const LANGUAGE_ISO = {
  0: 'en',
  1: 'es',
  2: 'fr',
  3: 'id',
  4: 'pt',
  5: 'ru',
  6: 'th',
  7: 'de',
  9: 'vi'
};

export function match(url) {
  return MANGAPLUS_CHAPTER_RE.test(url) || MANGAPLUS_TITLE_RE.test(url) || MANGAPLUS_CDN_RE.test(url);
}

export function isDirectUrl(url) {
  return MANGAPLUS_CDN_RE.test(url);
}

export async function parseDirectUrl(url, context = {}) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(MANGAPLUS_CDN_RE);
  if (!m) return null;
  const ext = m[2].toLowerCase();
  if (!CDN_IMAGE_EXTENSIONS.has(ext)) return null;
  const path = m[1];
  const stem = (path.split('/').pop() || 'image').replace(/[^a-z0-9_-]/gi, '_');
  const titleId = (url.match(/\/title\/(\d+)(?:\/|$)/i) || [])[1];
  const hash = titleId ? `mangaplus-${titleId}-${stem}` : `mangaplus-${stem}`;
  let filename = `${hash}.${ext}`;

  const isPortraitList = path.includes('title_thumbnail_portrait_list');
  const chapterThumbMatch = path.match(/\/chapter\/(\d+)\/chapter_thumbnail\//i);

  if (titleId && typeof context?.fetchBytes === 'function') {
    try {
      const detail = await fetchMangaTitleDetail(titleId, context);
      if (detail.name) {
        const languageName = LANGUAGE_NAMES[detail.language] || 'English';
        if (isPortraitList) {
          filename = sanitizePathSegment(`${detail.name} - Cover (${languageName})`) + `.${ext}`;
        } else if (chapterThumbMatch) {
          const chapterId = chapterThumbMatch[1];
          const ch = detail.chapters.find((c) => String(c.chapterId) === chapterId);
          const chNum = ch ? (ch.name || '').replace(/^#/, '').trim() : '';
          const label = chNum ? `Ch. ${chNum} Thumbnail` : 'Thumbnail';
          filename = sanitizePathSegment(`${detail.name} - ${label} (${languageName})`) + `.${ext}`;
        } else {
          filename = sanitizePathSegment(`${detail.name} - ${stem} (${languageName})`) + `.${ext}`;
        }
      }
    } catch {
      // Non-fatal title resolution failure: falls back to hashed filename.
    }
  }

  return {
    provider: 'MANGA Plus',
    hash,
    filename,
    url
  };
}

function chapterFolderName(entry) {
  const num = (entry.name || '').replace(/^#/, '').trim();
  const base = num ? `Ch. ${num}` : 'Oneshot';
  if (entry.subTitle && entry.subTitle.trim()) return `${base} - ${entry.subTitle.trim()}`;
  return base;
}

async function extractSeries(titleId, url, context) {
  let detail;
  try {
    detail = await fetchMangaTitleDetail(titleId, context);
  } catch (err) {
    return { error: err?.message || 'MANGA Plus title request failed.' };
  }
  if (!detail.name) {
    return { error: 'MANGA Plus title not found or no longer available.' };
  }

  const languageName = LANGUAGE_NAMES[detail.language] || 'English';
  const languageIso = LANGUAGE_ISO[detail.language] || 'en';
  const seriesDir = sanitizePathSegment(`${detail.name} (${languageName})`);

  const seenChapters = new Set();
  const chapters = [];
  const allCovers = [];
  if (detail.portraitImageUrl) {
    allCovers.push({ url: detail.portraitImageUrl, filename: 'Cover.jpg' });
  }
  for (const entry of detail.chapters) {
    const cid = String(entry.chapterId || '');
    if (!cid || cid === '0' || seenChapters.has(cid)) continue;
    seenChapters.add(cid);
    const viewerUrl = `https://mangaplus.shueisha.co.jp/viewer/${cid}`;
    const chTitle = chapterFolderName(entry);
    const chFolder = sanitizePathSegment(chTitle);
    const chCover = entry.thumbnailUrl
      ? { url: entry.thumbnailUrl, filename: '00 - Thumbnail.jpg' }
      : null;
    if (chCover) allCovers.push(chCover);
    chapters.push({
      id: `mangaplus-${cid}`,
      title: `${detail.name} - ${chTitle}`,
      sourceUrl: viewerUrl,
      relativePath: [seriesDir, chFolder],
      cover: chCover,
      metadata: {
        ComicInfo: seriesComicInfo(detail, {
          Title: chTitle,
          Number: (entry.name || '').replace(/^#/, '').trim() || undefined,
          LanguageISO: languageIso,
          Web: viewerUrl
        })
      }
    });
  }

  if (chapters.length === 0) {
    return { error: 'No readable chapters found for this title.' };
  }

  return {
    provider: 'MANGA Plus',
    isSeries: true,
    title: `${detail.name} (${languageName})`,
    rootRelativePath: [seriesDir],
    metadata: {
      ComicInfo: seriesComicInfo(detail, {
        LanguageISO: languageIso,
        Web: url
      })
    },
    cover: detail.portraitImageUrl ? { url: detail.portraitImageUrl, filename: 'Cover.jpg' } : null,
    covers: allCovers,
    folders: [],
    cleanup: {
      removeMatchingChapters: true,
      removeLooseCovers: true
    },
    chapters
  };
}

function seriesComicInfo(detail, overrides = {}) {
  const genreList = detail.genres.map((g) => g.name).filter(Boolean).join(', ');
  const status = resolveMangaPlusStatus(detail.viewingPeriod, detail.nonAppearance, detail.genres.map((g) => g.slug));
  return {
    Series: detail.name,
    Writer: detail.author || undefined,
    Genre: genreList || undefined,
    Status: status,
    Summary: detail.overview || undefined,
    ...overrides
  };
}

export async function extract(html, url, context) {
  const titleMatch = url.match(MANGAPLUS_TITLE_RE);
  if (titleMatch) {
    return await extractSeries(titleMatch[1], url, context);
  }

  const viewerId = parseViewerId(url);
  if (!viewerId) {
    return { error: `URL does not match a MANGA Plus chapter: ${url}` };
  }

  let viewer;
  try {
    viewer = await fetchMangaPlusChapter(viewerId, context);
  } catch (err) {
    return { error: err?.message || 'MANGA Plus chapter request failed.' };
  }
  const { titleId, viewToken, pages } = viewer;

  if (pages.length === 0) {
    return { error: 'No pages found in chapter - it may have expired or require a subscription.' };
  }

  let seriesName = '';
  let languageCode = -1;
  let chapterLabel = '';
  let chapterNumber = '';
  let detail = null;
  try {
    detail = await fetchMangaTitleDetail(titleId, context);
    if (detail.name) seriesName = detail.name;
    if (Number.isInteger(detail.language)) languageCode = detail.language;
    const listed = detail.chapters.find((c) => String(c.chapterId) === String(viewerId));
    if (listed) {
      const num = (listed.name || '').replace(/^#/, '').trim();
      chapterNumber = num;
      chapterLabel = num ? `Ch. ${num}` : '';
      if (listed.subTitle && listed.subTitle.trim()) {
        chapterLabel += (chapterLabel ? ' - ' : '') + listed.subTitle.trim();
      }
    }
  } catch {
    // Fallbacks below keep the import working when the detail call fails.
  }

  const seriesTitle = seriesName || `MANGA Plus ${titleId}`;
  const chapterTitle = chapterLabel || `Chapter ${viewerId}`;
  const languageName = LANGUAGE_NAMES[languageCode] || 'English';
  const fullTitle = `${seriesTitle} - ${chapterTitle} (${languageName})`;
  const flatFolderName = sanitizePathSegment(fullTitle);
  const images = buildMangaPlusImages(pages, viewToken);

  // Prepend chapter thumbnail as page zero when available.
  let thumbnailUrl = null;
  if (detail) {
    const listed = detail.chapters.find((c) => String(c.chapterId) === String(viewerId));
    if (listed?.thumbnailUrl) thumbnailUrl = listed.thumbnailUrl;
  }
  if (thumbnailUrl) {
    const thumbExt = thumbnailUrl.match(/\.(\w+)(?:\?|$)/)?.[1] || 'jpg';
    const thumbWidth = Math.max(2, Math.ceil(Math.log10(Math.max(2, pages.length + 1))));
    images.unshift({ url: thumbnailUrl, filename: `${'0'.repeat(thumbWidth)} - Thumbnail.${thumbExt}` });
  }

  const info = detail ? seriesComicInfo(detail, {
    Title: `${chapterTitle} (${languageName})`,
    Number: chapterNumber || undefined,
    LanguageISO: LANGUAGE_ISO[languageCode] || 'en',
    PageCount: pages.length,
    Web: url
  }) : {
    Series: seriesTitle,
    Title: `${chapterTitle} (${languageName})`,
    LanguageISO: LANGUAGE_ISO[languageCode] || 'en',
    PageCount: pages.length,
    Web: url
  };

  return {
    provider: 'MANGA Plus',
    title: fullTitle,
    gallery: {
      id: `mangaplus-${viewerId}`,
      relativePath: [flatFolderName]
    },
    images,
    metadata: {
      ComicInfo: info
    },
    nextPageUrl: null
  };
}
