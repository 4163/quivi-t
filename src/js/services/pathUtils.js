export function normalizePathKey(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function pathsEqual(a, b) {
  if (!a || !b) return false;
  return normalizePathKey(a) === normalizePathKey(b);
}

export function isPathWithin(path, root) {
  if (!path || !root) return false;
  const cleanPath = normalizePathKey(path);
  const cleanRoot = normalizePathKey(root);
  return cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`);
}

export function getParentPath(path) {
  return (path || '').replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
}

export function getBasename(path) {
  return (path || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export function getExtension(path) {
  return (path || '').split(/[?#]/)[0].split('.').pop()?.toLowerCase() || '';
}
