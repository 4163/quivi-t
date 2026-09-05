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
