/**
 * filePanel.js - file list rendering, sorting, and column resizing.
 */

const MIN_COL_WIDTHS = {
  name: 64,
  ext: 28,
  date: 92,
};

let filePanel = null;
let fileListUl = null;
let resizeHandle = null;
let Core = null;
let Viewer = null;

let isResizingPanel = false;
let resizingCol = null;
let startX = 0;
let startWidth = 0;
let columnResizeMoved = false;
let sortCol = 'name';
let sortDesc = false;
let columnsInitialized = false;

function setColumnWidth(col, width) {
  document.documentElement.style.setProperty(`--col-${col}-w`, `${Math.round(width)}px`);
}

function getColumnWidth(col) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--col-${col}-w`).trim();
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : MIN_COL_WIDTHS[col];
}

function normalizeColumnWidths(preferredCol = 'name', preferredWidth = null) {
  const panelWidth = Math.max(filePanel.getBoundingClientRect().width - 8, 120);
  const cols = {
    name: getColumnWidth('name'),
    ext: getColumnWidth('ext'),
    date: getColumnWidth('date'),
  };

  if (preferredWidth !== null) cols[preferredCol] = preferredWidth;

  cols.name = Math.max(MIN_COL_WIDTHS.name, cols.name);
  cols.ext = Math.max(MIN_COL_WIDTHS.ext, cols.ext);
  cols.date = Math.max(MIN_COL_WIDTHS.date, cols.date);

  const fixedOthers = Object.entries(cols)
    .filter(([col]) => col !== preferredCol)
    .reduce((sum, [, width]) => sum + width, 0);

  cols[preferredCol] = Math.max(
    MIN_COL_WIDTHS[preferredCol],
    Math.min(cols[preferredCol], panelWidth - fixedOthers),
  );

  let total = cols.name + cols.ext + cols.date;
  if (total > panelWidth) {
    const order = preferredCol === 'date'
      ? ['name', 'ext']
      : preferredCol === 'ext'
        ? ['name', 'date']
        : ['ext', 'date'];

    for (const col of order) {
      const overflow = total - panelWidth;
      if (overflow <= 0) break;
      const shrink = Math.min(overflow, cols[col] - MIN_COL_WIDTHS[col]);
      cols[col] -= shrink;
      total -= shrink;
    }
  }

  setColumnWidth('name', cols.name);
  setColumnWidth('ext', cols.ext);
  setColumnWidth('date', cols.date);
}

function initializeColumns() {
  if (columnsInitialized) return;
  columnsInitialized = true;

  const panelWidth = Math.max(filePanel.getBoundingClientRect().width - 8, 120);
  const date = 92;
  const ext = 46;
  setColumnWidth('date', date);
  setColumnWidth('ext', ext);
  setColumnWidth('name', Math.max(MIN_COL_WIDTHS.name, panelWidth - date - ext));
}

function updateSortIcons() {
  document.querySelectorAll('.header-cell .sort-icon').forEach(icon => icon.textContent = '');
  const activeCell = document.querySelector(`.header-cell[data-sort="${sortCol}"]`);
  if (activeCell) {
    activeCell.querySelector('.sort-icon').textContent = sortDesc ? '▼' : '▲';
  }
}

function renderEntry(item, index, selectedIndex) {
  const li = document.createElement('li');
  if (index === selectedIndex) li.classList.add('selected');

  const itemName = document.createElement('span');
  itemName.className = 'item-name';

  if (item.is_dir) {
    itemName.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  }

  const itemLabel = document.createElement('span');
  itemLabel.className = 'item-label';
  itemLabel.textContent = item.name;
  itemName.appendChild(itemLabel);

  const itemExt = document.createElement('span');
  itemExt.className = 'item-ext';
  itemExt.textContent = item.ext || '';

  const itemDate = document.createElement('span');
  itemDate.className = 'item-date';
  itemDate.textContent = item.date || '';

  li.appendChild(itemName);
  li.appendChild(itemExt);
  li.appendChild(itemDate);

  li.addEventListener('click', () => Core.selectIndex(index));
  li.addEventListener('dblclick', () => Core.jumpToIndex(index));

  return li;
}

export function renderFilePanel(state) {
  filePanel.classList.toggle('hidden', !state.fileListVisible);

  fileListUl.innerHTML = '';
  state.list.forEach((item, index) => {
    const li = renderEntry(item, index, state.index);
    fileListUl.appendChild(li);

    if (index === state.index) {
      li.scrollIntoView({ block: 'nearest' });
    }
  });
}

export function initFilePanel(deps) {
  ({ filePanel, fileListUl, resizeHandle, Core, Viewer } = deps);

  initializeColumns();
  updateSortIcons();

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizingPanel = true;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.querySelectorAll('.header-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      if (resizingCol) return;
      if (columnResizeMoved) {
        columnResizeMoved = false;
        return;
      }

      const col = cell.dataset.sort;
      if (sortCol === col) {
        sortDesc = !sortDesc;
      } else {
        sortCol = col;
        sortDesc = false;
      }

      Core.sortList(sortCol, sortDesc);
      updateSortIcons();
    });
  });

  document.querySelectorAll('.col-resizer').forEach(resizer => {
    resizer.addEventListener('mousedown', (e) => {
      resizingCol = resizer.parentElement;
      startX = e.clientX;
      startWidth = resizingCol.offsetWidth;
      columnResizeMoved = false;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
      e.stopPropagation();
    });
  });

  window.addEventListener('mousemove', (e) => {
    if (isResizingPanel) {
      const oldWidth = filePanel.getBoundingClientRect().width;
      const newWidth = Math.min(480, Math.max(120, e.clientX));
      filePanel.style.width = `${newWidth}px`;
      normalizeColumnWidths('name', getColumnWidth('name') + (newWidth - oldWidth));
      Viewer.applyFitMode();
    }

    if (resizingCol) {
      const delta = e.clientX - startX;
      if (Math.abs(delta) > 2) columnResizeMoved = true;

      if (resizingCol.classList.contains('col-name')) {
        normalizeColumnWidths('name', startWidth + delta);
      } else if (resizingCol.classList.contains('col-ext')) {
        normalizeColumnWidths('ext', startWidth + delta);
      } else if (resizingCol.classList.contains('col-date')) {
        normalizeColumnWidths('date', startWidth + delta);
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (isResizingPanel) {
      isResizingPanel = false;
      resizeHandle.classList.remove('dragging');
      document.body.style.cursor = '';
    }

    if (resizingCol) {
      resizingCol.querySelector('.col-resizer').classList.remove('dragging');
      resizingCol = null;
      document.body.style.cursor = '';
    }
  });
}
