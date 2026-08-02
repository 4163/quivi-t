/**
 * filePanel.js - file list rendering, sorting, and column resizing.
 */
import { DirectoryPrefs } from './directoryPrefs.js';

const MIN_COL_WIDTHS = {
  name: 64,
  ext: 28,
  date: 92,
};

let filePanel = null;
let breadcrumbEl = null;
let fileListUl = null;
let resizeHandle = null;
let Core = null;
let Viewer = null;

let isResizingPanel = false;
let resizingCol = null;
let startX = 0;
let startWidth = 0;
let columnResizeMoved = false;

let lastRenderedList = null;
let lastClickTime = 0;
let lastClickIndex = -1;
let currentPath = '';

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
  const prefs = DirectoryPrefs.getSortPrefs(currentPath);
  const activeCell = document.querySelector(`.header-cell[data-sort="${prefs.col}"]`);
  if (activeCell) {
    activeCell.querySelector('.sort-icon').textContent = prefs.desc ? '▼' : '▲';
  }
}

function formatBreadcrumbPath(path) {
  return path ? path.replace(/[\\/]+/g, ' > ') : '';
}

function renderBreadcrumb(state) {
  if (!breadcrumbEl) return;
  const path = state.mode === 'archive' ? state.archivePath : state.directory;
  breadcrumbEl.textContent = formatBreadcrumbPath(path);
  breadcrumbEl.title = path || '';
}

function renderEntry(item, index, selectedIndex) {
  const li = document.createElement('li');
  if (index === selectedIndex) li.classList.add('selected');
  if (item.name !== '..') {
    li.title = item.name;
  }

  const itemName = document.createElement('span');
  itemName.className = 'item-name';

  if (item.is_drive) {
    itemName.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>';
  } else if (item.is_dir) {
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
  
  li.setAttribute('role', 'option');
  li.setAttribute('tabindex', '0');

  li.addEventListener('focus', () => {
    if (Core.getState().index !== index) {
      Core.selectIndex(index);
    }
  });

  li.addEventListener('click', (e) => {
    Core.selectIndex(index);
    const now = Date.now();
    if (lastClickIndex === index && (now - lastClickTime < 400)) {
      Core.jumpToIndex(index);
      lastClickTime = 0;
      lastClickIndex = -1;
    } else {
      lastClickTime = now;
      lastClickIndex = index;
    }
  });

  return li;
}

function updateSelection(selectedIndex) {
  const previous = fileListUl.querySelector('.selected');
  if (previous) previous.classList.remove('selected');
  
  if (selectedIndex >= 0 && selectedIndex < fileListUl.children.length) {
    const li = fileListUl.children[selectedIndex];
    li.classList.add('selected');
    li.scrollIntoView({ block: 'nearest' });
    
    const wasFocused = document.activeElement && fileListUl.contains(document.activeElement);
    if (wasFocused) {
      li.focus({ preventScroll: true });
    }
  }
}

export function renderFilePanel(state) {
  filePanel.classList.toggle('hidden', !state.fileListVisible);
  renderBreadcrumb(state);

  const currentDir = state.mode === 'archive' ? state.archivePath : state.directory;
  if (currentDir !== currentPath) {
    currentPath = currentDir;
    updateSortIcons();
  }

  if (lastRenderedList === state.list) {
    updateSelection(state.index);
    return;
  }
  lastRenderedList = state.list;

  const wasFocused = document.activeElement && fileListUl.contains(document.activeElement);

  fileListUl.innerHTML = '';
  state.list.forEach((item, index) => {
    const li = renderEntry(item, index, state.index);
    fileListUl.appendChild(li);

    if (index === state.index) {
      li.scrollIntoView({ block: 'nearest' });
      if (wasFocused) {
        li.focus({ preventScroll: true });
      }
    }
  });
}

export function initFilePanel(deps) {
  ({ filePanel, breadcrumbEl, fileListUl, resizeHandle, Core, Viewer } = deps);

  initializeColumns();
  updateSortIcons();

  fileListUl.addEventListener('click', (e) => {
    if (e.target === fileListUl) {
      Core.selectIndex(-1);
    }
  });

  // Composite widget keyboard navigation
  fileListUl.addEventListener('keydown', (e) => {
    const state = Core.getState();
    const list = state.list;
    if (!list.length) return;

    const currentIndex = state.index;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        e.stopPropagation();
        const next = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, list.length - 1);
        Core.selectIndex(next);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        e.stopPropagation();
        const prev = currentIndex === -1 ? list.length - 1 : Math.max(currentIndex - 1, 0);
        Core.selectIndex(prev);
        break;
      }
      case 'Home': {
        e.preventDefault();
        Core.selectIndex(0);
        break;
      }
      case 'End': {
        e.preventDefault();
        Core.selectIndex(list.length - 1);
        break;
      }
      case 'Enter':
      case ' ': {
        if (currentIndex !== -1) {
          e.preventDefault();
          Core.jumpToIndex(currentIndex);
        }
        break;
      }
      case 'Escape': {
        e.preventDefault();
        Core.selectIndex(-1);
        // Blurring the active li
        if (document.activeElement && fileListUl.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        break;
      }
      default:
        break;
    }
  });

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
      const prefs = DirectoryPrefs.getSortPrefs(currentPath);
      let desc = false;
      if (prefs.col === col) {
        desc = !prefs.desc;
      }
      
      DirectoryPrefs.sortCurrentState(currentPath, col, desc);
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
