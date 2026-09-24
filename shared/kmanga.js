/**
 * shared/kmanga.js: K MANGA viewer client shared by extractors.
 *
 * Pure functions of (episodeId, context). No match/extract exports,
 * never a manifest entry. Consumed by the K MANGA entry shell and
 * by mangadex.js for externalUrl chapters.
 *
 * Rate limiting uses adaptive timestamp throttling so the initial request fires
 * immediately without artificial sleep delay.
 */

const KMANGA_EPISODE_RE = /^https?:\/\/kmanga\.kodansha\.com\/title\/(\d+)\/episode\/(\d+)/i;
const SE_API_BASE = 'https://se-api.kmanga.kodansha.com';
const RATE_LIMIT_MS = 300;
let lastKmangaRequestTime = 0;

async function throttleKmangaRequest() {
  const now = Date.now();
  const elapsed = now - lastKmangaRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastKmangaRequestTime = Date.now();
}
const CHARSET_EVEN = 'we7ru3ty8i';
const CHARSET_ODD = 'h4xm9bqz1p';

// -- URL parsing --

export function parseKmangaEpisodeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(KMANGA_EPISODE_RE);
  if (!m) return null;
  return { titleId: parseInt(m[1], 10), episodeId: parseInt(m[2], 10) };
}

export function parseKmangaEpisodeId(url) {
  const parsed = parseKmangaEpisodeUrl(url);
  return parsed ? parsed.episodeId : null;
}

export function cleanKmangaUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const parsed = parseKmangaEpisodeUrl(url);
  if (!parsed) return null;
  return `https://kmanga.kodansha.com/title/${parsed.titleId}/episode/${parsed.episodeId}`;
}

// -- Auth hash --

async function sha512Hex(text) {
  const buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultExpiry() {
  return Math.floor(Date.now() / 1000) + 315360000;
}

export async function buildKmangaHash(params, birthday = '2000-01', expiry = null) {
  const exp = expiry ?? defaultExpiry();
  const keys = Object.keys(params).sort();
  const paramStrings = await Promise.all(
    keys.map(async (k) => {
      const kHash = await sha256Hex(k);
      const vHash = await sha512Hex(String(params[k]));
      return `${kHash}_${vHash}`;
    })
  );
  const joined = paramStrings.join(',');
  const hash1 = await sha256Hex(joined);
  const bHash = await sha256Hex(birthday);
  const eHash = await sha512Hex(String(exp));
  const finalString = `${hash1}${bHash}_${eHash}`;
  return await sha512Hex(finalString);
}

export function buildKmangaHeaders(hash) {
  return {
    'X-Kmanga-Platform': '3',
    'x-kmanga-client-id': '0',
    'x-kmanga-is-crawler': 'false',
    'X-Kmanga-Hash': hash
  };
}

// -- Viewer API --

export async function fetchViewerPages(episodeId, context = {}) {
  const fetchText = context?.fetchText;
  const fetchBytes = context?.fetchBytes;
  if (typeof fetchText !== 'function' && typeof fetchBytes !== 'function') {
    throw new Error('K MANGA requires network proxy for API requests.');
  }

  const params = { episode_id: String(episodeId) };
  const hash = await buildKmangaHash(params);
  const headers = buildKmangaHeaders(hash);

  await throttleKmangaRequest();

  const apiUrl = `${SE_API_BASE}/web/episode/viewer?episode_id=${episodeId}`;

  let text;
  try {
    if (typeof fetchText === 'function') {
      text = await fetchText(apiUrl, headers);
    } else {
      const bytes = await fetchBytes(apiUrl, headers);
      text = new TextDecoder().decode(bytes);
    }
  } catch (err) {
    throw new Error(`K MANGA viewer request failed: ${err?.message || err}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Failed to parse K MANGA viewer response');
  }

  if (data?.response_code !== undefined && data.response_code !== 0 && (data?.error_code || data?.error_message)) {
    const msg = data.error_message || `Error code: ${data.error_code || data.response_code}`;
    throw new Error(`K MANGA: ${msg}`);
  }

  const result = data?.data?.viewer_pages || data?.viewer_pages || data;
  const scrambleSeed = result?.scramble_seed || data?.scramble_seed || '';
  const rawList = Array.isArray(result?.page_list)
    ? result.page_list
    : (Array.isArray(data?.page_list) ? data.page_list : []);

  const pages = [];
  for (const page of rawList) {
    if (typeof page === 'string' && page) {
      pages.push(page);
    } else if (page?.src && typeof page.src === 'string') {
      pages.push(page.src);
    }
  }

  if (pages.length === 0) {
    throw new Error('K MANGA viewer returned no page data - the episode may require a rental or subscription.');
  }

  const nextEpisode = result?.next_episode?.episode_id || data?.next_episode?.episode_id || null;

  return { scrambleSeed, pages, nextEpisode };
}

// -- Episode detail API (lightweight, no auth required) --

export async function fetchEpisodeDetail(episodeId, context = {}) {
  const fetchText = context?.fetchText;
  const fetchBytes = context?.fetchBytes;
  if (typeof fetchText !== 'function' && typeof fetchBytes !== 'function') {
    throw new Error('K MANGA requires network proxy for API requests.');
  }

  const params = { episode_id: String(episodeId) };
  const hash = await buildKmangaHash(params);
  const headers = buildKmangaHeaders(hash);

  await throttleKmangaRequest();

  const apiUrl = `${SE_API_BASE}/web/episode?episode_id=${episodeId}`;

  let text;
  try {
    if (typeof fetchText === 'function') {
      text = await fetchText(apiUrl, headers);
    } else {
      const bytes = await fetchBytes(apiUrl, headers);
      text = new TextDecoder().decode(bytes);
    }
  } catch (err) {
    throw new Error(`K MANGA episode detail request failed: ${err?.message || err}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Failed to parse K MANGA episode detail response');
  }

  const ep = data?.episode;
  if (!ep) return null;

  return {
    episodeId: ep.episode_id,
    episodeName: ep.episode_name || '',
    point: ep.point ?? -1,
    isPageVisible: ep.is_page_visible ?? 0,
    ticketRentalEnabled: ep.ticket_rental_enabled ?? 0,
    thumbnailUrl: ep.thumbnail_image_url || '',
    pageCount: ep.page_count ?? 0
  };
}

// -- Tile descramble order --

function xorshift32(n) {
  n = (n ^ (n << 13)) >>> 0;
  n = (n ^ (n >>> 17)) >>> 0;
  n = (n ^ (n << 5)) >>> 0;
  return n;
}

export function buildTileOrder(seed, titleId, episodeId, cols = 4, rows = 4) {
  const alphabet = (titleId % 2 === 0) ? CHARSET_EVEN : CHARSET_ODD;
  let parsedInt = 0n;
  for (const c of seed) {
    const idx = alphabet.indexOf(c);
    if (idx !== -1) {
      parsedInt = parsedInt * 10n + BigInt(idx);
    } else {
      break;
    }
  }

  let seed32 = (Number(BigInt.asUintN(32, parsedInt)) ^ ((titleId + episodeId) >>> 0)) >>> 0;
  const total = cols * rows;
  const pairs = [];
  for (let i = 0; i < total; i++) {
    seed32 = xorshift32(seed32);
    pairs.push({ rand: seed32, sourceIndex: i });
  }
  pairs.sort((a, b) => (a.rand < b.rand ? -1 : a.rand > b.rand ? 1 : 0));
  return pairs.map((p) => p.sourceIndex);
}

// -- HTML parsing helpers --

export function parseNuxtData(html) {
  if (!html || typeof html !== 'string') return null;
  const marker = '__NUXT_DATA__';
  const start = html.indexOf(marker);
  if (start === -1) return null;

  const scriptStart = html.indexOf('>', start);
  if (scriptStart === -1) return null;
  const scriptEnd = html.indexOf('</script>', scriptStart);
  if (scriptEnd === -1) return null;

  const content = html.slice(scriptStart + 1, scriptEnd).trim();
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function unflattenNuxtData(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  const memo = new Map();
  function resolve(idx) {
    if (typeof idx !== 'number' || idx < 0 || idx >= data.length) return idx;
    if (memo.has(idx)) return memo.get(idx);
    const val = data[idx];
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) {
      if (val[0] === 'ShallowReactive' || val[0] === 'Reactive' || val[0] === 'Set') {
        const res = resolve(val[1]);
        memo.set(idx, res);
        return res;
      }
      const arr = [];
      memo.set(idx, arr);
      for (const item of val) arr.push(resolve(item));
      return arr;
    }
    const obj = {};
    memo.set(idx, obj);
    for (const [k, v] of Object.entries(val)) obj[k] = resolve(v);
    return obj;
  }
  const root = resolve(0);
  const all = data.map((_, i) => resolve(i));
  return { root, all };
}

function padIndex(index, total) {
  const width = Math.max(2, Math.ceil(Math.log10(Math.max(2, total + 1))));
  return String(index + 1).padStart(width, '0');
}

export function buildKmangaImages(pages, scrambleSeed, titleId, episodeId) {
  const cols = 4;
  const rows = 4;
  const order = buildTileOrder(scrambleSeed, titleId, episodeId, cols, rows);
  const total = pages.length;

  return pages.map((pageUrl, i) => {
    const ext = (pageUrl.match(/\.(\w+)(?:\?|$)/)?.[1] || 'jpg').toLowerCase();
    const filename = `${padIndex(i, total)}.${ext}`;

    return {
      url: pageUrl,
      filename,
      descramble: {
        algorithm: 'tile-grid',
        cols,
        rows,
        order,
        align: 8
      }
    };
  });
}
