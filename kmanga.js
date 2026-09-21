// quivit-deps: shared/kmanga.js, shared/sanitize.js
// quivit-needs: fetchBytes, requestHeaders, tileDescramble
/**
 * kmanga.js: K-Manga episode and series extractor.
 *
 * Thin entry shell over the shared viewer client. Matches episode,
 * title, and direct CDN URLs. Series metadata comes from page HTML;
 * viewer API provides scramble seeds and signed page URLs.
 */

import {
  parseKmangaEpisodeUrl,
  fetchViewerPages,
  buildKmangaImages,
  parseNuxtData,
  unflattenNuxtData
} from './shared/kmanga.js';
import { sanitizePathSegment } from './shared/sanitize.js';

const KMANGA_EPISODE_RE = /^https?:\/\/kmanga\.kodansha\.com\/title\/(\d+)\/episode\/(\d+)/i;
const KMANGA_TITLE_RE = /^https?:\/\/kmanga\.kodansha\.com\/title\/(\d+)/i;
const KMANGA_CDN_RE = /^https?:\/\/cdn\.kmanga\.kodansha\.com\/(.+?)(?:\.([a-z0-9]+))(?:[?#].*)?$/i;
const CDN_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']);

export function match(url) {
  if (!url || typeof url !== 'string') return false;
  return KMANGA_EPISODE_RE.test(url) || KMANGA_TITLE_RE.test(url) || KMANGA_CDN_RE.test(url);
}

export function isDirectUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return KMANGA_CDN_RE.test(url);
}

export function parseDirectUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(KMANGA_CDN_RE);
  if (!m) return null;
  const ext = m[2].toLowerCase();
  if (!CDN_IMAGE_EXTENSIONS.has(ext)) return null;
  const stem = (m[1].split('/').pop() || 'image').replace(/[^a-z0-9_-]/gi, '_');
  const hash = `kmanga-${stem}`;
  return {
    provider: 'K-Manga',
    hash,
    filename: `${hash}.${ext}`,
    url
  };
}

// -- HTML metadata extraction --

function findInUnflattened(root, predicate) {
  const seen = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (predicate(node)) return node;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
    } else {
      for (const v of Object.values(node)) {
        const found = walk(v);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(root);
}

function extractTitleFromHtml(html) {
  if (!html) return null;
  const raw = parseNuxtData(html);
  if (!raw) return null;
  const unflattened = unflattenNuxtData(raw);
  if (!unflattened) return null;

  const titleObj = findInUnflattened(unflattened.root, (o) =>
    o && typeof o.title_name === 'string' && Array.isArray(o.episode_id_list)
  ) || findInUnflattened(unflattened.all, (o) =>
    o && typeof o.title_name === 'string' && Array.isArray(o.episode_id_list)
  );
  if (!titleObj) return null;

  return {
    titleName: titleObj.title_name || '',
    authorText: titleObj.author_text || '',
    synopsis: titleObj.introduction_text || titleObj.synopsis || '',
    coverUrl: titleObj.thumbnail_rect_image_url || titleObj.banner_image_url || titleObj.title_grid_wide || '',
    episodeIds: titleObj.episode_id_list || []
  };
}

function extractEpisodeMetaFromHtml(html, episodeId) {
  if (!html) return null;
  const raw = parseNuxtData(html);
  if (!raw) return null;
  const unflattened = unflattenNuxtData(raw);
  if (!unflattened) return null;

  const ep = findInUnflattened(unflattened.root, (o) =>
    o && (o.episode_id === episodeId || String(o.episode_id) === String(episodeId))
    && (o.episode_name !== undefined)
  ) || findInUnflattened(unflattened.all, (o) =>
    o && (o.episode_id === episodeId || String(o.episode_id) === String(episodeId))
    && (o.episode_name !== undefined)
  );
  return ep || null;
}

// -- Episode extraction --

async function extractEpisode(titleId, episodeId, html, url, context) {
  const titleMeta = extractTitleFromHtml(html);
  const seriesName = titleMeta?.titleName || `K-Manga ${titleId}`;
  const epMeta = extractEpisodeMetaFromHtml(html, episodeId);
  const rawEpName = epMeta?.episode_name != null ? String(epMeta.episode_name) : '';
  const episodeName = rawEpName.toLowerCase().startsWith('episode')
    ? rawEpName
    : (rawEpName ? `Episode ${rawEpName}` : `Episode ${episodeId}`);

  let viewer;
  try {
    viewer = await fetchViewerPages(episodeId, context);
  } catch (err) {
    return { error: err?.message || 'K-Manga viewer request failed.' };
  }

  if (viewer.pages.length === 0) {
    return { error: 'No pages found - this episode may require a rental or subscription.' };
  }

  const images = buildKmangaImages(viewer.pages, viewer.scrambleSeed, titleId, episodeId);
  const fullTitle = `${seriesName} - ${episodeName}`;
  const folderName = sanitizePathSegment(fullTitle);

  const metadata = {
    ComicInfo: {
      Series: seriesName,
      Title: episodeName,
      Writer: titleMeta?.authorText || undefined,
      Summary: titleMeta?.synopsis || undefined,
      PageCount: images.length,
      Manga: 'YesAndRightToLeft',
      Web: url
    }
  };

  for (const [k, v] of Object.entries(metadata.ComicInfo)) {
    if (v === undefined) delete metadata.ComicInfo[k];
  }

  return {
    provider: 'K-Manga',
    title: fullTitle,
    gallery: {
      id: `kmanga-${episodeId}`,
      relativePath: [folderName]
    },
    images,
    metadata,
    nextPageUrl: null
  };
}

// -- Title/series extraction --

async function extractTitle(titleId, html, url) {
  const titleMeta = extractTitleFromHtml(html);
  if (!titleMeta || !titleMeta.titleName) {
    return { error: 'Could not extract K-Manga title metadata from page.' };
  }

  const seriesName = titleMeta.titleName;
  const seriesDir = sanitizePathSegment(seriesName);
  const episodeIds = titleMeta.episodeIds;

  if (episodeIds.length === 0) {
    return { error: 'No episodes found for this title.' };
  }

  const padWidth = Math.max(2, Math.ceil(Math.log10(Math.max(2, episodeIds.length + 1))));
  const chapters = episodeIds.map((epId, index) => {
    const num = String(index + 1).padStart(padWidth, '0');
    const epLabel = `Episode ${num}`;
    const epFolder = sanitizePathSegment(epLabel);
    const sourceUrl = `https://kmanga.kodansha.com/title/${titleId}/episode/${epId}`;

    return {
      id: `kmanga-${epId}`,
      title: `${seriesName} - ${epLabel}`,
      sourceUrl,
      relativePath: [seriesDir, epFolder],
      metadata: {
        ComicInfo: {
          Series: seriesName,
          Title: epLabel,
          Writer: titleMeta.authorText || undefined,
          Manga: 'YesAndRightToLeft',
          Web: sourceUrl
        }
      }
    };
  });

  const metadata = {
    ComicInfo: {
      Series: seriesName,
      Writer: titleMeta.authorText || undefined,
      Summary: titleMeta.synopsis || undefined,
      Manga: 'YesAndRightToLeft',
      Web: url
    }
  };

  for (const [k, v] of Object.entries(metadata.ComicInfo)) {
    if (v === undefined) delete metadata.ComicInfo[k];
  }

  const cover = titleMeta.coverUrl
    ? { url: titleMeta.coverUrl, filename: 'Cover.jpg' }
    : null;

  return {
    provider: 'K-Manga',
    isSeries: true,
    title: seriesName,
    rootRelativePath: [seriesDir],
    metadata,
    cover,
    folders: [],
    cleanup: {
      removeMatchingChapters: true,
      removeLooseCovers: true
    },
    chapters
  };
}

// -- Main entry --

export async function extract(html, url, context = {}) {
  const episodeMatch = parseKmangaEpisodeUrl(url);
  if (episodeMatch) {
    return await extractEpisode(episodeMatch.titleId, episodeMatch.episodeId, html, url, context);
  }

  const titleMatch = url.match(KMANGA_TITLE_RE);
  if (titleMatch) {
    return await extractTitle(parseInt(titleMatch[1], 10), html, url);
  }

  return { error: 'URL does not match a K-Manga episode or title.' };
}
