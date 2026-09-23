// quivit-deps: shared/sanitize.js
/**
 * direct.js: host-agnostic direct image extractor.
 *
 * Catches plain `https://any-host/path/image.jpg` links no site extractor
 * claims. Manifest patterns are case-sensitive and first match wins, so this
 * entry sits last and spells out the extension case variants. Raster photos
 * plus SVG: vectors arrive as DOMPurify-sanitized text, never raw bytes, via
 * the sanitized download path in urlLoader.js. Video stays deferred.
 * .ico support is deferred until Rust backend JS ports are complete.
 * Downloads land in the provider root and re-imports jump via the recorded sourceUrl, same as
 * every other direct import.
 */

import { sanitizePathSegment } from './shared/sanitize.js';

const DIRECT_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'apng', 'bmp', 'svg']);
const DIRECT_IMAGE_RE = /^https?:\/\/[^?#]+\.([a-z0-9]+)([?#].*)?$/i;

// First-byte signatures. A page that ends in an image extension but serves
// a document (viewer and preview pages do this) must fail here, never as a
// saved HTML file. Anything inconclusive passes through untouched.
const SNIFF_LEN = 1024;

function sniffKind(head, ext) {
  const raw = new TextDecoder().decode(head);
  const lower = raw.replace(/^\uFEFF/, '').trimStart().slice(0, 64).toLowerCase();
  if (lower.startsWith('<html') || lower.startsWith('<!doctype html')) return 'document';
  if (ext === 'svg') return sniffSvgRoot(raw, head.length);
  const sig = (off, bytes) => bytes.every((b, i) => head[off + i] === b);
  const ascii = (off, s) => [...s].every((c, i) => head[off + i] === c.charCodeAt(0));
  switch (ext) {
    case 'png':
    case 'apng':
      if (head.length < 8) return 'unknown';
      return sig(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) ? 'image' : 'mismatch';
    case 'jpg':
    case 'jpeg':
      if (head.length < 2) return 'unknown';
      return sig(0, [0xFF, 0xD8]) ? 'image' : 'mismatch';
    case 'gif':
      if (head.length < 6) return 'unknown';
      return ascii(0, 'GIF87a') || ascii(0, 'GIF89a') ? 'image' : 'mismatch';
    case 'bmp':
      if (head.length < 2) return 'unknown';
      return ascii(0, 'BM') ? 'image' : 'mismatch';
    case 'webp':
      if (head.length < 12) return 'unknown';
      return ascii(0, 'RIFF') && ascii(8, 'WEBP') ? 'image' : 'mismatch';
    case 'avif':
      if (head.length < 12) return 'unknown';
      return ascii(4, 'ftyp') ? 'image' : 'mismatch';
    default:
      return 'unknown';
  }
}

// A genuine SVG opens with <svg> once the prolog (XML declaration,
// comments, doctype) is set aside. Page chrome fails this no matter its
// shape: full documents start with <html>, and streamed fragments like
// icon collections start with whatever chrome tag comes first. A window
// with no tags at all (long Illustrator prologs run past it) stays
// inconclusive: the full-text gate downstream sees the whole file and
// decides there.
function sniffSvgRoot(raw) {
  const stripped = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!doctype(?:[^[\]>]|\[[^\]]*\])*>/gi, '');
  const first = stripped.match(/<\s*([a-zA-Z][\w.-]*)/);
  if (!first) return 'unknown';
  return first[1].toLowerCase() === 'svg' ? 'image' : 'mismatch';
}

function decodeHead(data) {
  if (typeof data === 'string') {
    const bin = atob(data);
    const len = Math.min(bin.length, SNIFF_LEN);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (data instanceof Uint8Array) return data.slice(0, SNIFF_LEN);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0, SNIFF_LEN));
  if (Array.isArray(data)) return Uint8Array.from(data.slice(0, SNIFF_LEN));
  throw new Error('unrecognized byte container');
}

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

  await rejectDocumentPage(url, ext, context);

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

// Proves the address serves bytes matching its extension before anything
// is saved. A ranged first kilobyte keeps this cheap; hosts that ignore the
// range cost one full read, and any inconclusive answer passes through so a
// sniff failure never blocks a real file.
async function rejectDocumentPage(url, ext, context) {
  const fetchBytes = context?.fetchBytes;
  if (typeof fetchBytes !== 'function') return;
  let head;
  try {
    head = decodeHead(await fetchBytes(url, { Range: `bytes=0-${SNIFF_LEN - 1}` }));
  } catch (err) {
    console.warn(`[direct] content sniff failed, passing through: ${err?.message || err}`);
    return;
  }
  const kind = sniffKind(head, ext);
  if (kind === 'document' || kind === 'mismatch') {
    throw new Error(`URL serves a document page, not an image file: ${url}`);
  }
}

export async function extract(html, url, context = {}) {
  return { error: `Direct image URLs import as standalone files: ${url}` };
}
