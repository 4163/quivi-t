import { splitArchivePath } from './archivePath.js';

export function naturalCompare(a, b) {
  const ax = [], bx = [];
  a.replace(/(\d+)|(\D+)/g, function (_, $1, $2) { ax.push([$1 || Infinity, $2 || ""]); });
  b.replace(/(\d+)|(\D+)/g, function (_, $1, $2) { bx.push([$1 || Infinity, $2 || ""]); });
  const len = Math.min(ax.length, bx.length);
  for (let i = 0; i < len; i++) {
    const nn = (ax[i][0] - bx[i][0]) || ax[i][1].localeCompare(bx[i][1]);
    if (nn) return nn;
  }
  return ax.length - bx.length;
}

function isNestedArchiveEntry(item) {
  const name = item?.name;
  if (typeof name !== 'string') return false;
  const trimmed = name.replace(/^[\\/]+|[\\/]+$/g, '');
  return trimmed.includes('/') || trimmed.includes('\\');
}

function hasArchiveEntryPath(item) {
  return splitArchivePath(item?.path).isArchiveEntry;
}

function compareNames(a, b) {
  const archiveOrder = hasArchiveEntryPath(a) || hasArchiveEntryPath(b);
  if (archiveOrder) {
    const nestedCmp = Number(isNestedArchiveEntry(a)) - Number(isNestedArchiveEntry(b));
    if (nestedCmp !== 0) return nestedCmp;
  }
  return naturalCompare(a.name.toLowerCase(), b.name.toLowerCase());
}

export function applySort(list, col, desc, groupArchives = false) {
  if (!list || list.length <= 1) return list;

  const parents = [];
  const dirs = [];
  const archives = [];
  const files = [];
  for (const item of list) {
    if (item.is_parent) parents.push(item);
    else if (item.is_dir || item.is_drive) dirs.push(item);
    else if (groupArchives && getSavedItemKind(item) === 'archive') archives.push(item);
    else files.push(item);
  }

  const sortLogic = (a, b) => {
    if (col === 'name') {
      const cmp = compareNames(a, b);
      return desc ? -cmp : cmp;
    }
    if (col === 'ext') {
      const valA = (a.ext || '').toLowerCase();
      const valB = (b.ext || '').toLowerCase();
      if (valA === valB) {
        const cmp = naturalCompare(a.name.toLowerCase(), b.name.toLowerCase());
        return desc ? -cmp : cmp;
      }
      return valA < valB ? (desc ? 1 : -1) : (desc ? -1 : 1);
    }
    if (col === 'date') {
      const dA = a.rawDate || 0;
      const dB = b.rawDate || 0;
      if (dA !== dB) return desc ? dB - dA : dA - dB;
      const cmp = naturalCompare(a.name.toLowerCase(), b.name.toLowerCase());
      return desc ? -cmp : cmp;
    }
    if (col === 'size') {
      const sA = a.size || 0;
      const sB = b.size || 0;
      if (sA !== sB) return desc ? sB - sA : sA - sB;
      const cmp = compareNames(a, b);
      return desc ? -cmp : cmp;
    }
    if (col === 'dims') {
      const wA = a.width || 0;
      const hA = a.height || 0;
      const wB = b.width || 0;
      const hB = b.height || 0;
      const areaA = (wA > 0 && hA > 0) ? (wA * hA) : 0;
      const areaB = (wB > 0 && hB > 0) ? (wB * hB) : 0;
      if (areaA === 0 && areaB === 0) {
        const cmp = compareNames(a, b);
        return desc ? -cmp : cmp;
      }
      if (areaA === 0) return 1;
      if (areaB === 0) return -1;
      if (areaA !== areaB) return desc ? areaB - areaA : areaA - areaB;
      if (wA !== wB) return desc ? wB - wA : wA - wB;
      if (hA !== hB) return desc ? hB - hA : hA - hB;
      const cmp = compareNames(a, b);
      return desc ? -cmp : cmp;
    }
    return 0;
  };

  dirs.sort(sortLogic);
  archives.sort(sortLogic);
  files.sort(sortLogic);

  return parents.concat(dirs, archives, files);
}

export const SAVED_ARCHIVE_EXTS = new Set([
  'zip', 'cbz', 'rar', 'cbr', '7z', 'cb7', 'cbt', 'tar'
]);

export function getSavedItemKind(item) {
  if (!item || typeof item !== 'object') return 'image';
  if (item.is_dir || item.is_drive || item.is_parent) return 'folder';
  const path = typeof item.path === 'string' ? item.path : '';
  if (path.endsWith('/') || path.endsWith('\\') || /^[a-zA-Z]:[\\/]?$/.test(path)) {
    return 'folder';
  }
  if (!splitArchivePath(path).isArchiveEntry) {
    const rawExt = typeof item.ext === 'string' && item.ext
      ? item.ext
      : (typeof item.name === 'string' && item.name.includes('.') ? item.name.split('.').pop() : path.split('.').pop() || '');
    if (SAVED_ARCHIVE_EXTS.has(rawExt.toLowerCase())) return 'archive';
  }
  return 'image';
}

export function groupSavedItems(items) {
  if (!Array.isArray(items) || items.length <= 1) {
    return Array.isArray(items) ? items.slice() : [];
  }
  const folders = [];
  const archives = [];
  const images = [];

  for (const item of items) {
    const kind = getSavedItemKind(item);
    if (kind === 'folder') {
      folders.push(item);
    } else if (kind === 'archive') {
      archives.push(item);
    } else {
      images.push(item);
    }
  }

  return folders.concat(archives, images);
}
