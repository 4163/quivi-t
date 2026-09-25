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
  return typeof item?.path === 'string' && item.path.includes('|');
}

function compareNames(a, b) {
  const archiveOrder = hasArchiveEntryPath(a) || hasArchiveEntryPath(b);
  if (archiveOrder) {
    const nestedCmp = Number(isNestedArchiveEntry(a)) - Number(isNestedArchiveEntry(b));
    if (nestedCmp !== 0) return nestedCmp;
  }
  return naturalCompare(a.name.toLowerCase(), b.name.toLowerCase());
}

export function applySort(list, col, desc) {
  if (!list || list.length <= 1) return list;

  const parents = [];
  const dirs = [];
  const files = [];
  for (const item of list) {
    if (item.is_parent) parents.push(item);
    else if (item.is_dir || item.is_drive) dirs.push(item);
    else files.push(item);
  }

  const sortLogic = (a, b) => {
    let valA, valB;
    if (col === 'name') {
      valA = a.name.toLowerCase();
      valB = b.name.toLowerCase();
    } else if (col === 'ext') {
      valA = a.ext.toLowerCase();
      valB = b.ext.toLowerCase();
      if (valA === valB) {
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
      }
    } else if (col === 'date') {
      const dA = a.rawDate || 0;
      const dB = b.rawDate || 0;
      if (dA !== dB) return desc ? dB - dA : dA - dB;
      valA = a.name.toLowerCase();
      valB = b.name.toLowerCase();
    }

    if (col === 'name' || (col === 'ext' && a.ext.toLowerCase() === b.ext.toLowerCase()) || (col === 'date' && a.rawDate === b.rawDate)) {
      const cmp = col === 'name' ? compareNames(a, b) : naturalCompare(valA, valB);
      return desc ? -cmp : cmp;
    }

    if (valA < valB) return desc ? 1 : -1;
    if (valA > valB) return desc ? -1 : 1;
    return 0;
  };

  dirs.sort(sortLogic);
  files.sort(sortLogic);

  return parents.concat(dirs).concat(files);
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
  if (!path.includes('|')) {
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
