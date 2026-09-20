/**
 * mangadex.js: MangaDex chapter and media extractor.
 *
 * Fetches chapter metadata and MangaDex@Home image delivery coordinates
 * through the public MangaDex REST API. Supports page-targeted chapter links,
 * direct cover/CDN media, and flat chapter folder naming.
 */

const MANGADEX_CHAPTER_RE = /^https?:\/\/(?:www\.)?mangadex\.(?:org|cc)\/chapter\/([0-9a-fA-F-]{36})(?:\/(\d+))?/i;
const MANGADEX_TITLE_RE = /^https?:\/\/(?:www\.)?mangadex\.(?:org|cc)\/title\/([0-9a-fA-F-]{36})/i;
const MANGADEX_BLOB_RE = /^blob:https?:\/\/(?:www\.)?mangadex\.(?:org|cc)\//i;
const MANGADEX_COVER_RE = /^https?:\/\/(?:uploads\.|(?:www\.)?)mangadex\.(?:org|cc)\/covers\/([0-9a-fA-F-]{36})\/([^\s?#]+)$/i;
const MANGADEX_NETWORK_RE = /^https?:\/\/[a-zA-Z0-9-]+\.mangadex\.network\/data(?:-saver)?\/([0-9a-fA-F]{32})\/([^\s?#]+)$/i;

const FILENAME_FORBIDDEN_RE = /[<>:"/\\|?*\x00-\x1F]/g;
const PATH_SEGMENT_MAX_LEN = 100;
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function sanitizePathSegment(value) {
  let sanitized = String(value || 'Untitled')
    .replace(FILENAME_FORBIDDEN_RE, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!sanitized) return 'Untitled';
  if (RESERVED_DEVICE_NAMES.test(sanitized)) sanitized = `_${sanitized}`;
  if (sanitized.length > PATH_SEGMENT_MAX_LEN) {
    sanitized = sanitized.slice(0, PATH_SEGMENT_MAX_LEN).replace(/[. ]+$/, '');
  }
  return sanitized || 'Untitled';
}

export function digitPadWidth(count) {
  if (count <= 0) return 2;
  return Math.max(2, Math.ceil(Math.log10(count + 1)));
}

export function resolveMangaTitle(titleMap, altTitles = []) {
  if (titleMap && typeof titleMap === 'object') {
    if (titleMap.en) return titleMap.en;
    if (titleMap['ja-ro']) return titleMap['ja-ro'];
    if (titleMap.romaji) return titleMap.romaji;
    const values = Object.values(titleMap).filter(Boolean);
    if (values.length > 0) return values[0];
  }

  if (Array.isArray(altTitles)) {
    for (const entry of altTitles) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.en) return entry.en;
      if (entry['ja-ro']) return entry['ja-ro'];
      if (entry.romaji) return entry.romaji;
    }
    for (const entry of altTitles) {
      if (!entry || typeof entry !== 'object') continue;
      const values = Object.values(entry).filter(Boolean);
      if (values.length > 0) return values[0];
    }
  }

  return 'Unknown Manga';
}

export function formatChapterLabel(attributes) {
  const { volume, chapter, title } = attributes || {};
  const segments = [];
  if (volume) segments.push(`Vol. ${volume}`);
  if (chapter) segments.push(`Ch. ${chapter}`);
  const baseLabel = segments.join(' ') || 'Oneshot';
  if (title && title.trim()) {
    return `${baseLabel} - ${title.trim()}`;
  }
  return baseLabel;
}

export function parseChapterMatch(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(MANGADEX_CHAPTER_RE);
  if (!match) return null;
  return {
    chapterId: match[1].toLowerCase(),
    targetPage: match[2] ? parseInt(match[2], 10) : null
  };
}

export function isBlobUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return MANGADEX_BLOB_RE.test(url);
}

export function isTitleUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return MANGADEX_TITLE_RE.test(url);
}

export function isDirectUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return MANGADEX_COVER_RE.test(url) || MANGADEX_NETWORK_RE.test(url);
}

export async function parseDirectUrl(url, context = {}) {
  if (!url || typeof url !== 'string') return null;

  const coverMatch = url.match(MANGADEX_COVER_RE);
  if (coverMatch) {
    const mangaId = coverMatch[1];
    const rawFilename = coverMatch[2];
    const dotIdx = rawFilename.lastIndexOf('.');
    const ext = dotIdx > 0 ? rawFilename.slice(dotIdx).toLowerCase() : '.jpg';
    const hash = dotIdx > 0 ? rawFilename.slice(0, dotIdx) : rawFilename;

    let friendlyFilename = rawFilename;
    if (typeof context?.fetchText === 'function') {
      try {
        const mangaText = await context.fetchText(`https://api.mangadex.org/manga/${mangaId}`);
        const mangaPayload = JSON.parse(mangaText);
        const mangaTitle = resolveMangaTitle(
          mangaPayload?.data?.attributes?.title,
          mangaPayload?.data?.attributes?.altTitles
        );

        if (mangaTitle && mangaTitle !== 'Unknown Manga') {
          let volumeLabel = '';
          try {
            const coverText = await context.fetchText(`https://api.mangadex.org/cover?manga%5B%5D=${mangaId}&limit=100`);
            const coverPayload = JSON.parse(coverText);
            const coverEntry = coverPayload?.data?.find(
              (c) => c.attributes?.fileName === rawFilename
            );
            if (coverEntry?.attributes?.volume) {
              volumeLabel = ` - Vol. ${coverEntry.attributes.volume}`;
            }
          } catch {
            // Non-fatal volume resolution failure.
          }

          const baseName = sanitizePathSegment(`${mangaTitle}${volumeLabel} Cover`);
          friendlyFilename = `${baseName}${ext}`;
        }
      } catch {
        // Non-fatal title resolution failure: falls back to rawFilename.
      }
    }

    return {
      provider: 'MangaDex',
      hash,
      ext,
      filename: friendlyFilename,
      url
    };
  }

  const networkMatch = url.match(MANGADEX_NETWORK_RE);
  if (networkMatch) {
    const rawFilename = networkMatch[2];
    const dotIdx = rawFilename.lastIndexOf('.');
    const ext = dotIdx > 0 ? rawFilename.slice(dotIdx).toLowerCase() : '.png';
    const hash = dotIdx > 0 ? rawFilename.slice(0, dotIdx) : rawFilename;
    return {
      provider: 'MangaDex',
      hash,
      ext,
      filename: rawFilename,
      url
    };
  }

  return null;
}

export function match(url) {
  if (!url || typeof url !== 'string') return false;
  return MANGADEX_CHAPTER_RE.test(url)
    || MANGADEX_TITLE_RE.test(url)
    || MANGADEX_BLOB_RE.test(url)
    || isDirectUrl(url);
}

export async function extract(html, url, context = {}) {
  if (isBlobUrl(url)) {
    throw new Error('Direct blob URLs are not supported. Download the image directly, or use the website URL if supported.');
  }

  if (isTitleUrl(url)) {
    throw new Error('MangaDex series links contain multiple chapters. Please open and copy the URL of the specific chapter you want to read, such as https://mangadex.org/chapter/...');
  }

  const direct = await parseDirectUrl(url, context);
  if (direct) {
    return {
      provider: 'MangaDex',
      title: `MangaDex ${direct.hash}`,
      images: [{
        url: direct.url,
        filename: direct.filename,
        displayName: direct.hash
      }],
      nextPageUrl: null
    };
  }

  const parsed = parseChapterMatch(url);
  if (!parsed?.chapterId) {
    throw new Error('Invalid MangaDex chapter URL');
  }

  if (typeof context.fetchText !== 'function') {
    throw new Error('Context missing fetchText helper for MangaDex API requests');
  }

  const chapterId = parsed.chapterId;
  const chapterApiUrl = `https://api.mangadex.org/chapter/${chapterId}?includes%5B%5D=manga`;
  const chapterText = await context.fetchText(chapterApiUrl);
  let chapterPayload;
  try {
    chapterPayload = JSON.parse(chapterText);
  } catch (err) {
    throw new Error(`Failed to parse MangaDex chapter API response: ${err.message}`);
  }

  if (chapterPayload?.result === 'error') {
    const errorDetail = chapterPayload.errors?.[0]?.detail || 'Chapter not found on MangaDex';
    throw new Error(errorDetail);
  }

  const chapterAttributes = chapterPayload?.data?.attributes;
  if (!chapterAttributes) {
    throw new Error('MangaDex chapter data is missing or unavailable');
  }

  if (chapterAttributes.externalUrl) {
    throw new Error('This chapter is hosted on an external service and cannot be downloaded directly from MangaDex');
  }

  const mangaRelationship = chapterPayload.data.relationships?.find((rel) => rel.type === 'manga');
  let rawMangaTitle = resolveMangaTitle(
    mangaRelationship?.attributes?.title,
    mangaRelationship?.attributes?.altTitles
  );

  if (rawMangaTitle === 'Unknown Manga' && html) {
    const ogTitleMatch = html.match(/<meta\s+[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    if (ogTitleMatch) {
      const ogParts = ogTitleMatch[1].split(' - ');
      if (ogParts.length > 0 && ogParts[0].trim()) {
        rawMangaTitle = ogParts[0].trim();
      }
    }
  }

  const chapterLabel = formatChapterLabel(chapterAttributes);
  const fullTitle = `${rawMangaTitle} - ${chapterLabel}`;
  const flatFolderName = sanitizePathSegment(fullTitle);

  const atHomeUrl = `https://api.mangadex.org/at-home/server/${chapterId}`;
  const atHomeText = await context.fetchText(atHomeUrl);
  let atHomePayload;
  try {
    atHomePayload = JSON.parse(atHomeText);
  } catch (err) {
    throw new Error(`Failed to parse MangaDex @home server response: ${err.message}`);
  }

  if (atHomePayload?.result !== 'ok' || !atHomePayload.baseUrl || !atHomePayload.chapter?.hash) {
    throw new Error('MangaDex image server returned an unexpected response');
  }

  const baseUrl = atHomePayload.baseUrl;
  const chapterHash = atHomePayload.chapter.hash;
  const pageFiles = Array.isArray(atHomePayload.chapter.data) && atHomePayload.chapter.data.length > 0
    ? atHomePayload.chapter.data
    : (Array.isArray(atHomePayload.chapter.dataSaver) ? atHomePayload.chapter.dataSaver : []);

  if (pageFiles.length === 0) {
    throw new Error('No images found in chapter');
  }

  const total = pageFiles.length;
  const padWidth = digitPadWidth(total);
  const qualityFolder = Array.isArray(atHomePayload.chapter.data) && atHomePayload.chapter.data.length > 0
    ? 'data'
    : 'data-saver';

  const images = pageFiles.map((rawName, index) => {
    const dotIdx = rawName.lastIndexOf('.');
    const ext = dotIdx > 0 ? rawName.slice(dotIdx).toLowerCase() : '.png';
    const pageNumber = String(index + 1).padStart(padWidth, '0');
    const filename = `${pageNumber}${ext}`;

    return {
      url: `${baseUrl}/${qualityFolder}/${chapterHash}/${rawName}`,
      filename,
      displayName: `Page ${index + 1}`,
      description: `Page ${index + 1} of ${total}`
    };
  });

  const targetPage = parsed.targetPage;
  const targetFilename = (targetPage && targetPage >= 1 && targetPage <= images.length)
    ? images[targetPage - 1].filename
    : null;

  return {
    provider: 'MangaDex',
    title: fullTitle,
    targetFilename,
    gallery: {
      id: `mangadex-${chapterId}`,
      relativePath: [flatFolderName]
    },
    images,
    nextPageUrl: null
  };
}
