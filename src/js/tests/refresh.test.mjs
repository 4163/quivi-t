import test from 'node:test';
import assert from 'node:assert/strict';

// Set up browser and Tauri mocks before importing modules
const _windowListeners = new Map();
const _invocations = [];

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        _invocations.push({ cmd, args });
        if (cmd === 'get_drives') {
          return ['C:\\', 'D:\\'];
        }
        if (cmd === 'read_directory') {
          return {
            directory: args.path,
            parent_directory: 'C:\\',
            initial_index: 0,
            files: [
              { name: 'image2.png', path: `${args.path}\\image2.png`, is_dir: false },
              { name: 'image3.png', path: `${args.path}\\image3.png`, is_dir: false }
            ]
          };
        }
        if (cmd === 'drop_archive_cache') {
          return null;
        }
        if (cmd === 'list_archive') {
          if (args.archivePath?.includes('locked')) {
            return {
              archive_path: args.archivePath,
              files: [],
              encryption: 'password_required'
            };
          }
          return {
            archive_path: args.archivePath,
            files: [
              { name: 'page2.jpg', path: `${args.archivePath}|page2.jpg`, is_dir: false }
            ],
            encryption: 'none'
          };
        }
        return {};
      },
      convertFileSrc: (p) => `http://asset.localhost/${encodeURIComponent(p)}`
    }
  },
  addEventListener: (event, handler) => {
    if (!_windowListeners.has(event)) _windowListeners.set(event, []);
    _windowListeners.get(event).push(handler);
  },
  removeEventListener: (event, handler) => {
    if (!_windowListeners.has(event)) return;
    const list = _windowListeners.get(event).filter(h => h !== handler);
    _windowListeners.set(event, list);
  },
  dispatchEvent: (event) => {
    const list = _windowListeners.get(event.type || event) || [];
    for (const fn of list) fn(event);
  }
};

globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init?.detail;
  }
};

const { Core } = await import('../core.js');
const { FsUtils } = await import('../fsUtils.js');

test('Refresh: clearAnimationMemo clears specific and all cached animation headers', () => {
  Core.clearAnimationMemo();
  Core.clearAnimationMemo('file.gif', 'archive.zip');
  Core.clearAnimationMemo();
  assert.ok(true);
});

test('Refresh: refresh while viewing Drives calls get_drives rather than read_directory', async () => {
  _invocations.length = 0;
  Core.setState({
    mode: 'image',
    directory: 'Drives',
    filename: '',
    list: [{ name: 'C:\\', path: 'C:\\', is_dir: true, is_drive: true }],
    index: 0
  });

  await FsUtils.refresh();

  const getDrivesCall = _invocations.find(inv => inv.cmd === 'get_drives');
  const readDirCall = _invocations.find(inv => inv.cmd === 'read_directory');

  assert.ok(getDrivesCall, 'Expected get_drives to be called when refreshing Drives');
  assert.equal(readDirCall, undefined, 'read_directory should not be called with virtual Drives path');
});

test('Refresh: refresh in archive mode invokes drop_archive_cache on backend', async () => {
  _invocations.length = 0;
  Core.setState({
    mode: 'archive',
    archivePath: 'C:\\test.zip',
    filename: 'page1.jpg',
    list: [
      { name: '..', is_dir: true, is_parent: true },
      { name: 'page1.jpg', is_dir: false }
    ],
    index: 1
  });

  await FsUtils.refresh();

  const dropCall = _invocations.find(inv => inv.cmd === 'drop_archive_cache');
  assert.ok(dropCall, 'drop_archive_cache should be invoked on archive refresh');
  assert.equal(dropCall.args.archivePath, 'C:\\test.zip');
});

test('Refresh: user scenario - deleting active file and neighbors (3, 4, 5 in 1..7) lands on 6 without skipping', async () => {
  const oldList = [
    { name: '..', is_dir: true, is_parent: true },
    { name: '1.png', path: 'C:\\photos\\1.png', is_dir: false },
    { name: '2.png', path: 'C:\\photos\\2.png', is_dir: false },
    { name: '3.png', path: 'C:\\photos\\3.png', is_dir: false },
    { name: '4.png', path: 'C:\\photos\\4.png', is_dir: false },
    { name: '5.png', path: 'C:\\photos\\5.png', is_dir: false },
    { name: '6.png', path: 'C:\\photos\\6.png', is_dir: false },
    { name: '7.png', path: 'C:\\photos\\7.png', is_dir: false },
  ];

  Core.setState({
    mode: 'image',
    directory: 'C:\\photos',
    filename: '4.png',
    index: 4,
    list: oldList
  });

  // 3.png, 4.png, 5.png deleted on disk; only 1, 2, 6, 7 remain
  const directoryResult = {
    directory: 'C:\\photos',
    parent_directory: 'C:\\',
    files: [
      { name: '1.png', path: 'C:\\photos\\1.png', is_dir: false },
      { name: '2.png', path: 'C:\\photos\\2.png', is_dir: false },
      { name: '6.png', path: 'C:\\photos\\6.png', is_dir: false },
      { name: '7.png', path: 'C:\\photos\\7.png', is_dir: false },
    ]
  };

  await FsUtils.applyDirectoryResult(directoryResult, { preserveFilename: true, isRefresh: true });

  const state = Core.getState();
  // New list: [ '..', '1.png', '2.png', '6.png', '7.png' ]
  // Must land on '6.png' at index 3, NOT '7.png' at index 4
  assert.equal(state.filename, '6.png');
  assert.equal(state.index, 3);
});

test('Refresh: deleting active file at end of list lands on previous surviving neighbor', async () => {
  const oldList = [
    { name: '..', is_dir: true, is_parent: true },
    { name: '1.png', path: 'C:\\photos\\1.png', is_dir: false },
    { name: '2.png', path: 'C:\\photos\\2.png', is_dir: false },
    { name: '3.png', path: 'C:\\photos\\3.png', is_dir: false },
    { name: '4.png', path: 'C:\\photos\\4.png', is_dir: false },
    { name: '5.png', path: 'C:\\photos\\5.png', is_dir: false },
  ];

  Core.setState({
    mode: 'image',
    directory: 'C:\\photos',
    filename: '4.png',
    index: 4,
    list: oldList
  });

  // 4.png and 5.png deleted; only 1, 2, 3 remain
  const directoryResult = {
    directory: 'C:\\photos',
    parent_directory: 'C:\\',
    files: [
      { name: '1.png', path: 'C:\\photos\\1.png', is_dir: false },
      { name: '2.png', path: 'C:\\photos\\2.png', is_dir: false },
      { name: '3.png', path: 'C:\\photos\\3.png', is_dir: false },
    ]
  };

  await FsUtils.applyDirectoryResult(directoryResult, { preserveFilename: true, isRefresh: true });

  const state = Core.getState();
  assert.equal(state.filename, '3.png');
  assert.equal(state.index, 3);
});

test('Refresh: deleting all image files falls back to index 0 (..)', async () => {
  const oldList = [
    { name: '..', is_dir: true, is_parent: true },
    { name: '1.png', path: 'C:\\photos\\1.png', is_dir: false },
  ];

  Core.setState({
    mode: 'image',
    directory: 'C:\\photos',
    filename: '1.png',
    index: 1,
    list: oldList
  });

  // All files deleted
  const directoryResult = {
    directory: 'C:\\photos',
    parent_directory: 'C:\\',
    files: []
  };

  await FsUtils.applyDirectoryResult(directoryResult, { preserveFilename: true, isRefresh: true });

  const state = Core.getState();
  assert.equal(state.index, 0);
  assert.equal(state.filename, '..');
});

test('Refresh: password-protected item maintains selection across multiple refreshes', async () => {
  const oldList = [
    { name: '..', is_dir: true, is_parent: true },
    { name: '1.png', path: 'C:\\photos\\1.png', is_dir: false },
    { name: '2.png', path: 'C:\\photos\\2.png', is_dir: false },
    { name: '3.png', path: 'C:\\photos\\3.png', is_dir: false },
    { name: 'locked.zip', path: 'C:\\photos\\locked.zip', is_dir: false },
  ];

  Core.setState({
    mode: 'image',
    directory: 'C:\\photos',
    filename: 'Password required: locked.zip',
    archivePath: 'C:\\photos\\locked.zip',
    archiveEncryption: 'password_required',
    index: 4,
    list: oldList
  });

  const directoryResult = {
    directory: 'C:\\photos',
    parent_directory: 'C:\\',
    files: [
      { name: '1.png', path: 'C:\\photos\\1.png', is_dir: false },
      { name: '2.png', path: 'C:\\photos\\2.png', is_dir: false },
      { name: '3.png', path: 'C:\\photos\\3.png', is_dir: false },
      { name: 'locked.zip', path: 'C:\\photos\\locked.zip', is_dir: false },
    ]
  };

  // First refresh
  await FsUtils.applyDirectoryResult(directoryResult, { preserveFilename: true, isRefresh: true });

  let state = Core.getState();
  assert.equal(state.index, 4);
  assert.equal(state.filename, 'Password required: locked.zip');
  assert.equal(state.archiveEncryption, 'password_required');

  // Second refresh - verify it does not step down
  await FsUtils.applyDirectoryResult(directoryResult, { preserveFilename: true, isRefresh: true });

  state = Core.getState();
  assert.equal(state.index, 4);
  assert.equal(state.filename, 'Password required: locked.zip');
  assert.equal(state.archiveEncryption, 'password_required');
});

test('Refresh: FsUtils.refresh cleans password prefix when calling read_directory', async () => {
  Core.setState({
    mode: 'image',
    directory: 'C:\\photos',
    filename: 'Password required: locked.zip',
    archivePath: 'C:\\photos\\locked.zip',
    archiveEncryption: 'password_required',
    index: 1,
    list: [
      { name: '..', is_dir: true, is_parent: true },
      { name: 'locked.zip', path: 'C:\\photos\\locked.zip', is_dir: false },
    ]
  });

  _invocations.length = 0;
  await FsUtils.refresh();

  const readCall = _invocations.find(inv => inv.cmd === 'read_directory');
  assert.ok(readCall, 'read_directory should be invoked');
  assert.equal(readCall.args.targetName, 'locked.zip');
});

test('Refresh: deleting password-protected item lands on nearest surviving neighbor', async () => {
  const oldList = [
    { name: '..', is_dir: true, is_parent: true },
    { name: '1.png', path: 'C:\\photos\\1.png', is_dir: false },
    { name: 'locked.zip', path: 'C:\\photos\\locked.zip', is_dir: false },
    { name: '2.png', path: 'C:\\photos\\2.png', is_dir: false },
  ];

  Core.setState({
    mode: 'image',
    directory: 'C:\\photos',
    filename: 'Password required: locked.zip',
    archivePath: 'C:\\photos\\locked.zip',
    archiveEncryption: 'password_required',
    index: 2,
    list: oldList
  });

  // locked.zip was deleted on disk; only 1.png and 2.png remain
  const directoryResult = {
    directory: 'C:\\photos',
    parent_directory: 'C:\\',
    files: [
      { name: '1.png', path: 'C:\\photos\\1.png', is_dir: false },
      { name: '2.png', path: 'C:\\photos\\2.png', is_dir: false },
    ]
  };

  await FsUtils.applyDirectoryResult(directoryResult, { preserveFilename: true, isRefresh: true });

  const state = Core.getState();
  // Lands on 2.png (index 2 in new list [ .., 1.png, 2.png ])
  assert.equal(state.filename, '2.png');
  assert.equal(state.index, 2);
});

