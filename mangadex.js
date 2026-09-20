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

const LANGUAGE_NAMES = {
  en: 'English',
  ja: 'Japanese',
  'ja-ro': 'Japanese (Romaji)',
  es: 'Spanish',
  'es-la': 'Spanish (Latin America)',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  'pt-br': 'Portuguese (Brazil)',
  ru: 'Russian',
  id: 'Indonesian',
  vi: 'Vietnamese',
  zh: 'Chinese (Simplified)',
  'zh-hk': 'Chinese (Traditional)',
  ko: 'Korean',
  th: 'Thai',
  tl: 'Tagalog',
  pl: 'Polish',
  uk: 'Ukrainian',
  ar: 'Arabic',
  tr: 'Turkish',
  hu: 'Hungarian',
  cs: 'Czech',
  hi: 'Hindi',
  ms: 'Malay',
  nl: 'Dutch',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  el: 'Greek',
  bg: 'Bulgarian',
  he: 'Hebrew',
  fa: 'Persian',
  bn: 'Bengali',
  ca: 'Catalan',
  ro: 'Romanian',
  la: 'Latin',
  my: 'Burmese',
  mn: 'Mongolian'
};

export function resolveLanguageName(code) {
  if (!code || typeof code !== 'string') return 'Other';
  const lower = code.toLowerCase().trim();
  return LANGUAGE_NAMES[lower] || lower.toUpperCase();
}

export function formatVolumeFolder(volume) {
  if (volume === undefined || volume === null || volume === '' || volume === 'none') {
    return 'No Volume';
  }
  const clean = String(volume).trim();
  const num = parseFloat(clean);
  if (!isNaN(num) && Number.isInteger(num)) {
    const padded = clean.length === 1 ? `0${clean}` : clean;
    return `Vol. ${padded}`;
  }
  return `Vol. ${clean}`;
}

export function formatTitleChapterFolder(attributes, groupName) {
  const chapterLabel = formatChapterLabel(attributes);
  const groupClean = groupName && groupName !== 'No Group' ? groupName.trim() : '';
  const folderName = groupClean ? `${chapterLabel} [${groupClean}]` : chapterLabel;
  return sanitizePathSegment(folderName);
}

export function parseTitleMatch(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(MANGADEX_TITLE_RE);
  if (!match) return null;

  let isArtTab = false;
  let localeFilter = null;

  try {
    const parsed = new URL(url);
    const tab = parsed.searchParams.get('tab');
    if (tab === 'art' || parsed.hash === '#art') {
      isArtTab = true;
    }
    const loc = parsed.searchParams.get('locale');
    if (loc) {
      localeFilter = loc.toLowerCase().trim();
      isArtTab = true;
    } else if (parsed.hash && parsed.hash !== '#art') {
      localeFilter = parsed.hash.replace(/^#/, '').toLowerCase().trim();
      isArtTab = true;
    }
  } catch {
    if (/[?&#]tab=art\b/i.test(url) || /#art\b/i.test(url)) {
      isArtTab = true;
    }
    const locMatch = url.match(/[?&#]locale=([a-zA-Z-]+)/i);
    if (locMatch) {
      localeFilter = locMatch[1].toLowerCase().trim();
      isArtTab = true;
    }
  }

  return {
    mangaId: match[1].toLowerCase(),
    isArtTab,
    localeFilter
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
      rawFileName: rawFilename,
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
      rawFileName: rawFilename,
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

  const titleParsed = parseTitleMatch(url);
  if (titleParsed?.mangaId) {
    if (titleParsed.isArtTab) {
      return await extractArt(titleParsed.mangaId, url, context, titleParsed.localeFilter);
    }
    return await extractTitle(titleParsed.mangaId, url, context);
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
      fallbackUrl: `https://uploads.mangadex.org/${qualityFolder}/${chapterHash}/${rawName}`,
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

export async function extractTitle(mangaId, url, context = {}) {
  if (typeof context.fetchText !== 'function') {
    throw new Error('Context missing fetchText helper for MangaDex API requests');
  }

  const mangaUrl = `https://api.mangadex.org/manga/${mangaId}?includes%5B%5D=cover_art`;
  const mangaText = await context.fetchText(mangaUrl);
  let mangaPayload;
  try {
    mangaPayload = JSON.parse(mangaText);
  } catch (err) {
    throw new Error(`Failed to parse MangaDex manga API response: ${err.message}`);
  }

  if (mangaPayload?.result === 'error') {
    const errorDetail = mangaPayload.errors?.[0]?.detail || 'Manga not found on MangaDex';
    throw new Error(errorDetail);
  }

  const mangaTitle = resolveMangaTitle(
    mangaPayload?.data?.attributes?.title,
    mangaPayload?.data?.attributes?.altTitles
  );
  const titleFolderName = sanitizePathSegment(mangaTitle);

  let cover = null;
  const coverRel = mangaPayload?.data?.relationships?.find((r) => r.type === 'cover_art');
  const coverFileName = coverRel?.attributes?.fileName;
  if (coverFileName) {
    const dotIdx = coverFileName.lastIndexOf('.');
    const coverExt = dotIdx > 0 ? coverFileName.slice(dotIdx).toLowerCase() : '.jpg';
    const coverHash = dotIdx > 0 ? coverFileName.slice(0, dotIdx) : coverFileName;
    cover = {
      url: `https://uploads.mangadex.org/covers/${mangaId}/${coverFileName}`,
      filename: `Cover${coverExt}`,
      rawFileName: coverFileName,
      hash: coverHash,
      volume: coverRel?.attributes?.volume || null
    };
  }

  let offset = 0;
  const allFeedEntries = [];
  while (true) {
    const feedUrl = `https://api.mangadex.org/manga/${mangaId}/feed?limit=500&offset=${offset}&includes%5B%5D=scanlation_group&order%5Bvolume%5D=asc&order%5Bchapter%5D=asc`;
    const feedText = await context.fetchText(feedUrl);
    let feedPayload;
    try {
      feedPayload = JSON.parse(feedText);
    } catch (err) {
      throw new Error(`Failed to parse MangaDex chapter feed: ${err.message}`);
    }

    const entries = Array.isArray(feedPayload?.data) ? feedPayload.data : [];
    allFeedEntries.push(...entries);

    const total = feedPayload?.total || 0;
    if (entries.length === 0 || allFeedEntries.length >= total) {
      break;
    }
    offset += entries.length;
  }

  const seenPaths = new Set();
  const chapters = [];

  for (const entry of allFeedEntries) {
    if (entry.attributes?.externalUrl) continue;

    const langCode = entry.attributes?.translatedLanguage || 'other';
    const langFolder = sanitizePathSegment(resolveLanguageName(langCode));
    const volFolder = sanitizePathSegment(formatVolumeFolder(entry.attributes?.volume));
    const groupName = entry.relationships?.find((r) => r.type === 'scanlation_group')?.attributes?.name || '';
    let chFolder = formatTitleChapterFolder(entry.attributes, groupName);

    const chapterId = entry.id;
    let pathKey = `${langFolder}/${volFolder}/${chFolder}`.toLowerCase();
    if (seenPaths.has(pathKey)) {
      chFolder = sanitizePathSegment(`${chFolder} (${chapterId.slice(0, 8)})`);
      pathKey = `${langFolder}/${volFolder}/${chFolder}`.toLowerCase();
    }
    seenPaths.add(pathKey);

    chapters.push({
      id: `mangadex-${chapterId}`,
      title: `${mangaTitle} - ${formatChapterLabel(entry.attributes)}`,
      sourceUrl: `https://mangadex.org/chapter/${chapterId}`,
      relativePath: [titleFolderName, langFolder, volFolder, chFolder]
    });
  }

  return {
    provider: 'MangaDex',
    isSeries: true,
    title: mangaTitle,
    rootRelativePath: [titleFolderName],
    cleanup: {
      removeMatchingChapters: true,
      removeLooseCovers: false
    },
    cover,
    chapters
  };
}

export async function extractArt(mangaId, url, context = {}, localeFilter = null) {
  if (typeof context.fetchText !== 'function') {
    throw new Error('Context missing fetchText helper for MangaDex API requests');
  }

  const mangaUrl = `https://api.mangadex.org/manga/${mangaId}`;
  const mangaText = await context.fetchText(mangaUrl);
  let mangaPayload;
  try {
    mangaPayload = JSON.parse(mangaText);
  } catch (err) {
    throw new Error(`Failed to parse MangaDex manga API response: ${err.message}`);
  }

  if (mangaPayload?.result === 'error') {
    const errorDetail = mangaPayload.errors?.[0]?.detail || 'Manga not found on MangaDex';
    throw new Error(errorDetail);
  }

  const mangaTitle = resolveMangaTitle(
    mangaPayload?.data?.attributes?.title,
    mangaPayload?.data?.attributes?.altTitles
  );
  const titleFolderName = sanitizePathSegment(mangaTitle);
  const coversRootFolder = sanitizePathSegment(`${titleFolderName} (Covers)`);

  let offset = 0;
  const allCovers = [];
  while (true) {
    const coversApiUrl = `https://api.mangadex.org/cover?manga%5B%5D=${mangaId}&limit=100&offset=${offset}&order%5Bvolume%5D=asc`;
    const coversText = await context.fetchText(coversApiUrl);
    let coversPayload;
    try {
      coversPayload = JSON.parse(coversText);
    } catch (err) {
      throw new Error(`Failed to parse MangaDex covers response: ${err.message}`);
    }

    const entries = Array.isArray(coversPayload?.data) ? coversPayload.data : [];
    allCovers.push(...entries);

    const total = coversPayload?.total || 0;
    if (entries.length === 0 || allCovers.length >= total) {
      break;
    }
    offset += entries.length;
  }

  if (allCovers.length === 0) {
    throw new Error('No cover art found for this manga');
  }

  const covers = [];
  for (const c of allCovers) {
    const rawFileName = c.attributes?.fileName;
    if (!rawFileName) continue;
    const dotIdx = rawFileName.lastIndexOf('.');
    const ext = dotIdx > 0 ? rawFileName.slice(dotIdx).toLowerCase() : '.jpg';
    const hash = dotIdx > 0 ? rawFileName.slice(0, dotIdx) : rawFileName;
    const vol = c.attributes?.volume;
    const num = (vol !== null && vol !== undefined && vol !== '' && !isNaN(parseFloat(vol))) ? parseFloat(vol) : null;

    const filenames = [rawFileName];
    if (mangaTitle && mangaTitle !== 'Unknown Manga') {
      if (num !== null) {
        filenames.push(`${sanitizePathSegment(`${mangaTitle} - Vol. ${vol} Cover`)}${ext}`);
        filenames.push(`${sanitizePathSegment(`${mangaTitle} - Vol. ${String(num).padStart(2, '0')} Cover`)}${ext}`);
      } else if (vol && String(vol).trim()) {
        filenames.push(`${sanitizePathSegment(`${mangaTitle} - Vol. ${vol} Cover`)}${ext}`);
      } else {
        filenames.push(`${sanitizePathSegment(`${mangaTitle} Cover`)}${ext}`);
      }
    }

    covers.push({
      rawFileName,
      hash,
      volume: vol || null,
      filenames,
      url: `https://uploads.mangadex.org/covers/${mangaId}/${rawFileName}`
    });
  }

  const localeGroups = new Map();
  for (const c of allCovers) {
    const rawLoc = c.attributes?.locale;
    const loc = (rawLoc && typeof rawLoc === 'string') ? rawLoc.toLowerCase().trim() : 'other';
    if (!localeGroups.has(loc)) localeGroups.set(loc, []);
    localeGroups.get(loc).push(c);
  }

  const buildImageList = (groupCovers) => {
    const sorted = [...groupCovers].sort((a, b) => {
      const volA = a.attributes?.volume;
      const volB = b.attributes?.volume;
      const numA = (volA !== null && volA !== undefined && volA !== '' && !isNaN(parseFloat(volA))) ? parseFloat(volA) : null;
      const numB = (volB !== null && volB !== undefined && volB !== '' && !isNaN(parseFloat(volB))) ? parseFloat(volB) : null;
      if (numA !== null && numB !== null) return numA - numB;
      if (numA !== null) return -1;
      if (numB !== null) return 1;
      return (a.attributes?.version || 0) - (b.attributes?.version || 0);
    });

    let maxNum = 0;
    for (const c of sorted) {
      const v = c.attributes?.volume;
      if (v !== null && v !== undefined && v !== '' && !isNaN(parseFloat(v))) {
        maxNum = Math.max(maxNum, Math.floor(parseFloat(v)));
      }
    }
    const padWidth = digitPadWidth(maxNum || 1);

    const seenFilenames = new Set();
    const images = [];
    let extraCounter = 1;

    for (const c of sorted) {
      const rawFileName = c.attributes?.fileName;
      if (!rawFileName) continue;
      const dotIdx = rawFileName.lastIndexOf('.');
      const ext = dotIdx > 0 ? rawFileName.slice(dotIdx).toLowerCase() : '.jpg';
      const hash = dotIdx > 0 ? rawFileName.slice(0, dotIdx) : rawFileName;
      const vol = c.attributes?.volume;
      const num = (vol !== null && vol !== undefined && vol !== '' && !isNaN(parseFloat(vol))) ? parseFloat(vol) : null;
      const desc = (c.attributes?.description || '').trim();

      let baseName = '';
      if (num !== null) {
        const padded = String(num).padStart(padWidth, '0');
        baseName = `Vol. ${padded}`;
      } else if (vol && String(vol).trim()) {
        baseName = `Vol. ${sanitizePathSegment(vol)}`;
      } else {
        baseName = desc ? 'Extra' : `Extra ${String(extraCounter++).padStart(2, '0')}`;
      }

      if (desc && !/^https?:\/\//i.test(desc)) {
        const cleanDesc = sanitizePathSegment(desc).slice(0, 40);
        if (cleanDesc) {
          baseName = `${baseName} [${cleanDesc}]`;
        }
      }

      let filename = `${baseName}${ext}`;
      if (seenFilenames.has(filename.toLowerCase())) {
        filename = `${baseName} (${hash.slice(0, 8)})${ext}`;
      }
      seenFilenames.add(filename.toLowerCase());

      images.push({
        url: `https://uploads.mangadex.org/covers/${mangaId}/${rawFileName}`,
        fallbackUrl: `https://uploads.mangadex.org/covers/${mangaId}/${rawFileName}`,
        filename,
        rawFileName,
        hash,
        description: desc || (vol ? `Volume ${vol}` : 'Cover Art')
      });
    }
    return images;
  };

  if (localeFilter) {
    const targetLoc = localeFilter.toLowerCase();
    const groupEntry = [...localeGroups.entries()].find(
      ([code]) => code === targetLoc || resolveLanguageName(code).toLowerCase() === targetLoc
    );

    if (!groupEntry || groupEntry[1].length === 0) {
      throw new Error(`No cover art found for locale: ${localeFilter}`);
    }

    const [matchedCode, groupCovers] = groupEntry;
    const langName = sanitizePathSegment(resolveLanguageName(matchedCode));
    const images = buildImageList(groupCovers);

    return {
      provider: 'MangaDex',
      title: `${mangaTitle} - Covers (${langName})`,
      gallery: {
        id: `mangadex-${mangaId}-covers-${matchedCode}`,
        relativePath: [coversRootFolder, langName]
      },
      images,
      covers,
      cleanup: {
        removeMatchingChapters: false,
        removeLooseCovers: true
      },
      nextPageUrl: null
    };
  }

  if (localeGroups.size === 1) {
    const [singleLoc, groupCovers] = [...localeGroups.entries()][0];
    const langName = sanitizePathSegment(resolveLanguageName(singleLoc));
    const images = buildImageList(groupCovers);

    return {
      provider: 'MangaDex',
      title: `${mangaTitle} - Covers (${langName})`,
      gallery: {
        id: `mangadex-${mangaId}-covers-${singleLoc}`,
        relativePath: [coversRootFolder, langName]
      },
      images,
      covers,
      cleanup: {
        removeMatchingChapters: false,
        removeLooseCovers: true
      },
      nextPageUrl: null
    };
  }

  const chapters = [];
  for (const [loc] of localeGroups.entries()) {
    const langName = sanitizePathSegment(resolveLanguageName(loc));
    chapters.push({
      id: `mangadex-${mangaId}-covers-${loc}`,
      title: `${mangaTitle} - Covers (${langName})`,
      sourceUrl: `https://mangadex.org/title/${mangaId}?tab=art&locale=${loc}`,
      relativePath: [coversRootFolder, langName]
    });
  }

  return {
    provider: 'MangaDex',
    isSeries: true,
    title: `${mangaTitle} (Covers)`,
    rootRelativePath: [coversRootFolder],
    cover: null,
    covers,
    cleanup: {
      removeMatchingChapters: false,
      removeLooseCovers: true
    },
    chapters
  };
}
