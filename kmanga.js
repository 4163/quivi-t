// quivit-deps: shared/kmanga.js, shared/sanitize.js
// quivit-needs: fetchBytes, requestHeaders, tileDescramble
/**
 * kmanga.js: K MANGA episode and series extractor.
 *
 * Thin entry shell over the shared viewer client. Matches episode,
 * title, and direct CDN URLs. Series metadata comes from page HTML;
 * viewer API provides scramble seeds and signed page URLs.
 */

import {
  parseKmangaEpisodeUrl,
  fetchViewerPages,
  fetchEpisodeDetail,
  buildKmangaImages,
  parseNuxtData,
  unflattenNuxtData
} from './shared/kmanga.js';
import { sanitizePathSegment } from './shared/sanitize.js';

const KMANGA_EPISODE_RE = /^https?:\/\/kmanga\.kodansha\.com\/title\/(\d+)\/episode\/(\d+)/i;
const KMANGA_TITLE_RE = /^https?:\/\/kmanga\.kodansha\.com\/title\/(\d+)/i;
const KMANGA_CDN_RE = /^https?:\/\/cdn\.kmanga\.kodansha\.com\/(.+?)(?:\.([a-z0-9]+))(?:[?#].*)?$/i;
const CDN_TITLE_RE = /\/static\/titles\/(\d+)\//;
const CDN_EPISODE_RE = /\/static\/titles\/(\d+)\/episodes\/(\d+)\//;
const CDN_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']);

export function match(url) {
  if (!url || typeof url !== 'string') return false;
  return KMANGA_EPISODE_RE.test(url) || KMANGA_TITLE_RE.test(url) || KMANGA_CDN_RE.test(url);
}

export function isDirectUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return KMANGA_CDN_RE.test(url);
}

export async function parseDirectUrl(url, context = {}) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(KMANGA_CDN_RE);
  if (!m) return null;
  const ext = m[2].toLowerCase();
  if (!CDN_IMAGE_EXTENSIONS.has(ext)) return null;
  const stem = (m[1].split('/').pop() || 'image').replace(/[^a-z0-9_-]/gi, '_');
  const hash = `kmanga-${stem}`;

  const epMatch = url.match(CDN_EPISODE_RE);
  const titleMatch = url.match(CDN_TITLE_RE);
  let filename = `${hash}.${ext}`;

  if (titleMatch) {
    const titleId = titleMatch[1];
    let titleName = '';
    let meta = null;
    if (typeof context?.fetchText === 'function' || typeof context?.fetchBytes === 'function') {
      try {
        const fetchFn = context.fetchText || (async (u) => new TextDecoder().decode(await context.fetchBytes(u)));
        const html = await fetchFn(`https://kmanga.kodansha.com/title/${titleId}`);
        meta = extractTitleFromHtml(html);
        if (meta?.titleName) titleName = meta.titleName;
      } catch { /* fall through to fallback */ }
    }

    if (epMatch) {
      const epId = epMatch[2];
      let chLabel = `Ep ${epId}`;
      if (meta) {
        const epIdx = meta.episodeIds.indexOf(Number(epId));
        if (epIdx >= 0) chLabel = `Ch. ${epIdx + 1}`;
      }
      const base = titleName
        ? sanitizePathSegment(`${titleName} - ${chLabel} Cover`)
        : sanitizePathSegment(`K MANGA ${titleId} - ${chLabel} Cover`);
      filename = `${base}.${ext}`;
    } else {
      const base = titleName
        ? sanitizePathSegment(`${titleName} Cover`)
        : sanitizePathSegment(`K MANGA ${titleId} - Cover`);
      filename = `${base}.${ext}`;
    }
  }

  return {
    provider: 'K MANGA',
    hash,
    filename,
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
    episodeIds: titleObj.episode_id_list || [],
    freeEpisodeCount: titleObj.free_episode_count ?? 0
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
  const seriesName = titleMeta?.titleName || `K MANGA ${titleId}`;
  const epMeta = extractEpisodeMetaFromHtml(html, episodeId);
  const rawEpName = epMeta?.episode_name != null ? String(epMeta.episode_name) : '';
  const chapterLabel = rawEpName ? `Ch. ${rawEpName}` : `Ch. ${episodeId}`;

  let viewer;
  try {
    viewer = await fetchViewerPages(episodeId, context);
  } catch (err) {
    return { error: err?.message || 'K MANGA viewer request failed.' };
  }

  if (viewer.pages.length === 0) {
    return { error: 'No pages found - this episode may require a rental or subscription.' };
  }

  const images = buildKmangaImages(viewer.pages, viewer.scrambleSeed, titleId, episodeId);

  // Prepend chapter cover thumbnail as page 0 (no descramble)
  const thumbUrl = epMeta?.thumbnail_image_url || '';
  if (thumbUrl) {
    const thumbExt = (thumbUrl.match(/\.(\w+)(?:\?|$)/)?.[1] || 'png').toLowerCase();
    const padWidth = Math.max(2, Math.ceil(Math.log10(Math.max(2, viewer.pages.length + 1))));
    images.unshift({ url: thumbUrl, filename: `${'0'.padStart(padWidth, '0')}.${thumbExt}` });
  }

  const fullTitle = `${seriesName} - ${chapterLabel}`;
  const folderName = sanitizePathSegment(fullTitle);

  const metadata = {
    ComicInfo: {
      Series: seriesName,
      Title: chapterLabel,
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
    provider: 'K MANGA',
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

async function extractTitle(titleId, html, url, context) {
  const titleMeta = extractTitleFromHtml(html);
  if (!titleMeta || !titleMeta.titleName) {
    return { error: 'Could not extract K MANGA title metadata from page.' };
  }

  const seriesName = titleMeta.titleName;
  const seriesDir = sanitizePathSegment(seriesName);
  const allEpisodeIds = titleMeta.episodeIds;

  if (allEpisodeIds.length === 0) {
    return { error: 'No episodes found for this title.' };
  }

  // Try the episode detail API first to verify truly-free status
  // (point === 0). If the API is unavailable, fall back to
  // free_episode_count from HTML which may include login-free episodes.
  const candidateCount = Math.min(
    titleMeta.freeEpisodeCount || allEpisodeIds.length,
    allEpisodeIds.length
  );
  let freeEpisodeIds = [];
  let apiAvailable = true;
  for (let i = 0; i < candidateCount; i++) {
    try {
      const detail = await fetchEpisodeDetail(allEpisodeIds[i], context);
      if (!detail || detail.point !== 0) break;
      freeEpisodeIds.push({ id: allEpisodeIds[i], name: detail.episodeName, thumbnailUrl: detail.thumbnailUrl });
    } catch {
      if (i === 0) apiAvailable = false;
      break;
    }
  }

  // Fallback: use free_episode_count from HTML when the API is unreachable.
  // The first episode's Nuxt data provides thumbnail for ch 1.
  if (!apiAvailable && candidateCount > 0) {
    const firstEp = extractEpisodeMetaFromHtml(html, allEpisodeIds[0]);
    freeEpisodeIds = allEpisodeIds.slice(0, candidateCount).map((id, i) => ({
      id,
      name: i === 0 && firstEp?.episode_name != null ? String(firstEp.episode_name) : String(i + 1),
      thumbnailUrl: i === 0 ? (firstEp?.thumbnail_image_url || '') : ''
    }));
  }

  if (freeEpisodeIds.length === 0) {
    return { error: 'No free episodes available for this title.' };
  }

  const padWidth = Math.max(2, Math.ceil(Math.log10(Math.max(2, freeEpisodeIds.length + 1))));
  const chapters = freeEpisodeIds.map((ep, index) => {
    const num = String(index + 1).padStart(padWidth, '0');
    const chLabel = ep.name ? `Ch. ${ep.name}` : `Ch. ${num}`;
    const chFolder = sanitizePathSegment(chLabel);
    const sourceUrl = `https://kmanga.kodansha.com/title/${titleId}/episode/${ep.id}`;

    return {
      id: `kmanga-${ep.id}`,
      title: `${seriesName} - ${chLabel}`,
      sourceUrl,
      relativePath: [seriesDir, chFolder],
      cover: ep.thumbnailUrl ? { url: ep.thumbnailUrl, filename: `${chLabel} Cover.png` } : null,
      metadata: {
        ComicInfo: {
          Series: seriesName,
          Title: chLabel,
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

  const coverExt = (titleMeta.coverUrl.match(/\.(\w+)(?:\?|$)/)?.[1] || 'jpg').toLowerCase();
  const cover = titleMeta.coverUrl
    ? { url: titleMeta.coverUrl, filename: `Cover.${coverExt}` }
    : null;

  return {
    provider: 'K MANGA',
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
    return await extractTitle(parseInt(titleMatch[1], 10), html, url, context);
  }

  return { error: 'URL does not match a K MANGA episode or title.' };
}
