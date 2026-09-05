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
  dispatchEvent: () => {}
};

const { Core } = await import('../core.js');
const { DEFAULT_FILE_LIST_VIEW_MODE, mergeConfig } = await import('../keybinds.js');
const { FsUtils } = await import('../fsUtils.js');

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

