/**
 * imgur.js: Imgur album and gallery extractor.
 *
 * Parses album/gallery pages by finding the JSON payload embedded
 * in the HTML source. Returns image URLs, filenames, and display names.
 */

const IMGUR_URL_RE = /^https?:\/\/(www\.)?imgur\.com\/(a|gallery)\/([a-zA-Z0-9]+)/;

// Imgur embeds album data as a JSON object inside a <script> tag.
// The shape and variable name change over time; these patterns
// cover the known variants as of 2026.
const DATA_PATTERNS = [
  /window\.postDataJSON\s*=\s*"(.+?)(?<!\\)"/s,
  /"album_images"\s*:\s*(\{.+?\})\s*[,}]/s,
  /"media"\s*:\s*(\[.+?\])\s*[,}]/s
];

export function match(url) {
  return IMGUR_URL_RE.test(url);
}

export function extract(html, url) {
  const urlMatch = url.match(IMGUR_URL_RE);
  const albumId = urlMatch ? urlMatch[3] : 'unknown';

  const images = [];
  let title = null;

  // Try each known data pattern.
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

    // Extract title from the top-level object if available.
    if (data.title) title = data.title;

    // Normalize to an array of image entries.
    let entries = [];
    if (Array.isArray(data)) {
      entries = data;
    } else if (data.images && Array.isArray(data.images)) {
      entries = data.images;
    } else if (data.album_images?.images) {
      entries = data.album_images.images;
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;

      // Build the direct image URL from the hash and extension.
      const hash = entry.hash || entry.id || entry.name || '';
      const ext = entry.ext || entry.type?.split('/')?.pop() || '.jpg';
      const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;

      let imageUrl = entry.url || entry.link || '';
      if (!imageUrl && hash) {
        imageUrl = `https://i.imgur.com/${hash}${normalizedExt}`;
      }

      if (!imageUrl) continue;

      const idx = String(i + 1).padStart(3, '0');
      images.push({
        url: imageUrl,
        filename: `${idx}${normalizedExt}`,
        displayName: entry.title || entry.description || `Image ${i + 1}`
      });
    }

    if (images.length > 0) break;
  }

  // Fallback: scrape og:image or direct image links from meta tags.
  if (images.length === 0) {
    const ogMatches = html.matchAll(/<meta\s+property="og:image"\s+content="([^"]+)"/gi);
    let i = 0;
    for (const ogm of ogMatches) {
      const imageUrl = ogm[1];
      if (imageUrl && !imageUrl.includes('logo')) {
        images.push({
          url: imageUrl,
          filename: `${String(i + 1).padStart(3, '0')}.jpg`,
          displayName: `Image ${i + 1}`
        });
        i++;
      }
    }
  }

  // Fallback title from <title> tag.
  if (!title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].replace(/\s*[-–—]\s*Imgur\s*$/i, '').trim();
    }
  }

  return {
    provider: 'imgur',
    title: title || `Imgur ${albumId}`,
    images,
    nextPageUrl: null
  };
}
