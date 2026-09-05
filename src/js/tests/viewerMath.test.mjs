import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewportState, getEffectiveScaling, invertViewport, checkIsSpread } from '../services/viewerMath.js';

test('viewerMath: checkIsSpread ratio detection', () => {
  assert.equal(checkIsSpread(2000, 1000), true);
  assert.equal(checkIsSpread(1200, 1000), true);
  assert.equal(checkIsSpread(1199, 1000), false);
  assert.equal(checkIsSpread(1000, 1500), false);
  assert.equal(checkIsSpread(0, 1000), false);
  assert.equal(checkIsSpread(1000, 0), false);
  assert.equal(checkIsSpread(null, null), false);
});

test('viewerMath: spread mode half-width fit and step alignment (RTL)', () => {
  let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
  const state = createViewportState({ getViewport: () => vp });

  state.setSpreadMode('rtl');
  state.setSpreadStep(1);

  // 2000x1000 image in 1000x800 viewport.
  // In width fit mode with spread active:
  // effective width = 1000, so scale = 1000 / 1000 = 1.0.
  // Rendered width = 2000 * 1.0 = 2000.
  // maxX = (2000 - 1000) / 2 = 500.
  state.applyFitMode('width', 2000, 1000);
  assert.equal(state.getScale(), 1.0);
  // RTL Step 1: Right half -> tx = -maxX (-500)
  assert.equal(state.getTx(), -500);

  // Advance to Step 2
  state.setSpreadStep(2);
  // RTL Step 2: Left half -> tx = +maxX (+500)
  assert.equal(state.getTx(), 500);
  assert.equal(state.getScale(), 1.0);

  // Step back to Step 1
  state.setSpreadStep(1);
  assert.equal(state.getTx(), -500);
});

test('viewerMath: spread mode half-width fit and step alignment (LTR)', () => {
  let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
  const state = createViewportState({ getViewport: () => vp });

  state.setSpreadMode('ltr');
  state.setSpreadStep(1);

  state.applyFitMode('width', 2000, 1000);
  assert.equal(state.getScale(), 1.0);
  // LTR Step 1: Left half -> tx = +maxX (+500)
  assert.equal(state.getTx(), 500);

  // Advance to Step 2
  state.setSpreadStep(2);
  // LTR Step 2: Right half -> tx = -maxX (-500)
  assert.equal(state.getTx(), -500);
});

test('viewerMath: spread mode disabled or non-spread image', () => {
  let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
  const state = createViewportState({ getViewport: () => vp });

  // Mode 'off': normal full-width scale (1000 / 2000 = 0.5)
  state.setSpreadMode('off');
  state.applyFitMode('width', 2000, 1000);
  assert.equal(state.getScale(), 0.5);
  assert.equal(state.getTx(), 0);

  // Mode 'rtl', but image is portrait (1000x1500) -> not a spread
  state.setSpreadMode('rtl');
  state.applyFitMode('width', 1000, 1500);
  assert.equal(state.getScale(), 1.0); // 1000 / 1000
  assert.equal(state.getTx(), 0);

  // Fit 'window' on spread image keeps full 2-page spread uncropped
  state.applyFitMode('window', 2000, 1000);
  assert.equal(state.getScale(), 0.5); // min(1000/2000, 800/1000)
  assert.equal(state.getTx(), 0);
});

test('viewerMath: initial state and fit modes', () => {
  let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
  const state = createViewportState({ getViewport: () => vp });

  assert.equal(state.getUserTransformed(), false);
  assert.equal(state.getSpreadEnabled(), false);
  assert.equal(state.getScale(), 1);

  // Apply fit 'window' with 2000x1000 image in 1000x800 viewport
  // Scale should be 1000/2000 = 0.5
  state.applyFitMode('window', 2000, 1000);
  assert.equal(state.getUserTransformed(), false);
  assert.equal(state.getScale(), 0.5);

  // Apply fit 'height' with 1000x2000 image in 1000x800 viewport
  // Scale should be 800/2000 = 0.4
  state.applyFitMode('height', 1000, 2000);
  assert.equal(state.getUserTransformed(), false);
  assert.equal(state.getScale(), 0.4);

  // Apply fit 'none'
  state.applyFitMode('none', 1000, 2000);
  assert.equal(state.getUserTransformed(), false);
  assert.equal(state.getScale(), 1);
});

test('viewerMath: handleViewportResize in strict fit mode recalculates scale', () => {
  let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
  const state = createViewportState({ getViewport: () => vp });

  state.applyFitMode('window', 2000, 1000);
  assert.equal(state.getScale(), 0.5);
  assert.equal(state.getUserTransformed(), false);

  // Viewport expands to 1600x800 (scale should become 1600/2000 = 0.8)
  vp = { clientWidth: 1600, clientHeight: 800, left: 0, top: 0 };
  state.handleViewportResize(1600, 800);
  assert.equal(state.getScale(), 0.8);
  assert.equal(state.getUserTransformed(), false);
});

test('viewerMath: handleViewportResize preserves manual zoom/pan', () => {
  let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
  const state = createViewportState({ getViewport: () => vp });

  state.applyFitMode('window', 2000, 1000);
  assert.equal(state.getScale(), 0.5);
  assert.equal(state.getUserTransformed(), false);

  // User manually zooms to 2.5x
  state.zoomTo(2.5, 500, 400);
  assert.equal(state.getUserTransformed(), true);
  assert.equal(state.getScale(), 2.5);

  // Viewport resizes to 1200x900 (e.g. sidebar collapsed or window resized)
  vp = { clientWidth: 1200, clientHeight: 900, left: 0, top: 0 };
  state.handleViewportResize(1200, 900);

  // Manual zoom MUST be retained (not reset to fit mode 0.6)
  assert.equal(state.getScale(), 2.5);
  assert.equal(state.getUserTransformed(), true);

  // Explicitly calling applyFitMode resets userTransformed flag
  state.applyFitMode('window');
  assert.equal(state.getUserTransformed(), false);
  assert.equal(state.getScale(), 0.6); // 1200 / 2000
});

test('viewerMath: pan operations set userTransformed', () => {
  let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
  const state = createViewportState({ getViewport: () => vp });

  state.applyFitMode('window', 2000, 1000);
  assert.equal(state.getUserTransformed(), false);

  state.panTo(50, 50);
  assert.equal(state.getUserTransformed(), true);

  state.resetGeometry();
  assert.equal(state.getUserTransformed(), false);
  assert.equal(state.getScale(), 1);
  assert.equal(state.getTx(), 0);
  assert.equal(state.getTy(), 0);
});

test('viewerMath: getEffectiveScaling and invertViewport', () => {
  assert.equal(getEffectiveScaling('lanczos', false, true), 'bilinear');
  assert.equal(getEffectiveScaling('lanczos', false, false), 'lanczos');
  assert.equal(getEffectiveScaling('none', false, false), 'none');

  const geom = { scale: 1, tx: 0, ty: 0, rotation: 0, flipX: 1, flipY: 1 };
  const pt = invertViewport(0, 0, geom, 200, 100);
  assert.equal(pt.x, 100);
  assert.equal(pt.y, 50);
});
