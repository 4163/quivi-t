/**
 * imgur.js: Imgur album and gallery extractor.
 *
 * Parses album/gallery pages by finding the JSON payload embedded
 * in the HTML source. Returns image URLs, filenames, and display names.
 */

const IMGUR_ALBUM_RE = /^https?:\/\/(?:www\.)?imgur\.com\/(?:a|gallery)\/(?:[\w-]+-)?([a-zA-Z0-9]+)/i;
const IMGUR_DIRECT_RE = /^https?:\/\/(?:www\.|i\.)?imgur\.com\/([a-zA-Z0-9]+)\.([a-zA-Z0-9]+)$/i;
const IMGUR_SINGLE_RE = /^https?:\/\/(?:www\.)?imgur\.com\/([a-zA-Z0-9]+)$/i;

// Imgur embeds album data as a JSON object inside a <script> tag.
// The shape and variable name change over time; these patterns
// cover the known variants as of 2026.
const DATA_PATTERNS = [
  /window\.postDataJSON\s*=\s*"(.+?)(?<!\\)"/s,
  /"album_images"\s*:\s*(\{.+?\})\s*[,}]/s,
  /"media"\s*:\s*(\[.+?\])\s*[,}]/s
];

const FILENAME_FORBIDDEN_RE = /[<>:"/\\|?*\x00-\x1F]/g;
const FILENAME_MAX_LEN = 80;
const PATH_SEGMENT_MAX_LEN = 100;
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function sanitizePathSegment(value) {
  let sanitized = String(value || 'Untitled Gallery')
    .replace(FILENAME_FORBIDDEN_RE, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!sanitized) return 'Untitled Gallery';
  if (RESERVED_DEVICE_NAMES.test(sanitized)) sanitized = `_${sanitized}`;
  if (sanitized.length > PATH_SEGMENT_MAX_LEN) {
    sanitized = sanitized.slice(0, PATH_SEGMENT_MAX_LEN).replace(/[. ]+$/, '');
  }
  return sanitized || 'Untitled Gallery';
}

function stripMatchingFormat(description, extension) {
  if (!description || typeof description !== 'string') return '';

  const cleanDescription = description.trim();
  const normalizedExtension = typeof extension === 'string' && extension.startsWith('.')
    ? extension.toLowerCase()
    : `.${String(extension || '').toLowerCase()}`;

  if (!normalizedExtension || !cleanDescription.toLowerCase().endsWith(normalizedExtension)) {
    return cleanDescription;
  }

  return cleanDescription.slice(0, -normalizedExtension.length).trim();
}

function sanitizeDescription(description, extension) {
  let sanitized = stripMatchingFormat(description, extension)
    .replace(FILENAME_FORBIDDEN_RE, '_')
    .trim()
    .replace(/[. ]+$/, '');

  if (sanitized.length > FILENAME_MAX_LEN) {
    sanitized = sanitized.slice(0, FILENAME_MAX_LEN).replace(/[. ]+$/, '');
  }

  return sanitized;
}

function digitPadWidth(count) {
  if (count <= 0) return 1;
  return Math.max(1, Math.ceil(Math.log10(count + 1)));
}

function formatFilename(index, total, extension, description) {
  const itemNumber = String(index + 1).padStart(digitPadWidth(total), '0');
  return description ? `${itemNumber}_${description}${extension}` : `${itemNumber}${extension}`;
}

export function parseDirectUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(IMGUR_DIRECT_RE);
  if (!m) return null;
  const hash = m[1];
  const ext = `.${m[2].toLowerCase()}`;
  return {
    provider: 'Imgur',
    hash,
    ext,
    filename: `${hash}${ext}`,
    url: `https://i.imgur.com/${hash}${ext}`
  };
}

export function isDirectUrl(url) {
  return IMGUR_DIRECT_RE.test(url);
}

export function match(url) {
  return IMGUR_ALBUM_RE.test(url) || IMGUR_DIRECT_RE.test(url) || IMGUR_SINGLE_RE.test(url);
}

export async function extract(html, url, context = {}) {
  const direct = parseDirectUrl(url);
  if (direct) {
    return {
      provider: 'Imgur',
      title: `Imgur ${direct.hash}`,
      images: [{
        url: direct.url,
        filename: direct.filename,
        displayName: direct.hash
      }],
      nextPageUrl: null
    };
  }

  const albumMatch = url.match(IMGUR_ALBUM_RE);
  const singleMatch = !albumMatch ? url.match(IMGUR_SINGLE_RE) : null;
  const albumId = albumMatch ? albumMatch[1] : (singleMatch ? singleMatch[1] : 'unknown');

  // Accumulate raw entries first; format filenames after total count is known.
  const rawEntries = [];
  let title = null;

  // 1. Try embedded data patterns in HTML source.
  for (const pattern of DATA_PATTERNS) {
    const m = html.match(pattern);
    if (!m) continue;

    let data;
    try {
      // postDataJSON stores its value as a JSON-encoded string (double-escaped).
      const raw = m[1].startsWith('{') || m[1].startsWith('[')
        ? m[1]
        : JSON.parse(`"${m[1]}"`);
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      continue;
    }

    if (data.title) title = data.title;

    let entries = [];
    if (Array.isArray(data)) {
      entries = data;
    } else if (data.images && Array.isArray(data.images)) {
      entries = data.images;
    } else if (data.album_images?.images) {
      entries = data.album_images.images;
    }

    for (const entry of entries) {
      if (!entry) continue;

      const hash = entry.hash || entry.id || entry.name || '';
      const ext = entry.ext || entry.type?.split('/')?.pop() || '.jpg';
      const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;

      let imageUrl = entry.url || entry.link || '';
      if (!imageUrl && hash) {
        imageUrl = `https://i.imgur.com/${hash}${normalizedExt}`;
      }
      if (!imageUrl) continue;

      rawEntries.push({
        url: imageUrl,
        ext: normalizedExt,
        description: entry.title || entry.description || ''
      });
    }

    if (rawEntries.length > 0) break;
  }

  // 2. AJAX fallback for modern SPA pages.
  if (rawEntries.length === 0 && context.fetchText && albumId !== 'unknown') {
    try {
      const ajaxUrl = `https://imgur.com/ajaxalbums/getimages/${albumId}/format/json`;
      const ajaxBody = await context.fetchText(ajaxUrl);
      const ajaxData = JSON.parse(ajaxBody);
      const albumImages = ajaxData?.data?.images || [];

      for (const entry of albumImages) {
        if (!entry || !entry.hash) continue;

        const ext = entry.ext || '.jpg';
        const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
        const imageUrl = `https://i.imgur.com/${entry.hash}${normalizedExt}`;

        rawEntries.push({
          url: imageUrl,
          ext: normalizedExt,
          description: entry.title || entry.description || ''
        });
      }
    } catch {
      // Continue to meta tag fallback.
    }
  }

  // 3. Fallback: og:image meta tags.
  if (rawEntries.length === 0) {
    const ogMatches = html.matchAll(/<meta\s+[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/gi);
    for (const ogm of ogMatches) {
      const imageUrl = ogm[1];
      if (imageUrl && !imageUrl.includes('logo')) {
        rawEntries.push({
          url: imageUrl,
          ext: '.jpg',
          description: ''
        });
      }
    }
  }

  const total = rawEntries.length;
  const images = rawEntries.map((entry, index) => {
    const description = sanitizeDescription(entry.description, entry.ext);
    return {
      url: entry.url,
      filename: formatFilename(index, total, entry.ext, description),
      displayName: description || `Image ${index + 1}`,
      description
    };
  });

  if (!title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].replace(/\s*[-–—]\s*(?:Album on\s*)?Imgur\s*$/i, '').trim();
    }
  }

  const galleryTitle = title || `Imgur ${albumId}`;
  return {
    provider: 'Imgur',
    title: galleryTitle,
    gallery: {
      id: `imgur-${albumId}`,
      relativePath: [sanitizePathSegment(galleryTitle)]
    },
    images,
    nextPageUrl: null
  };
}
