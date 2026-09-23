// quivit-deps: shared/sanitize.js
/**
 * direct.js: host-agnostic direct image extractor.
 *
 * Catches plain `https://any-host/path/image.jpg` links no site extractor
 * claims. Manifest patterns are case-sensitive and first match wins, so this
 * entry sits last and spells out the extension case variants. Raster photos
 * only: video stays deferred and SVG/ICO stay out. Downloads land in the
 * provider root and re-imports jump via the recorded sourceUrl, same as
 * every other direct import.
 */

import { sanitizePathSegment } from './shared/sanitize.js';

const DIRECT_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'apng', 'bmp']);
const DIRECT_IMAGE_RE = /^https?:\/\/[^?#]+\.([a-z0-9]+)([?#].*)?$/i;

function matchExt(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(DIRECT_IMAGE_RE);
  if (!m) return null;
  const ext = (m[1] || '').toLowerCase();
  return DIRECT_IMAGE_EXTS.has(ext) ? ext : null;
}

export function match(url) {
  return matchExt(url) !== null;
}

export function isDirectUrl(url) {
  return matchExt(url) !== null;
}

export async function parseDirectUrl(url, context = {}) {
  const ext = matchExt(url);
  if (!ext) return null;

  let host = '';
  let stem = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname || '';
    const encodedLeaf = parsed.pathname.split('/').pop() || '';
    try {
      stem = decodeURIComponent(encodedLeaf).replace(/\.[^.]+$/, '');
    } catch {
      stem = encodedLeaf.replace(/\.[^.]+$/, '');
    }
  } catch {
    return null;
  }

  const filename = `${sanitizePathSegment(stem || 'image')}.${ext}`;
  const slug = `${host}-${stem || 'image'}-${ext}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';

  return {
    provider: 'Misc',
    hash: `direct-${slug}`,
    filename,
    url
  };
}

export async function extract(html, url, context = {}) {
  return { error: `Direct image URLs import as standalone files: ${url}` };
}
