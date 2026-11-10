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

  it('inverts entry group order and reverses names within groups in descending name sort', () => {
    const list = [
      { name: '..', is_dir: true, is_parent: true },
      { name: 'aaa/01.jpg', path: 'C:\\books\\sample.zip|aaa/01.jpg', ext: 'jpg', is_dir: false },
      { name: 'z.jpg', path: 'C:\\books\\sample.zip|z.jpg', ext: 'jpg', is_dir: false },
      { name: 'a.jpg', path: 'C:\\books\\sample.zip|a.jpg', ext: 'jpg', is_dir: false },
      { name: 'bbb/01.jpg', path: 'C:\\books\\sample.zip|bbb/01.jpg', ext: 'jpg', is_dir: false },
      { name: 'sub\\02.jpg', path: 'C:\\books\\sample.zip|sub\\02.jpg', ext: 'jpg', is_dir: false },
    ];

    const sorted = applySort(list, 'name', true).map(item => item.name);

    assert.deepEqual(sorted, [
      '..',
      'sub\\02.jpg',
      'bbb/01.jpg',
      'aaa/01.jpg',
      'z.jpg',
      'a.jpg',
    ]);
  });

  it('falls back to compareNames when size values are equal or zero for composite archive paths', () => {
    const equalSizes = [
      { name: 'sub/01.jpg', path: 'sample.zip|sub/01.jpg', size: 1024, is_dir: false },
      { name: 'z.jpg', path: 'sample.zip|z.jpg', size: 1024, is_dir: false },
      { name: 'a.jpg', path: 'sample.zip|a.jpg', size: 1024, is_dir: false },
      { name: 'sub/02.jpg', path: 'sample.zip|sub/02.jpg', size: 1024, is_dir: false },
    ];

    const ascEqual = applySort(equalSizes, 'size', false).map(item => item.name);
    assert.deepEqual(ascEqual, ['a.jpg', 'z.jpg', 'sub/01.jpg', 'sub/02.jpg']);

    const descEqual = applySort(equalSizes, 'size', true).map(item => item.name);
    assert.deepEqual(descEqual, ['sub/02.jpg', 'sub/01.jpg', 'z.jpg', 'a.jpg']);

    const zeroSizes = [
      { name: 'sub/01.jpg', path: 'sample.zip|sub/01.jpg', size: 0, is_dir: false },
      { name: 'z.jpg', path: 'sample.zip|z.jpg', size: 0, is_dir: false },
    ];
    assert.deepEqual(
      applySort(zeroSizes, 'size', false).map(item => item.name),
      ['z.jpg', 'sub/01.jpg']
    );

    const distinctSizes = [
      { name: 'sub/01.jpg', path: 'sample.zip|sub/01.jpg', size: 500, is_dir: false },
      { name: '02.jpg', path: 'sample.zip|02.jpg', size: 1000, is_dir: false },
    ];
    assert.deepEqual(
      applySort(distinctSizes, 'size', false).map(item => item.name),
      ['sub/01.jpg', '02.jpg']
    );
    assert.deepEqual(
      applySort(distinctSizes, 'size', true).map(item => item.name),
      ['02.jpg', 'sub/01.jpg']
    );
  });

  it('falls back to compareNames when dimension areas are equal or zero for composite archive paths', () => {
    const equalDims = [
      { name: 'sub/01.jpg', path: 'sample.zip|sub/01.jpg', width: 800, height: 600, is_dir: false },
      { name: 'z.jpg', path: 'sample.zip|z.jpg', width: 800, height: 600, is_dir: false },
      { name: 'a.jpg', path: 'sample.zip|a.jpg', width: 800, height: 600, is_dir: false },
    ];

    const ascDims = applySort(equalDims, 'dims', false).map(item => item.name);
    assert.deepEqual(ascDims, ['a.jpg', 'z.jpg', 'sub/01.jpg']);

    const descDims = applySort(equalDims, 'dims', true).map(item => item.name);
    assert.deepEqual(descDims, ['sub/01.jpg', 'z.jpg', 'a.jpg']);

    const zeroDims = [
      { name: 'sub/01.jpg', path: 'sample.zip|sub/01.jpg', width: 0, height: 0, is_dir: false },
      { name: 'z.jpg', path: 'sample.zip|z.jpg', width: 0, height: 0, is_dir: false },
    ];
    assert.deepEqual(
      applySort(zeroDims, 'dims', false).map(item => item.name),
      ['z.jpg', 'sub/01.jpg']
    );

    const mixedZeroAndKnown = [
      { name: 'sub/01.jpg', path: 'sample.zip|sub/01.jpg', width: 0, height: 0, is_dir: false },
      { name: '02.jpg', path: 'sample.zip|02.jpg', width: 100, height: 100, is_dir: false },
    ];
    assert.deepEqual(
      applySort(mixedZeroAndKnown, 'dims', false).map(item => item.name),
      ['02.jpg', 'sub/01.jpg']
    );
    assert.deepEqual(
      applySort(mixedZeroAndKnown, 'dims', true).map(item => item.name),
      ['02.jpg', 'sub/01.jpg']
    );
  });

  it('sorts composite archive paths by extension with natural compare fallback', () => {
    const distinctExt = [
      { name: 'sub/01.png', path: 'sample.zip|sub/01.png', ext: 'png', is_dir: false },
      { name: '02.jpg', path: 'sample.zip|02.jpg', ext: 'jpg', is_dir: false },
    ];
    assert.deepEqual(
      applySort(distinctExt, 'ext', false).map(item => item.name),
      ['02.jpg', 'sub/01.png']
    );
    assert.deepEqual(
      applySort(distinctExt, 'ext', true).map(item => item.name),
      ['sub/01.png', '02.jpg']
    );

    const sameExt = [
      { name: 'sub/01.jpg', path: 'sample.zip|sub/01.jpg', ext: 'jpg', is_dir: false },
      { name: '02.jpg', path: 'sample.zip|02.jpg', ext: 'jpg', is_dir: false },
    ];
    assert.deepEqual(
      applySort(sameExt, 'ext', false).map(item => item.name),
      ['02.jpg', 'sub/01.jpg']
    );
    assert.deepEqual(
      applySort(sameExt, 'ext', true).map(item => item.name),
      ['sub/01.jpg', '02.jpg']
    );
  });

  it('sorts composite archive paths by raw date with natural compare fallback', () => {
    const distinctDates = [
      { name: 'sub/01.jpg', path: 'sample.zip|sub/01.jpg', rawDate: 1000, is_dir: false },
      { name: '02.jpg', path: 'sample.zip|02.jpg', rawDate: 2000, is_dir: false },
    ];
    assert.deepEqual(
      applySort(distinctDates, 'date', false).map(item => item.name),
      ['sub/01.jpg', '02.jpg']
    );
    assert.deepEqual(
      applySort(distinctDates, 'date', true).map(item => item.name),
      ['02.jpg', 'sub/01.jpg']
    );

    const sameDates = [
      { name: 'sub/01.jpg', path: 'sample.zip|sub/01.jpg', rawDate: 1500, is_dir: false },
      { name: '02.jpg', path: 'sample.zip|02.jpg', rawDate: 1500, is_dir: false },
    ];
    assert.deepEqual(
      applySort(sameDates, 'date', false).map(item => item.name),
      ['02.jpg', 'sub/01.jpg']
    );
    assert.deepEqual(
      applySort(sameDates, 'date', true).map(item => item.name),
      ['sub/01.jpg', '02.jpg']
    );
  });

  it('uses natural compare without archive hierarchy for standalone file paths without pipes', () => {
    const list = [
      { name: 'sub/01.jpg', path: 'C:\\photos\\sub/01.jpg', is_dir: false },
      { name: 'z.jpg', path: 'C:\\photos\\z.jpg', is_dir: false },
    ];
    assert.deepEqual(
      applySort(list, 'name', false).map(item => item.name),
      ['sub/01.jpg', 'z.jpg']
    );
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
      Core.setState({
        config: {
          frontend_data: {
            default_sort: { col: 'name', desc: false },
            directory_sort: {},
          },
        },
      });
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

    it('normalizes mixed slashes, trailing slashes, and drive letter casing across get and set', () => {
      DirectoryPrefs.setSortPrefs('C:\\Photos\\Vacation\\', 'date', true);

      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('c:/photos/vacation'),
        { col: 'date', desc: true }
      );
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('C:/Photos/Vacation/'),
        { col: 'date', desc: true }
      );
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('c:\\photos/vacation/'),
        { col: 'date', desc: true }
      );
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('C:\\PHOTOS\\VACATION'),
        { col: 'date', desc: true }
      );

      DirectoryPrefs.setSortPrefs('c:/photos/vacation', 'size', true);

      const dirSort = Core.getState().config.frontend_data.directory_sort;
      assert.equal(Object.keys(dirSort).length, 1);
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('C:\\Photos\\Vacation\\'),
        { col: 'size', desc: true }
      );

      DirectoryPrefs.setSortPrefs('C:/photos/vacation/', 'name', false);
      assert.equal(Object.keys(dirSort).length, 0);
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('c:\\photos\\vacation'),
        { col: 'name', desc: false }
      );
    });

    it('reconciles directory_sort and purges missing composite archive paths', async () => {
      DirectoryPrefs.setSortPrefs('C:\\existing\\sample.zip|nested/folder', 'date', true);
      DirectoryPrefs.setSortPrefs('C:\\deleted\\archive.zip|nested/folder', 'size', true);

      const existingBase = 'C:\\existing\\sample.zip';
      const deletedBase = 'C:\\deleted\\archive.zip';

      window.__TAURI__.core.invoke = async (cmd, args) => {
        if (cmd === 'library_move_in_progress') return false;
        if (cmd === 'get_path_kind') {
          if (args.path === existingBase) return 'file';
          if (args.path === deletedBase) return 'missing';
          return 'missing';
        }
        return {};
      };

      const changed = await DirectoryPrefs.reconcileDirectorySort();
      assert.equal(changed, true);

      const dirSort = Core.getState().config.frontend_data.directory_sort;
      assert.ok(dirSort['C:\\existing\\sample.zip|nested/folder']);
      assert.equal(dirSort['C:\\deleted\\archive.zip|nested/folder'], undefined);
      assert.deepEqual(
        DirectoryPrefs.getSortPrefs('C:\\deleted\\archive.zip|nested/folder'),
        { col: 'name', desc: false }
      );
    });
  });

  describe('Saved items grouping (favorites)', () => {
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

    it('classifies composite archive paths as images rather than archives', () => {
      assert.equal(getSavedItemKind({ path: 'C:\\dir\\sample.zip|nested/img.png' }), 'image');
      assert.equal(getSavedItemKind({ path: 'C:\\dir\\sample.zip|nested/archive.zip', ext: 'zip' }), 'image');
      assert.equal(getSavedItemKind({ path: 'C:\\dir\\sample.cbz|01.jpg', name: '01.jpg' }), 'image');
      assert.equal(getSavedItemKind({ path: 'C:\\dir\\sample.rar|inner.cbr', ext: 'cbr' }), 'image');
      assert.equal(getSavedItemKind({ path: 'C:\\dir\\sample.7z|sub/deep/page.avif' }), 'image');
    });

    it('classifies standalone archive files across all supported extensions as archives', () => {
      const exts = ['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7', 'cbt', 'tar'];
      for (const ext of exts) {
        assert.equal(getSavedItemKind({ path: `C:\\dir\\archive.${ext}` }), 'archive');
        assert.equal(getSavedItemKind({ path: `C:\\dir\\archive_upper.${ext.toUpperCase()}` }), 'archive');
        assert.equal(getSavedItemKind({ path: 'C:\\dir\\noext', ext }), 'archive');
      }
    });

    it('classifies paths with trailing slashes and drive letters as folders', () => {
      assert.equal(getSavedItemKind({ path: 'C:\\folder\\' }), 'folder');
      assert.equal(getSavedItemKind({ path: 'C:/folder/' }), 'folder');
      assert.equal(getSavedItemKind({ path: 'c:' }), 'folder');
      assert.equal(getSavedItemKind({ path: 'C:' }), 'folder');
      assert.equal(getSavedItemKind({ path: 'd:\\' }), 'folder');
      assert.equal(getSavedItemKind({ path: 'D:\\' }), 'folder');
      assert.equal(getSavedItemKind({ path: 'e:/' }), 'folder');
      assert.equal(getSavedItemKind({ path: 'E:/' }), 'folder');
      assert.equal(getSavedItemKind({ path: 'F:\\nested\\sub\\dir\\' }), 'folder');
      assert.equal(getSavedItemKind({ is_dir: true }), 'folder');
      assert.equal(getSavedItemKind({ is_drive: true }), 'folder');
      assert.equal(getSavedItemKind({ is_parent: true }), 'folder');
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
