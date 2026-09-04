import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewportState, getEffectiveScaling, invertViewport } from '../services/viewerMath.js';

test('viewerMath: initial state and fit modes', () => {
  let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
  const state = createViewportState({ getViewport: () => vp });

  assert.equal(state.getUserTransformed(), false);
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
