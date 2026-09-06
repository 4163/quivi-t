import test from 'node:test';
import assert from 'node:assert/strict';

// Mock browser globals required for Node test environment
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async () => ({}),
      convertFileSrc: (p) => p
    }
  },
  dispatchEvent: () => {}
};

const { Core } = await import('../core.js');
const { DEFAULT_SPREAD_ENABLED, DEFAULT_SPREAD_MODE, mergeConfig } = await import('../keybinds.js');
const { dispatch } = await import('../services/actions.js');

test('Core: default spread mode is off', () => {
  assert.equal(DEFAULT_SPREAD_ENABLED, false);
  assert.equal(DEFAULT_SPREAD_MODE, 'off');
  const merged = mergeConfig({});
  assert.equal(merged.frontend_data.spread_enabled, false);
});

test('Core: spread state initialization and dimension detection', () => {
  Core.setImageDimensions(2000, 1000);
  let state = Core.getState();
  assert.equal(state.isSpread, true);
  assert.equal(state.naturalWidth, 2000);
  assert.equal(state.naturalHeight, 1000);

  // Non-spread dimensions (portrait)
  Core.setImageDimensions(1000, 1500);
  state = Core.getState();
  assert.equal(state.isSpread, false);
  assert.equal(state.spreadStep, 1);
});

test('Core: spread enabled and direction setting', () => {
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

  // Compatibility methods
  Core.setSpreadMode('off');
  assert.equal(Core.getState().spreadEnabled, false);

  Core.setSpreadMode('rtl');
  assert.equal(Core.getState().spreadEnabled, true);
  assert.equal(Core.getState().spreadDirection, 'rtl');
});

test('Core: step navigation on 2-page spreads', () => {
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

test('Core: spread stepping bypassed when mode is off or fit is window', () => {
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

test('Core: toggleSpreadMode toggles active mode to off', () => {
  Core.setSpreadMode('off');
  assert.equal(Core.getState().spreadEnabled, false);

  // When off, toggleSpreadMode('rtl') turns RTL on
  Core.toggleSpreadMode('rtl');
  assert.equal(Core.getState().spreadEnabled, true);
  assert.equal(Core.getState().spreadDirection, 'rtl');

  // When already in RTL, toggleSpreadMode('rtl') turns it off
  Core.toggleSpreadMode('rtl');
  assert.equal(Core.getState().spreadEnabled, false);

  // When off, toggleSpreadMode('ltr') turns LTR on
  Core.toggleSpreadMode('ltr');
  assert.equal(Core.getState().spreadEnabled, true);
  assert.equal(Core.getState().spreadDirection, 'ltr');

  // When already in LTR, toggleSpreadMode('ltr') turns it off
  Core.toggleSpreadMode('ltr');
  assert.equal(Core.getState().spreadEnabled, false);

  // Switching between directions keeps spread enabled
  Core.toggleSpreadMode('rtl');
  assert.equal(Core.getState().spreadEnabled, true);
  assert.equal(Core.getState().spreadDirection, 'rtl');
  Core.toggleSpreadMode('ltr');
  assert.equal(Core.getState().spreadEnabled, true);
  assert.equal(Core.getState().spreadDirection, 'ltr');

  // 'off' directly disables
  Core.toggleSpreadMode('off');
  assert.equal(Core.getState().spreadEnabled, false);
});

test('Actions: dispatching spread actions toggles checked option to off', async () => {
  const ctx = { Core };

  Core.setSpreadMode('off');
  assert.equal(Core.getState().spreadEnabled, false);

  // Trigger cmd-spread-direction-rtl
  await dispatch('cmd-spread-direction-rtl', {}, ctx);
  assert.equal(Core.getState().spreadEnabled, true);
  assert.equal(Core.getState().spreadDirection, 'rtl');

  // Triggering again when already checked must go to off
  await dispatch('cmd-spread-direction-rtl', {}, ctx);
  assert.equal(Core.getState().spreadEnabled, false);

  // Trigger cmd-spread-direction-ltr
  await dispatch('cmd-spread-direction-ltr', {}, ctx);
  assert.equal(Core.getState().spreadEnabled, true);
  assert.equal(Core.getState().spreadDirection, 'ltr');

  // Triggering again when already checked must go to off
  await dispatch('cmd-spread-direction-ltr', {}, ctx);
  assert.equal(Core.getState().spreadEnabled, false);
});