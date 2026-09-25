import assert from 'node:assert/strict';
import { applySort, getSavedItemKind, groupSavedItems } from '../src/js/services/sorting.js';

describe('Sorting service', () => {
  it('keeps root files before nested files in archive default name order', () => {
    const list = [
      { name: '..', is_dir: true, is_parent: true },
      { name: 'aaa/01.jpg', path: 'C:\\books\\sample.zip|aaa/01.jpg', ext: 'jpg', is_dir: false },
      { name: 'z.jpg', path: 'C:\\books\\sample.zip|z.jpg', ext: 'jpg', is_dir: false },
      { name: 'a.jpg', path: 'C:\\books\\sample.zip|a.jpg', ext: 'jpg', is_dir: false },
      { name: 'bbb/01.jpg', path: 'C:\\books\\sample.zip|bbb/01.jpg', ext: 'jpg', is_dir: false },
      { name: 'sub\\02.jpg', path: 'C:\\books\\sample.zip|sub\\02.jpg', ext: 'jpg', is_dir: false },
    ];

    const sorted = applySort(list, 'name', false).map(item => item.name);

    assert.deepEqual(sorted, [
      '..',
      'a.jpg',
      'z.jpg',
      'aaa/01.jpg',
      'bbb/01.jpg',
      'sub\\02.jpg',
    ]);
  });

  describe('DirectoryPrefs persistence and deletion cleanup', () => {
    let Core;
    let DirectoryPrefs;

    before(async () => {
      if (typeof window === 'undefined') {
        globalThis.window = {
          __TAURI__: {
            core: {
              invoke: async () => ({}),
              convertFileSrc: (p) => p,
            },
          },
          dispatchEvent: () => {},
        };
      }
      const coreModule = await import('../src/js/core.js');
      Core = coreModule.Core;
      const prefsModule = await import('../src/js/directoryPrefs.js');
      DirectoryPrefs = prefsModule.DirectoryPrefs;
    });

    beforeEach(() => {
      Core.getState().config = {
        frontend_data: {
          default_sort: { col: 'name', desc: false },
          directory_sort: {},
        },
      };
    });

    it('returns default sort when no custom preference is stored', () => {
      const prefs = DirectoryPrefs.getSortPrefs('C:\\photos');
      assert.deepEqual(prefs, { col: 'name', desc: false });
    });

    it('stores custom sort preferences and supports slash normalization', () => {
      DirectoryPrefs.setSortPrefs('C:\\photos\\vacation', 'date', true);
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('C:\\photos\\vacation'),
        { col: 'date', desc: true }
      );
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('c:/photos/vacation'),
        { col: 'date', desc: true }
      );
    });

    it('removes sort preferences and reverts to default sort', () => {
      DirectoryPrefs.setSortPrefs('C:\\photos\\vacation', 'size', true);
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('C:\\photos\\vacation'),
        { col: 'size', desc: true }
      );

      const removed = DirectoryPrefs.removeSortPrefs('C:\\photos\\vacation');
      assert.equal(removed, true);
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('C:\\photos\\vacation'),
        { col: 'name', desc: false }
      );
    });

    it('reconciles directory_sort and purges missing folders and archives', async () => {
      DirectoryPrefs.setSortPrefs('C:\\existing\\folder', 'date', true);
      DirectoryPrefs.setSortPrefs('C:\\deleted\\folder', 'size', true);
      DirectoryPrefs.setSortPrefs('C:\\deleted\\archive.zip', 'ext', false);

      const existingPath = 'C:\\existing\\folder';
      const deletedFolder = 'C:\\deleted\\folder';
      const deletedArchive = 'C:\\deleted\\archive.zip';

      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'library_move_in_progress') return false;
        if (cmd === 'get_path_kind') {
          if (args.path === existingPath) return 'directory';
          return 'missing';
        }
        return {};
      };

      const changed = await DirectoryPrefs.reconcileDirectorySort();
      assert.equal(changed, true);

      const dirSort = Core.getState().config.frontend_data.directory_sort;
      assert.ok(dirSort[existingPath]);
      assert.equal(dirSort[deletedFolder], undefined);
      assert.equal(dirSort[deletedArchive], undefined);

      assert.deepEqual(
        DirectoryPrefs.getSortPrefs(deletedFolder),
        { col: 'name', desc: false }
      );
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs(deletedArchive),
        { col: 'name', desc: false }
      );
    });
  });

  describe('Saved items grouping (favorites and bookmarks)', () => {
    it('classifies folders, archives, and images correctly', () => {
      assert.equal(getSavedItemKind({ path: 'C:\\Users\\manga', is_dir: true }), 'folder');
      assert.equal(getSavedItemKind({ path: 'D:', is_drive: true }), 'folder');
      assert.equal(getSavedItemKind({ path: 'E:\\' }), 'folder');
      assert.equal(getSavedItemKind({ path: 'C:/docs/' }), 'folder');

      assert.equal(getSavedItemKind({ path: 'C:\\manga\\v1.cbz', name: 'v1.cbz' }), 'archive');
      assert.equal(getSavedItemKind({ path: 'C:\\manga\\v2.zip', name: 'v2.zip', ext: 'zip' }), 'archive');
      assert.equal(getSavedItemKind({ path: 'C:\\manga\\v3.7z', name: 'v3.7z' }), 'archive');
      assert.equal(getSavedItemKind({ path: 'C:\\manga\\v4.rar', name: 'v4.rar' }), 'archive');

      // Archive entry images inside an archive are images, not archives
      assert.equal(getSavedItemKind({ path: 'C:\\manga\\v1.cbz|001.jpg', name: '001.jpg', ext: 'jpg' }), 'image');
      assert.equal(getSavedItemKind({ path: 'C:\\photos\\pic.png', name: 'pic.png', ext: 'png' }), 'image');
      assert.equal(getSavedItemKind({ path: 'C:\\videos\\anim.mp4', name: 'anim.mp4', ext: 'mp4' }), 'image');
      assert.equal(getSavedItemKind(null), 'image');
    });

    it('groups items as folders, then archives, then images while preserving insertion order', () => {
      const items = [
        { path: 'C:\\photos\\p1.jpg', name: 'p1.jpg', ext: 'jpg' },
        { path: 'C:\\manga\\v1.cbz', name: 'v1.cbz', ext: 'cbz' },
        { path: 'C:\\folder1', name: 'folder1', is_dir: true },
        { path: 'C:\\photos\\p2.jpg', name: 'p2.jpg', ext: 'jpg' },
        { path: 'C:\\folder2', name: 'folder2', is_dir: true },
        { path: 'C:\\manga\\v2.zip', name: 'v2.zip', ext: 'zip' },
      ];

      const grouped = groupSavedItems(items);
      assert.deepEqual(grouped.map(i => i.name), [
        'folder1',
        'folder2',
        'v1.cbz',
        'v2.zip',
        'p1.jpg',
        'p2.jpg',
      ]);
    });

    it('appends new items to their respective group in proper hierarchy', () => {
      let list = [];

      // Add image 1
      list.push({ path: 'C:\\photos\\p1.jpg', name: 'p1.jpg', ext: 'jpg' });
      list = groupSavedItems(list);
      assert.deepEqual(list.map(i => i.name), ['p1.jpg']);

      // Add archive 1 -> should place archive above image 1
      list.push({ path: 'C:\\manga\\v1.cbz', name: 'v1.cbz', ext: 'cbz' });
      list = groupSavedItems(list);
      assert.deepEqual(list.map(i => i.name), ['v1.cbz', 'p1.jpg']);

      // Add folder 1 -> should place folder above archive and image
      list.push({ path: 'C:\\folder1', name: 'folder1', is_dir: true });
      list = groupSavedItems(list);
      assert.deepEqual(list.map(i => i.name), ['folder1', 'v1.cbz', 'p1.jpg']);

      // Add folder 2 -> should append to folders group
      list.push({ path: 'C:\\folder2', name: 'folder2', is_dir: true });
      list = groupSavedItems(list);
      assert.deepEqual(list.map(i => i.name), ['folder1', 'folder2', 'v1.cbz', 'p1.jpg']);

      // Add archive 2 -> should append to archives group
      list.push({ path: 'C:\\manga\\v2.zip', name: 'v2.zip', ext: 'zip' });
      list = groupSavedItems(list);
      assert.deepEqual(list.map(i => i.name), ['folder1', 'folder2', 'v1.cbz', 'v2.zip', 'p1.jpg']);

      // Add image 2 -> should append to images group
      list.push({ path: 'C:\\photos\\p2.png', name: 'p2.png', ext: 'png' });
      list = groupSavedItems(list);
      assert.deepEqual(list.map(i => i.name), ['folder1', 'folder2', 'v1.cbz', 'v2.zip', 'p1.jpg', 'p2.png']);

      // Add video -> should append to images group and treat as image
      list.push({ path: 'C:\\videos\\clip.mp4', name: 'clip.mp4', ext: 'mp4' });
      list = groupSavedItems(list);
      assert.deepEqual(list.map(i => i.name), ['folder1', 'folder2', 'v1.cbz', 'v2.zip', 'p1.jpg', 'p2.png', 'clip.mp4']);
    });

    it('treats videos as images alongside other image files in the image group', () => {
      const items = [
        { path: 'C:\\videos\\intro.mp4', name: 'intro.mp4', ext: 'mp4' },
        { path: 'C:\\docs\\manga', name: 'manga', is_dir: true },
        { path: 'C:\\archives\\pack.zip', name: 'pack.zip', ext: 'zip' },
        { path: 'C:\\photos\\cover.jpg', name: 'cover.jpg', ext: 'jpg' },
        { path: 'C:\\videos\\trailer.webm', name: 'trailer.webm', ext: 'webm' },
      ];

      const grouped = groupSavedItems(items);
      assert.deepEqual(grouped.map(i => i.name), [
        'manga',
        'pack.zip',
        'intro.mp4',
        'cover.jpg',
        'trailer.webm',
      ]);
    });
  });
});
