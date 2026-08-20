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
      const cmp = naturalCompare(valA, valB);
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
