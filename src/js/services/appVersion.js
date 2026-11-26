/**
 * App version formatting and major-version character codenames.
 */

export const FALLBACK_APP_VERSION = '1.0.0';

export const GITHUB_REPO_URL = 'https://github.com/4163/quivi-t';
export const GITHUB_RELEASES_URL = 'https://github.com/4163/quivi-t/releases';
export const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/4163/quivi-t/releases?per_page=30';

/* Major versions only:
 * Yui Horie main-character or memorable roles,
 * oldest to newest (https://myanimelist.net/people/28/Yui_Horie).
 */
export const MAJOR_VERSION_CODENAMES = Object.freeze({
  1: 'Freya',
});

export function normalizeVersion(version) {
  const raw = String(version ?? '').trim();
  if (!raw) return FALLBACK_APP_VERSION;
  return raw.replace(/^v/i, '');
}

export function parseSemver(version) {
  const raw = String(version ?? '').trim().replace(/^v/i, '');
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

export function compareSemver(a, b) {
  const pa = typeof a === 'string' ? parseSemver(a) : a;
  const pb = typeof b === 'string' ? parseSemver(b) : b;
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

export function parseMajorVersion(version) {
  const match = normalizeVersion(version).match(/^(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function getVersionCodename(version) {
  const major = parseMajorVersion(version);
  return major !== null ? (MAJOR_VERSION_CODENAMES[major] || '') : '';
}

export function formatVersionLabel(version) {
  return `v${normalizeVersion(version)}`;
}

export function evaluateReleasesUpdate(currentVersion, releases) {
  const current = parseSemver(currentVersion);
  if (!current || !Array.isArray(releases) || releases.length === 0) return null;

  const seen = new Set();
  const newer = [];

  for (const release of releases) {
    if (!release || release.draft || release.prerelease) continue;
    const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
    const parsed = parseSemver(tag);
    if (!parsed) continue;
    const normalized = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (compareSemver(parsed, current) > 0) {
      newer.push({ version: normalized, parsed });
    }
  }

  if (newer.length === 0) return null;

  newer.sort((a, b) => compareSemver(b.parsed, a.parsed));
  const latestVersion = newer[0].version;
  const behindCount = newer.length;

  return {
    latestVersion,
    behindCount,
    label: `v${latestVersion} available:`,
  };
}
