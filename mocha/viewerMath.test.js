import assert from 'node:assert/strict';
import {
  createViewportState,
  getEffectiveScaling,
  invertViewport,
  checkIsSpread
} from '../src/js/services/viewerMath.js';

describe('viewerMath', () => {
  describe('checkIsSpread', () => {
    it('detects aspect ratios at or above the 1.2 threshold', () => {
      assert.equal(checkIsSpread(2000, 1000), true);
      assert.equal(checkIsSpread(1200, 1000), true);
      assert.equal(checkIsSpread(1199, 1000), false);
      assert.equal(checkIsSpread(1000, 1500), false);
      assert.equal(checkIsSpread(0, 1000), false);
      assert.equal(checkIsSpread(1000, 0), false);
      assert.equal(checkIsSpread(null, null), false);
    });
  });

  describe('spread mode fit and step alignment', () => {
    it('aligns right and left pages for RTL reading order', () => {
      let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
      const state = createViewportState({ getViewport: () => vp });

      state.setSpreadMode('rtl');
      state.setSpreadStep(1);

      // 2000x1000 image in 1000x800 viewport.
      // Width fit mode with spread active: scale = 1000 / 1000 = 1.0.
      // Rendered width = 2000 * 1.0 = 2000, maxX = (2000 - 1000) / 2 = 500.
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

    it('aligns left and right pages for LTR reading order', () => {
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

    it('handles disabled spread mode and single-page images', () => {
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
      assert.equal(state.getScale(), 1.0);
      assert.equal(state.getTx(), 0);

      // Fit 'window' on spread image keeps full 2-page spread uncropped
      state.applyFitMode('window', 2000, 1000);
      assert.equal(state.getScale(), 0.5);
      assert.equal(state.getTx(), 0);
    });
  });

  describe('fit modes and viewport state', () => {
    it('calculates scaling for standard fit modes', () => {
      let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
      const state = createViewportState({ getViewport: () => vp });

      assert.equal(state.getUserTransformed(), false);
      assert.equal(state.getSpreadEnabled(), false);
      assert.equal(state.getScale(), 1);

      // Fit 'window' with 2000x1000 image in 1000x800 viewport -> scale = 1000/2000 = 0.5
      state.applyFitMode('window', 2000, 1000);
      assert.equal(state.getUserTransformed(), false);
      assert.equal(state.getScale(), 0.5);

      // Fit 'height' with 1000x2000 image in 1000x800 viewport -> scale = 800/2000 = 0.4
      state.applyFitMode('height', 1000, 2000);
      assert.equal(state.getUserTransformed(), false);
      assert.equal(state.getScale(), 0.4);

      // Fit 'none' (1:1 original size)
      state.applyFitMode('none', 1000, 2000);
      assert.equal(state.getUserTransformed(), false);
      assert.equal(state.getScale(), 1);
    });

    it('recalculates scale on viewport resize in strict fit mode', () => {
      let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
      const state = createViewportState({ getViewport: () => vp });

      state.applyFitMode('window', 2000, 1000);
      assert.equal(state.getScale(), 0.5);
      assert.equal(state.getUserTransformed(), false);

      // Viewport expands to 1600x800 -> scale becomes 1600/2000 = 0.8
      vp = { clientWidth: 1600, clientHeight: 800, left: 0, top: 0 };
      state.handleViewportResize(1600, 800);
      assert.equal(state.getScale(), 0.8);
      assert.equal(state.getUserTransformed(), false);
    });

    it('preserves manual zoom and pan offsets across viewport resize', () => {
      let vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
      const state = createViewportState({ getViewport: () => vp });

      state.applyFitMode('window', 2000, 1000);
      assert.equal(state.getScale(), 0.5);
      assert.equal(state.getUserTransformed(), false);

      // Manual zoom to 2.5x
      state.zoomTo(2.5, 500, 400);
      assert.equal(state.getUserTransformed(), true);
      assert.equal(state.getScale(), 2.5);

      // Viewport resizes
      vp = { clientWidth: 1200, clientHeight: 900, left: 0, top: 0 };
      state.handleViewportResize(1200, 900);

      // Manual zoom is retained rather than reset to fit mode
      assert.equal(state.getScale(), 2.5);
      assert.equal(state.getUserTransformed(), true);

      // Explicit fit mode call resets userTransformed
      state.applyFitMode('window');
      assert.equal(state.getUserTransformed(), false);
      assert.equal(state.getScale(), 0.6);
    });

    it('updates userTransformed flag on pan and resets on resetGeometry', () => {
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
  });

  describe('coordinate and scaling helpers', () => {
    it('resolves effective scaling mode correctly', () => {
      assert.equal(getEffectiveScaling('lanczos', false, true), 'bilinear');
      assert.equal(getEffectiveScaling('lanczos', false, false), 'lanczos');
      assert.equal(getEffectiveScaling('none', false, false), 'none');
    });

    it('inverts viewport coordinates to natural image space', () => {
      const geom = { scale: 1, tx: 0, ty: 0, rotation: 0, flipX: 1, flipY: 1 };
      const pt = invertViewport(0, 0, geom, 200, 100);
      assert.equal(pt.x, 100);
      assert.equal(pt.y, 50);
    });
  });
});
