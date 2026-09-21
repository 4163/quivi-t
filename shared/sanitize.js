/**
 * sanitize.js: shared path segment sanitization for extractors.
 */

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
