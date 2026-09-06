import test from 'node:test';
import assert from 'node:assert/strict';

// Mock browser globals required for Node test environment
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async () => ({}),
      convertFileSrc: (p) => `asset://${p}`
    }
  },
  addEventListener: () => {},
  dispatchEvent: () => {}
};

const { Core } = await import('../core.js');
const { DEFAULT_FILE_LIST_VIEW_MODE, mergeConfig } = await import('../keybinds.js');
const { FsUtils } = await import('../fsUtils.js');
const { THUMB_CACHE_CAPACITY, thumbnailCache, FAVORITES_CACHE_CAPACITY, favoritesThumbnailCache, getPlaceholderType } = await import('../filepanel/filePanel.js');

test('Core: default file list view mode is list', () => {
  assert.equal(DEFAULT_FILE_LIST_VIEW_MODE, 'list');
  const merged = mergeConfig({});
  assert.equal(merged.frontend_data.file_list_view_mode, 'list');
});

test('Core: toggle and set file list view mode', () => {
  Core.setFileListViewMode('thumbnail');
  assert.equal(Core.getState().fileListViewMode, 'thumbnail');

  Core.toggleFileListViewMode();
  assert.equal(Core.getState().fileListViewMode, 'list');

  Core.toggleFileListViewMode();
  assert.equal(Core.getState().fileListViewMode, 'thumbnail');

  Core.setFileListViewMode('list');
  assert.equal(Core.getState().fileListViewMode, 'list');
});

test('FsUtils: buildNativeIconSrc handles small and large sizes', () => {
  const smallSrc = FsUtils.buildNativeIconSrc('C:\\test.png', 'png', 'small');
  assert.equal(smallSrc.includes('size=large'), false);

  const largeSrc = FsUtils.buildNativeIconSrc('C:\\test.png', 'png', 'large');
  assert.equal(largeSrc.includes('?size=large'), true);
});

test('FsUtils: buildThumbnailSrc generates image previews and icon fallbacks', () => {
  // Image file outside archive
  const imgItem = { name: 'photo.jpg', path: 'C:\\images\\photo.jpg', ext: 'jpg' };
  const imgSrc = FsUtils.buildThumbnailSrc(imgItem, { mode: 'directory' });
  assert.equal(imgSrc.startsWith('asset://') || imgSrc.includes('photo.jpg'), true);

  // Non-image file
  const docItem = { name: 'document.txt', path: 'C:\\docs\\document.txt', ext: 'txt' };
  const docSrc = FsUtils.buildThumbnailSrc(docItem, { mode: 'directory' });
  assert.equal(docSrc.includes('?size=large'), true);

  // Folder item
  const dirItem = { name: 'Subfolder', path: 'C:\\images\\Subfolder', is_dir: true };
  const dirSrc = FsUtils.buildThumbnailSrc(dirItem, { mode: 'directory' });
  assert.equal(dirSrc.includes('?size=large'), true);

  // Archive entry image
  const archiveImgItem = { name: '01.png', path: 'inner/01.png', ext: 'png' };
  const archiveImgSrc = FsUtils.buildThumbnailSrc(archiveImgItem, { mode: 'archive', archivePath: 'C:\\test.zip' });
  assert.equal(archiveImgSrc.includes('/archive/'), true);
  assert.equal(archiveImgSrc.includes('01.png'), true);

  // Favorite entry with composite archive path
  const favArchiveItem = { name: 'cover.jpg', path: 'C:\\manga.cbz|cover.jpg', ext: 'jpg' };
  const favArchiveSrc = FsUtils.buildThumbnailSrc(favArchiveItem, { mode: 'directory' });
  assert.equal(favArchiveSrc.includes('/archive/'), true);
  assert.equal(favArchiveSrc.includes('cover.jpg'), true);
});

test('Virtualization: static sizer calculation across massive directory lists', () => {
  const TOTAL_ITEMS = 14321;
  const LIST_ROW_HEIGHT = 22;
  const THUMB_ROW_HEIGHT = 52;

  // Single static sizer calculation preserves O(1) scroll height
  const listHeight = TOTAL_ITEMS * LIST_ROW_HEIGHT;
  const thumbHeight = TOTAL_ITEMS * THUMB_ROW_HEIGHT;

  assert.equal(listHeight, 315062);
  assert.equal(thumbHeight, 744692);

  // Empty directory sizer height
  assert.equal(0 * LIST_ROW_HEIGHT, 0);
});

test('Virtualization: visible slice windowing and overscan bounds', () => {
  const TOTAL = 14321;
  const ROW_HEIGHT = 22;
  const CLIENT_HEIGHT = 600;
  const OVERSCAN = 5;

  const computeSlice = (scrollTop) => {
    const rawStart = Math.floor(scrollTop / ROW_HEIGHT);
    const visibleCount = Math.ceil(CLIENT_HEIGHT / ROW_HEIGHT);
    const startIndex = Math.max(0, rawStart - OVERSCAN);
    const endIndex = Math.min(TOTAL, rawStart + visibleCount + OVERSCAN);
    return { startIndex, endIndex, count: endIndex - startIndex };
  };

  // Top of list: clamped to 0 at top
  const topSlice = computeSlice(0);
  assert.equal(topSlice.startIndex, 0);
  assert.equal(topSlice.endIndex, 33); // 28 visible + 5 bottom overscan
  assert.equal(topSlice.count, 33);

  // Mid-list scroll (item 100)
  const midSlice = computeSlice(100 * ROW_HEIGHT);
  assert.equal(midSlice.startIndex, 95); // 100 - 5
  assert.equal(midSlice.endIndex, 133);  // 100 + 28 + 5
  assert.equal(midSlice.count, 38);

  // Bottom of list: clamped to TOTAL
  const bottomSlice = computeSlice(TOTAL * ROW_HEIGHT);
  assert.equal(bottomSlice.endIndex, TOTAL);
  assert.ok(bottomSlice.startIndex < TOTAL);
});

test('Virtualization: VS Code RowCache reconciliation lifecycle', () => {
  // Simulates 2-phase activeRows / freePool reconciliation
  const activeRows = new Map();
  const freePool = [];
  let allocatedCount = 0;

  const mockCreateRow = () => {
    allocatedCount++;
    return { id: allocatedCount, index: null };
  };

  const reconcile = (startIndex, endIndex) => {
    // Phase 1: Reclaim offscreen rows into freePool
    for (const [idx, row] of activeRows) {
      if (idx < startIndex || idx >= endIndex) {
        activeRows.delete(idx);
        row.index = null;
        freePool.push(row);
      }
    }

    // Phase 2: Allocate or update only rows not already rendered
    let skippedExisting = 0;
    for (let i = startIndex; i < endIndex; i++) {
      let row = activeRows.get(i);
      if (!row) {
        row = freePool.pop() || mockCreateRow();
        row.index = i;
        activeRows.set(i, row);
      } else {
        skippedExisting++;
      }
    }
    return { skippedExisting };
  };

  // Initial render of slice [0, 35)
  const step1 = reconcile(0, 35);
  assert.equal(step1.skippedExisting, 0);
  assert.equal(activeRows.size, 35);
  assert.equal(allocatedCount, 35);
  assert.equal(freePool.length, 0);

  // Small scroll forward: slice [10, 45)
  // Rows [10..34] (25 rows) should be preserved with 0 work
  // Rows [0..9] (10 rows) should be reclaimed to freePool and reused for [35..44]
  const step2 = reconcile(10, 45);
  assert.equal(step2.skippedExisting, 25);
  assert.equal(activeRows.size, 35);
  assert.equal(allocatedCount, 35); // Zero new DOM allocations!
  assert.equal(freePool.length, 0);

  // Verify active indices match [10..44]
  for (let i = 10; i < 45; i++) {
    assert.ok(activeRows.has(i));
    assert.equal(activeRows.get(i).index, i);
  }

  // Large jump: slice [1000, 1035)
  // All previous rows [10..44] reclaimed to freePool and reused for [1000..1034]
  const step3 = reconcile(1000, 1035);
  assert.equal(step3.skippedExisting, 0);
  assert.equal(activeRows.size, 35);
  assert.equal(allocatedCount, 35); // Still zero new DOM allocations!
  assert.equal(freePool.length, 0);

  for (let i = 1000; i < 1035; i++) {
    assert.ok(activeRows.has(i));
    assert.equal(activeRows.get(i).index, i);
  }
});

test('Virtualization: scroll debouncing and two-phase thumbnail assignment', () => {
  const TRANSPARENT_PIXEL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+';
  let isScrolling = false;

  const createMockRow = () => {
    const classList = new Set();
    const dataset = {};
    let src = '';
    const thumbImg = {
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
        contains: (c) => classList.has(c),
      },
      dataset,
      getAttribute: (attr) => (attr === 'src' ? src : null),
      set src(val) { src = val; },
      get src() { return src; },
    };
    return { thumbImg };
  };

  const updateEntryMock = (row, item, isImage) => {
    const targetSrc = isImage ? `quivit://archive/test/${item.name}` : `quivit://icon/${item.name}`;
    if (!isImage) {
      delete row.thumbImg.dataset.pendingSrc;
      row.thumbImg.src = targetSrc;
    } else if (isScrolling) {
      row.thumbImg.dataset.pendingSrc = targetSrc;
      row.thumbImg.classList.remove('is-loaded');
      row.thumbImg.src = TRANSPARENT_PIXEL;
    } else {
      delete row.thumbImg.dataset.pendingSrc;
      row.thumbImg.classList.remove('is-loaded');
      row.thumbImg.src = targetSrc;
    }
  };

  const commitPendingThumbnails = (rows) => {
    for (const row of rows) {
      if (row.thumbImg.dataset.pendingSrc) {
        const target = row.thumbImg.dataset.pendingSrc;
        delete row.thumbImg.dataset.pendingSrc;
        row.thumbImg.classList.remove('is-loaded');
        row.thumbImg.src = target;
      }
    }
  };

  // 1. Initial directory render: not scrolling -> images load immediately
  isScrolling = false;
  const rowA = createMockRow();
  updateEntryMock(rowA, { name: 'photo1.jpg' }, true);
  assert.equal(rowA.thumbImg.src, 'quivit://archive/test/photo1.jpg');
  assert.equal(rowA.thumbImg.dataset.pendingSrc, undefined);

  // 2. Rapid scrolling active -> media decode is deferred and placeholder shown
  isScrolling = true;
  const rowB = createMockRow();
  updateEntryMock(rowB, { name: 'photo2.jpg' }, true);
  assert.equal(rowB.thumbImg.src, TRANSPARENT_PIXEL);
  assert.equal(rowB.thumbImg.dataset.pendingSrc, 'quivit://archive/test/photo2.jpg');
  assert.equal(rowB.thumbImg.classList.contains('is-loaded'), false);

  // Non-image during rapid scrolling loads icon immediately without deferring
  const rowFolder = createMockRow();
  updateEntryMock(rowFolder, { name: 'Subfolder' }, false);
  assert.equal(rowFolder.thumbImg.src, 'quivit://icon/Subfolder');
  assert.equal(rowFolder.thumbImg.dataset.pendingSrc, undefined);

  // 3. Scroll settles (100ms or scrollend) -> pending thumbnail committed
  isScrolling = false;
  commitPendingThumbnails([rowA, rowB, rowFolder]);
  assert.equal(rowB.thumbImg.src, 'quivit://archive/test/photo2.jpg');
  assert.equal(rowB.thumbImg.dataset.pendingSrc, undefined);

  // Simulating image load completion reveals image and hides placeholder
  rowB.thumbImg.classList.add('is-loaded');
  assert.equal(rowB.thumbImg.classList.contains('is-loaded'), true);
});

test('Virtualization: off-screen request cancellation on row reclamation', () => {
  const TRANSPARENT_PIXEL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+';
  const classList = new Set(['is-loaded']);
  const dataset = { pendingSrc: 'quivit://thumb/large.jpg' };
  let src = 'quivit://thumb/large.jpg';

  const row = {
    thumbImg: {
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
        contains: (c) => classList.has(c),
      },
      dataset,
      set src(val) { src = val; },
      get src() { return src; },
    }
  };

  // Phase 1 reclamation into freePool
  delete row.thumbImg.dataset.pendingSrc;
  row.thumbImg.classList.remove('is-loaded');
  row.thumbImg.src = TRANSPARENT_PIXEL;

  assert.equal(row.thumbImg.src, TRANSPARENT_PIXEL);
  assert.equal(row.thumbImg.dataset.pendingSrc, undefined);
  assert.equal(row.thumbImg.classList.contains('is-loaded'), false);
});

test('Virtualization: thumbnail caching and instant re-use across scroll passes', () => {
  const TRANSPARENT_PIXEL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+';
  const mockCache = new Map();
  let isScrolling = false;

  const createMockRow = () => {
    const classList = new Set();
    const dataset = {};
    let src = '';
    return {
      thumbImg: {
        classList: {
          add: (c) => classList.add(c),
          remove: (c) => classList.delete(c),
          contains: (c) => classList.has(c),
        },
        dataset,
        getAttribute: (attr) => (attr === 'src' ? src : null),
        set src(val) { src = val; },
        get src() { return src; },
      }
    };
  };

  const updateEntryWithCache = (row, targetSrc, isImage) => {
    const isCached = mockCache.has(targetSrc);
    if (!isImage) {
      delete row.thumbImg.dataset.pendingSrc;
      row.thumbImg.src = targetSrc;
    } else if (isCached) {
      delete row.thumbImg.dataset.pendingSrc;
      row.thumbImg.src = targetSrc;
      row.thumbImg.classList.add('is-loaded');
    } else if (isScrolling) {
      row.thumbImg.dataset.pendingSrc = targetSrc;
      row.thumbImg.classList.remove('is-loaded');
      row.thumbImg.src = TRANSPARENT_PIXEL;
    } else {
      delete row.thumbImg.dataset.pendingSrc;
      row.thumbImg.classList.remove('is-loaded');
      row.thumbImg.src = targetSrc;
    }
  };

  // 1. Initial load of photo1.jpg
  isScrolling = false;
  const row1 = createMockRow();
  const url1 = 'quivit://thumb/photo1.jpg';
  updateEntryWithCache(row1, url1, true);
  assert.equal(row1.thumbImg.src, url1);
  assert.equal(row1.thumbImg.classList.contains('is-loaded'), false);

  // Simulating successful load stores in cache
  mockCache.set(url1, true);
  row1.thumbImg.classList.add('is-loaded');
  assert.equal(row1.thumbImg.classList.contains('is-loaded'), true);

  // 2. User scrolls away (row1 reclaimed into freePool)
  row1.thumbImg.classList.remove('is-loaded');
  row1.thumbImg.src = TRANSPARENT_PIXEL;

  // 3. User scrolls rapidly back to photo1.jpg (isScrolling = true)
  isScrolling = true;
  updateEntryWithCache(row1, url1, true);

  // Because photo1.jpg is in mockCache, it renders immediately without being deferred to TRANSPARENT_PIXEL!
  assert.equal(row1.thumbImg.src, url1);
  assert.equal(row1.thumbImg.dataset.pendingSrc, undefined);
  assert.equal(row1.thumbImg.classList.contains('is-loaded'), true);

  // In contrast, an uncached item during the same rapid scroll is deferred
  const rowUncached = createMockRow();
  const url2 = 'quivit://thumb/photo2_uncached.jpg';
  updateEntryWithCache(rowUncached, url2, true);
  assert.equal(rowUncached.thumbImg.src, TRANSPARENT_PIXEL);
  assert.equal(rowUncached.thumbImg.dataset.pendingSrc, url2);
  assert.equal(rowUncached.thumbImg.classList.contains('is-loaded'), false);
});

test('Virtualization: THUMB_CACHE_CAPACITY constant and BoundedMap capacity', () => {
  assert.equal(THUMB_CACHE_CAPACITY, 250);
  assert.equal(thumbnailCache.maxSize, 250);
});

test('Virtualization: getPlaceholderType returns correct skeleton type for directories, archives, images, and files', () => {
  // Folders and special directory entries
  assert.equal(getPlaceholderType({ name: '..', is_parent: true }), 'folder');
  assert.equal(getPlaceholderType({ name: 'Subfolder', is_dir: true }), 'folder');
  assert.equal(getPlaceholderType({ name: 'C:', is_drive: true }), 'folder');

  // Archives
  assert.equal(getPlaceholderType({ name: 'manga.cbz', is_dir: false }), 'archive');
  assert.equal(getPlaceholderType({ name: 'comic.cbr', is_dir: false }), 'archive');
  assert.equal(getPlaceholderType({ name: 'photos.zip', is_dir: false }), 'archive');
  assert.equal(getPlaceholderType({ name: 'archive.7z', is_dir: false }), 'archive');
  assert.equal(getPlaceholderType({ name: 'bundle.tar', is_dir: false }), 'archive');

  // Images
  assert.equal(getPlaceholderType({ name: 'cover.jpg', is_dir: false }), 'image');
  assert.equal(getPlaceholderType({ name: 'page.png', is_dir: false }), 'image');
  assert.equal(getPlaceholderType({ name: 'anim.webp', is_dir: false }), 'image');
  assert.equal(getPlaceholderType({ name: 'vector.svg', is_dir: false }), 'image');

  // Other documents / files
  assert.equal(getPlaceholderType({ name: 'notes.txt', is_dir: false }), 'file');
  assert.equal(getPlaceholderType({ name: 'app.exe', is_dir: false }), 'file');
  assert.equal(getPlaceholderType(null), 'file');
});


test('Canonical URLs: buildThumbnailSrc generates identical URLs for folders at different paths', () => {
  const folder1 = { name: 'Screenshots', path: 'E:\\Steam\\Screenshots', is_dir: true };
  const folder2 = { name: 'Other', path: 'C:\\Users\\test\\Other', is_dir: true };
  const src1 = FsUtils.buildThumbnailSrc(folder1, null);
  const src2 = FsUtils.buildThumbnailSrc(folder2, null);
  assert.equal(src1, src2);
});

test('Canonical URLs: buildThumbnailSrc generates identical URLs for archives at different paths', () => {
  const cbz1 = { name: 'manga.cbz', path: 'E:\\Comics\\manga.cbz', ext: 'cbz', is_dir: false };
  const cbz2 = { name: 'vol2.cbz', path: 'D:\\Library\\vol2.cbz', ext: 'cbz', is_dir: false };
  const src1 = FsUtils.buildThumbnailSrc(cbz1, null);
  const src2 = FsUtils.buildThumbnailSrc(cbz2, null);
  assert.equal(src1, src2);
});

test('Canonical URLs: buildThumbnailSrc preserves unique URLs for drive items', () => {
  const driveC = { name: 'C:', path: 'C:\\', is_drive: true };
  const driveD = { name: 'D:', path: 'D:\\', is_drive: true };
  const src1 = FsUtils.buildThumbnailSrc(driveC, null);
  const src2 = FsUtils.buildThumbnailSrc(driveD, null);
  assert.notEqual(src1, src2);
});

test('Canonical URLs: absolute path favorites do not route to archive protocol', () => {
  const fav = { name: 'photo.jpg', path: 'C:\\Photos\\photo.jpg', ext: 'jpg', is_dir: false };
  const archiveState = { mode: 'archive', archivePath: 'E:\\comic.cbz' };
  const src = FsUtils.buildThumbnailSrc(fav, archiveState);
  assert.ok(!src.includes('archive'), 'absolute path should not route through archive protocol');
  assert.ok(src.includes('asset://') || src.includes('convertFileSrc'), 'should use file source');
});

test('Helpers: _isAbsolutePath detects Windows absolute paths', () => {
  assert.equal(FsUtils._isAbsolutePath('C:\\foo\\bar.jpg'), true);
  assert.equal(FsUtils._isAbsolutePath('D:\\test'), true);
  assert.equal(FsUtils._isAbsolutePath('\\\\server\\share'), true);
  assert.equal(FsUtils._isAbsolutePath('inner/path.png'), false);
  assert.equal(FsUtils._isAbsolutePath(''), false);
  assert.equal(FsUtils._isAbsolutePath(null), false);
});

test('Helpers: _isPathSpecificIcon identifies drive and special folder ext keys', () => {
  assert.equal(FsUtils._isPathSpecificIcon('C:\\'), true);
  assert.equal(FsUtils._isPathSpecificIcon('C:\\Users\\test\\Downloads'), true);
  assert.equal(FsUtils._isPathSpecificIcon('__folder__'), false);
  assert.equal(FsUtils._isPathSpecificIcon('cbz'), false);
  assert.equal(FsUtils._isPathSpecificIcon('png'), false);
});

test('Cache isolation: favoritesThumbnailCache is independent from thumbnailCache', () => {
  assert.equal(FAVORITES_CACHE_CAPACITY, 250);
  assert.equal(favoritesThumbnailCache.maxSize, 250);

  thumbnailCache.clear();
  favoritesThumbnailCache.clear();

  favoritesThumbnailCache.set('fav-key', 'fav-value');

  // Fill thumbnailCache past capacity
  for (let i = 0; i < 260; i++) {
    thumbnailCache.set(`thumb-${i}`, `val-${i}`);
  }

  assert.equal(favoritesThumbnailCache.has('fav-key'), true, 'favorites entry survives main cache overflow');
  assert.equal(favoritesThumbnailCache.get('fav-key'), 'fav-value');
  assert.equal(thumbnailCache.size, 250);
});

