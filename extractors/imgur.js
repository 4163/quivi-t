/**
 * imgur.js: Imgur album and gallery extractor.
 *
 * Parses album/gallery pages by finding the JSON payload embedded
 * in the HTML source. Returns image URLs, filenames, and display names.
 */

const IMGUR_URL_RE = /^https?:\/\/(www\.)?imgur\.com\/(a|gallery)\/(?:[\w-]+-)?([a-zA-Z0-9]+)/;

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

function sanitizeDescription(desc) {
  if (!desc || typeof desc !== 'string') return '';
  let s = desc.replace(FILENAME_FORBIDDEN_RE, '_').trim().replace(/[. ]+$/, '');
  if (s.length > FILENAME_MAX_LEN) {
    s = s.slice(0, FILENAME_MAX_LEN).replace(/[. ]+$/, '');
  }
  return s;
}

function digitPadWidth(count) {
  if (count <= 0) return 1;
  return Math.max(1, Math.ceil(Math.log10(count + 1)));
}

function formatFilename(index, total, ext, description) {
  const padded = String(index + 1).padStart(digitPadWidth(total), '0');
  const clean = sanitizeDescription(description);
  return clean ? `${padded}_${clean}${ext}` : `${padded}${ext}`;
}

export function match(url) {
  return IMGUR_URL_RE.test(url);
}

export async function extract(html, url, context = {}) {
  const urlMatch = url.match(IMGUR_URL_RE);
  const albumId = urlMatch ? urlMatch[3] : 'unknown';

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
        description: entry.title || entry.description || '',
        displayName: entry.title || entry.description || ''
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
          description: entry.title || entry.description || '',
          displayName: entry.title || entry.description || ''
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
          description: '',
          displayName: ''
        });
      }
    }
  }

  // Format filenames with correct digit padding now that total count is known.
  const total = rawEntries.length;
  const images = rawEntries.map((entry, i) => ({
    url: entry.url,
    filename: formatFilename(i, total, entry.ext, entry.description),
    displayName: entry.displayName || `Image ${i + 1}`
  }));

  if (!title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].replace(/\s*[-–—]\s*(?:Album on\s*)?Imgur\s*$/i, '').trim();
    }
  }

  return {
    provider: 'Imgur',
    title: title || `Imgur ${albumId}`,
    images,
    nextPageUrl: null
  };
}
