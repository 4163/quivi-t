import assert from 'node:assert/strict';

// Mock minimal browser globals for Node test environment
if (typeof window === 'undefined') {
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async () => ({}),
        convertFileSrc: (p) => p
      }
    },
    dispatchEvent: () => {}
  };
}

const { Core } = await import('../src/js/core.js');
const {
  DEFAULT_SPREAD_ENABLED,
  DEFAULT_SPREAD_MODE,
  DEFAULT_FIT_MODE,
  DEFAULT_FILE_LIST_VIEW_MODE,
  mergeConfig
} = await import('../src/js/keybinds.js');

describe('Core state machine', () => {
  describe('default state and configuration merging', () => {
    it('initializes with default spread and fit settings', () => {
      assert.equal(DEFAULT_SPREAD_ENABLED, false);
      assert.equal(DEFAULT_SPREAD_MODE, 'off');
      assert.equal(DEFAULT_FIT_MODE, 'height-if-larger');
      assert.equal(DEFAULT_FILE_LIST_VIEW_MODE, 'list');

      const merged = mergeConfig({});
      assert.equal(merged.frontend_data.spread_enabled, false);
      assert.equal(merged.frontend_data.file_list_view_mode, 'list');
    });

    it('notifies subscribers on state change', () => {
      let notified = false;
      Core.onStateChange(() => {
        notified = true;
      });

      Core.setFileListVisible(false);
      assert.equal(notified, true);
      assert.equal(Core.getState().fileListVisible, false);

      notified = false;
      Core.setFileListVisible(true);
      assert.equal(notified, true);
      assert.equal(Core.getState().fileListVisible, true);
    });
  });

  describe('dimension updates and spread detection', () => {
    it('detects landscape images as spreads based on aspect ratio', () => {
      Core.setImageDimensions(2000, 1000);
      let state = Core.getState();
      assert.equal(state.isSpread, true);
      assert.equal(state.naturalWidth, 2000);
      assert.equal(state.naturalHeight, 1000);

      // Portrait dimensions: not a spread
      Core.setImageDimensions(1000, 1500);
      state = Core.getState();
      assert.equal(state.isSpread, false);
      assert.equal(state.spreadStep, 1);
    });

    it('updates spread enabled and direction flags', () => {
      Core.setSpreadEnabled(true);
      Core.setSpreadDirection('rtl');
      assert.equal(Core.getState().spreadEnabled, true);
      assert.equal(Core.getState().spreadDirection, 'rtl');

      Core.toggleSpreadEnabled();
      assert.equal(Core.getState().spreadEnabled, false);

      Core.toggleSpreadEnabled();
      assert.equal(Core.getState().spreadEnabled, true);

      Core.setSpreadDirection('ltr');
      assert.equal(Core.getState().spreadDirection, 'ltr');

      // Reset to off
      Core.setSpreadMode('off');
      assert.equal(Core.getState().spreadEnabled, false);
    });

    it('toggles active spread mode off and switches modes correctly', () => {
      Core.setSpreadMode('off');
      assert.equal(Core.getState().spreadEnabled, false);

      Core.toggleSpreadMode('rtl');
      assert.equal(Core.getState().spreadEnabled, true);
      assert.equal(Core.getState().spreadDirection, 'rtl');

      Core.toggleSpreadMode('rtl');
      assert.equal(Core.getState().spreadEnabled, false);
    });
  });

  describe('spread step navigation', () => {
    it('advances through spread steps on 2-page spreads', () => {
      const dummyList = [
        { name: '01.png', path: '/manga/01.png' },
        { name: '02_03_spread.png', path: '/manga/02_03_spread.png' },
        { name: '04.png', path: '/manga/04.png' }
      ];

      Core.setListAndIndex(dummyList, 0);
      Core.setFitMode('width');
      Core.setSpreadMode('rtl');

      // Select the spread image
      Core.selectIndex(1);
      Core.setImageDimensions(2400, 1200);

      let state = Core.getState();
      assert.equal(state.index, 1);
      assert.equal(state.isSpread, true);
      assert.equal(state.spreadStep, 1);

      // Next: advances from Step 1 to Step 2 (stays on index 1)
      Core.navigate(1);
      state = Core.getState();
      assert.equal(state.index, 1);
      assert.equal(state.spreadStep, 2);

      // Next: advances from Step 2 to next file (index 2)
      Core.navigate(1);
      state = Core.getState();
      assert.equal(state.index, 2);

      // Previous: navigating backward into spread enters at Step 2
      Core.navigate(-1);
      Core.setImageDimensions(2400, 1200);
      state = Core.getState();
      assert.equal(state.index, 1);
      assert.equal(state.spreadStep, 2);

      // Previous: advances from Step 2 to Step 1 (stays on index 1)
      Core.navigate(-1);
      state = Core.getState();
      assert.equal(state.index, 1);
      assert.equal(state.spreadStep, 1);

      // Previous: advances from Step 1 to previous file (index 0)
      Core.navigate(-1);
      state = Core.getState();
      assert.equal(state.index, 0);
    });

    it('bypasses spread stepping when mode is off or fit is window', () => {
      const dummyList = [
        { name: '01.png', path: '/manga/01.png' },
        { name: '02_03_spread.png', path: '/manga/02_03_spread.png' },
        { name: '04.png', path: '/manga/04.png' }
      ];

      Core.setListAndIndex(dummyList, 1);
      Core.setImageDimensions(2400, 1200);

      // In window fit mode, stepping is inactive
      Core.setFitMode('window');
      Core.setSpreadMode('rtl');
      assert.equal(Core.getState().spreadStep, 1);
      Core.navigate(1);
      assert.equal(Core.getState().index, 2);

      // Return to spread and switch spreadMode to off
      Core.selectIndex(1);
      Core.setImageDimensions(2400, 1200);
      Core.setFitMode('width');
      Core.setSpreadMode('off');
      assert.equal(Core.getState().spreadStep, 1);
      Core.navigate(1);
      assert.equal(Core.getState().index, 2);
    });
  });

  describe('file list view mode', () => {
    it('toggles between list and thumbnail view modes', () => {
      Core.setFileListViewMode('list');
      assert.equal(Core.getState().fileListViewMode, 'list');

      Core.toggleFileListViewMode();
      assert.equal(Core.getState().fileListViewMode, 'thumbnail');

      Core.toggleFileListViewMode();
      assert.equal(Core.getState().fileListViewMode, 'list');
    });
  });

  describe('archive encryption state', () => {
    it('tracks and clears archive encryption status via setState', () => {
      Core.setState({ archiveEncryption: 'password_required' });
      assert.equal(Core.getState().archiveEncryption, 'password_required');

      Core.setState({ archiveEncryption: 'password_incorrect' });
      assert.equal(Core.getState().archiveEncryption, 'password_incorrect');

      Core.setState({ archiveEncryption: null });
      assert.equal(Core.getState().archiveEncryption, null);
    });

    it('clears archiveEncryption and archivePath on selectIndex(-1) in directory mode', () => {
      Core.setState({
        mode: 'image',
        directory: '/images',
        archivePath: '/images/secret.zip',
        archiveEncryption: 'password_required',
        index: 0,
        filename: 'secret.zip: password required',
        list: [{ name: 'secret.zip', path: '/images/secret.zip' }]
      });

      Core.selectIndex(-1);

      const state = Core.getState();
      assert.equal(state.index, -1);
      assert.equal(state.archivePath, '');
      assert.equal(state.archiveEncryption, null);
      assert.equal(state.filename, '');
    });

    it('preserves archivePath and archiveEncryption on selectIndex(-1) in archive mode', () => {
      Core.setState({
        mode: 'archive',
        directory: '',
        archivePath: '/images/secret.zip',
        archiveEncryption: 'password_required',
        index: 0,
        filename: 'secret.zip: password required',
        list: [{ name: 'secret.zip', path: '/images/secret.zip' }]
      });

      Core.selectIndex(-1);

      const state = Core.getState();
      assert.equal(state.index, -1);
      assert.equal(state.archivePath, '/images/secret.zip');
      assert.equal(state.archiveEncryption, 'password_required');
    });

    it('formats active file filename as <name>: password required when inside locked archive', () => {
      const dummyList = [
        { name: '..', is_parent: true },
        { name: 'vlcsnap-2026-07-03-12h02m23s726.png', path: 'vlcsnap-2026-07-03-12h02m23s726.png' }
      ];
      Core.setState({
        mode: 'archive',
        directory: '',
        archivePath: '/images/locked.rar',
        archiveEncryption: 'password_required',
        index: 0,
        list: dummyList
      });

      Core.selectIndex(1);

      const state = Core.getState();
      assert.equal(state.index, 1);
      assert.equal(state.filename, 'vlcsnap-2026-07-03-12h02m23s726.png: password required');

      // Parent row keeps simple '..'
      Core.selectIndex(0);
      assert.equal(Core.getState().index, 0);
      assert.equal(Core.getState().filename, '..');
    });
  });
});
