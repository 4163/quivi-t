import assert from 'node:assert/strict';
import { applySort } from '../src/js/services/sorting.js';

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
});
