const ANIM_CANDIDATE_REGEX = /\.(gif|webp|png|apng|avif)($|[?#])/i;
const SVG_EXT_REGEX = /\.svg($|[?#])/i;
const VIDEO_EXT_REGEX = /\.mp4($|[?#])/i;

export function isAnimCandidateExt(name) {
  return ANIM_CANDIDATE_REGEX.test(name || '');
}

export function isSvgEntry(entry) {
  if (!entry) return false;
  if (typeof entry === 'string') {
    return SVG_EXT_REGEX.test(entry);
  }
  if (entry.is_dir || entry.is_parent) return false;
  const name = entry.name || entry.path || '';
  return SVG_EXT_REGEX.test(name);
}

export function isVideoEntry(entry) {
  if (!entry) return false;
  if (typeof entry === 'string') {
    return VIDEO_EXT_REGEX.test(entry);
  }
  if (entry.is_dir || entry.is_parent) return false;
  const name = entry.name || entry.path || '';
  return VIDEO_EXT_REGEX.test(name);
}

export function isSvgSource(src, item = null) {
  const context = item || (src && typeof src === 'object' && (src.list || src.filename || src.entry) ? src : null);
  if (context) {
    const entry = context.entry || (context.list && typeof context.index === 'number' ? context.list[context.index] : context);
    if (isSvgEntry(entry)) return true;
    if (context.filename && SVG_EXT_REGEX.test(context.filename)) return true;
    if (typeof context === 'string' && SVG_EXT_REGEX.test(context)) return true;
  }

  const raw = typeof src === 'string' ? src : (src?.src || '');
  if (!raw || typeof raw !== 'string') return false;
  try {
    const url = new URL(raw, 'http://localhost');
    return url.pathname.toLowerCase().endsWith('.svg');
  } catch {
    return raw.split('?')[0].split('#')[0].toLowerCase().endsWith('.svg');
  }
}

export function isVideoSource(src, item = null) {
  if (src?.tagName === 'VIDEO' || src?.node?.tagName === 'VIDEO') return true;

  const context = item || (src && typeof src === 'object' && (src.list || src.filename || src.entry) ? src : null);
  if (context) {
    const entry = context.entry || (context.list && typeof context.index === 'number' ? context.list[context.index] : context);
    if (isVideoEntry(entry)) return true;
    if (context.filename && isVideoEntry(context.filename)) return true;
    if (typeof context === 'string' && isVideoEntry(context)) return true;
  }

  const raw = typeof src === 'string' ? src : (src?.src || '');
  if (!raw || typeof raw !== 'string') return false;
  try {
    const url = new URL(raw, 'http://localhost');
    return url.pathname.toLowerCase().endsWith('.mp4');
  } catch {
    return VIDEO_EXT_REGEX.test(raw);
  }
}
