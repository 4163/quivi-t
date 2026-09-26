import assert from 'node:assert/strict';
import {
  createViewportState,
  getEffectiveScaling,
  invertViewport,
  checkIsSpread,
  computeStripWidth,
  computeColumnOffsets,
  computeColumnLayout,
  findAnchorIndex,
  computeWindowRange
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

  describe('grill counter-angle calculations', () => {
    it('defaults to -45deg at 0 rotation and no flip', () => {
      const state = createViewportState();
      assert.equal(state.getGrillAngle(), '-45deg');
    });

    it('inverts angle on 90 and 270 degree rotation, preserves on 0 and 180', () => {
      const state = createViewportState();
      state.rotate(90);
      assert.equal(state.getGrillAngle(), '45deg');
      state.rotate(90); // 180deg
      assert.equal(state.getGrillAngle(), '-45deg');
      state.rotate(90); // 270deg
      assert.equal(state.getGrillAngle(), '45deg');
      state.rotate(90); // 360/0deg
      assert.equal(state.getGrillAngle(), '-45deg');
      state.rotate(-90); // 270/-90deg
      assert.equal(state.getGrillAngle(), '45deg');
    });

    it('inverts angle on single axis flip and restores on dual flip', () => {
      const state = createViewportState();
      state.flip('x');
      assert.equal(state.getGrillAngle(), '45deg');
      state.flip('y');
      assert.equal(state.getGrillAngle(), '-45deg');
      state.flip('x');
      assert.equal(state.getGrillAngle(), '45deg');
      state.flip('y');
      assert.equal(state.getGrillAngle(), '-45deg');
    });

    it('correctly calculates parity for composite rotation and flip', () => {
      const state = createViewportState();
      state.rotate(90);
      state.flip('x');
      assert.equal(state.getGrillAngle(), '-45deg');

      state.flip('y');
      assert.equal(state.getGrillAngle(), '45deg');

      state.rotate(90); // 180deg + flip x + flip y -> net 0 flip
      assert.equal(state.getGrillAngle(), '-45deg');

      state.resetGeometry();
      assert.equal(state.getGrillAngle(), '-45deg');
    });
  });

  describe('computeStripWidth', () => {
    it('returns viewport width for all layout fit modes at zoom 1', () => {
      for (const mode of ['width', 'width-if-larger', 'height', 'height-if-larger', 'window', 'window-if-larger']) {
        assert.equal(computeStripWidth(mode, 1200), 1200, mode);
      }
    });

    it('returns null for none (natural width)', () => {
      assert.equal(computeStripWidth('none', 1200), null);
    });

    it('scales by zoom factor', () => {
      assert.equal(computeStripWidth('width', 1000, 1.5), 1500);
      assert.equal(computeStripWidth('width', 1000, 0.5), 500);
    });

    it('returns null for zero or missing viewport', () => {
      assert.equal(computeStripWidth('width', 0), null);
      assert.equal(computeStripWidth('width', null), null);
      assert.equal(computeStripWidth('width', undefined), null);
    });
  });

  describe('computeColumnOffsets', () => {
    const sampleItems = [
      { width: 800, height: 1200 },
      { width: 1000, height: 1500 },
      { width: 900, height: 1100 }
    ];

    it('determines widest width and unscaled column width at zoom 1', () => {
      const layout = computeColumnOffsets(sampleItems, 1);
      assert.equal(layout.widestWidth, 1000);
      assert.equal(layout.columnWidth, 1000);
      assert.equal(layout.totalHeight, 3800);
    });

    it('derives per-item offsets from heights at that width', () => {
      const layout = computeColumnOffsets(sampleItems, 1);
      assert.equal(layout.offsets.length, 3);

      assert.deepEqual(layout.offsets[0], { top: 0, height: 1200, bottom: 1200 });
      assert.deepEqual(layout.offsets[1], { top: 1200, height: 1500, bottom: 2700 });
      assert.deepEqual(layout.offsets[2], { top: 2700, height: 1100, bottom: 3800 });
    });

    it('scales column width, heights, and offsets by zoom factor', () => {
      const layout15 = computeColumnOffsets(sampleItems, 1.5);
      assert.equal(layout15.widestWidth, 1000);
      assert.equal(layout15.columnWidth, 1500);
      assert.equal(layout15.totalHeight, 5700);
      assert.deepEqual(layout15.offsets[0], { top: 0, height: 1800, bottom: 1800 });
      assert.deepEqual(layout15.offsets[1], { top: 1800, height: 2250, bottom: 4050 });
      assert.deepEqual(layout15.offsets[2], { top: 4050, height: 1650, bottom: 5700 });

      const layout05 = computeColumnOffsets(sampleItems, 0.5);
      assert.equal(layout05.columnWidth, 500);
      assert.equal(layout05.totalHeight, 1900);
      assert.deepEqual(layout05.offsets[0], { top: 0, height: 600, bottom: 600 });
      assert.deepEqual(layout05.offsets[1], { top: 600, height: 750, bottom: 1350 });
      assert.deepEqual(layout05.offsets[2], { top: 1350, height: 550, bottom: 1900 });
    });

    it('supports naturalWidth and naturalHeight properties', () => {
      const domItems = [
        { naturalWidth: 1200, naturalHeight: 1800 },
        { naturalWidth: 600, naturalHeight: 900 }
      ];
      const layout = computeColumnOffsets(domItems, 1);
      assert.equal(layout.widestWidth, 1200);
      assert.equal(layout.columnWidth, 1200);
      assert.equal(layout.totalHeight, 2700);
      assert.deepEqual(layout.offsets[0], { top: 0, height: 1800, bottom: 1800 });
      assert.deepEqual(layout.offsets[1], { top: 1800, height: 900, bottom: 2700 });
    });

    it('handles empty and invalid input gracefully', () => {
      const empty = computeColumnOffsets([]);
      assert.equal(empty.widestWidth, 0);
      assert.equal(empty.columnWidth, 0);
      assert.equal(empty.totalHeight, 0);
      assert.deepEqual(empty.offsets, []);

      const nonArray = computeColumnOffsets(null);
      assert.equal(nonArray.widestWidth, 0);
      assert.equal(nonArray.columnWidth, 0);
      assert.equal(nonArray.totalHeight, 0);
      assert.deepEqual(nonArray.offsets, []);
    });

    it('aliases computeColumnLayout to computeColumnOffsets', () => {
      assert.equal(computeColumnLayout, computeColumnOffsets);
    });
  });

  describe('findAnchorIndex', () => {
    const offsets = [
      { top: 0, bottom: 1000, height: 1000 },
      { top: 1000, bottom: 2500, height: 1500 },
      { top: 2500, bottom: 3500, height: 1000 }
    ];

    it('identifies item containing center coordinate', () => {
      assert.equal(findAnchorIndex(offsets, 500), 0);
      assert.equal(findAnchorIndex(offsets, 1000), 1);
      assert.equal(findAnchorIndex(offsets, 1800), 1);
      assert.equal(findAnchorIndex(offsets, 2500), 2);
      assert.equal(findAnchorIndex(offsets, 3000), 2);
    });

    it('clamps to first or last item when out of range', () => {
      assert.equal(findAnchorIndex(offsets, -500), 0);
      assert.equal(findAnchorIndex(offsets, 0), 0);
      assert.equal(findAnchorIndex(offsets, 3500), 2);
      assert.equal(findAnchorIndex(offsets, 9999), 2);
    });

    it('handles empty or invalid offsets', () => {
      assert.equal(findAnchorIndex([], 500), -1);
      assert.equal(findAnchorIndex(null, 500), -1);
    });
  });

  describe('computeWindowRange', () => {
    const offsets = [
      { top: 0, bottom: 1000, height: 1000 },
      { top: 1000, bottom: 2500, height: 1500 },
      { top: 2500, bottom: 3500, height: 1000 },
      { top: 3500, bottom: 5000, height: 1500 }
    ];

    it('computes start and end index for visible range plus buffer', () => {
      // Overlaps item 1 and item 2
      assert.deepEqual(computeWindowRange(offsets, 1200, 2800), { startIndex: 1, endIndex: 2 });
      // Overlaps all items
      assert.deepEqual(computeWindowRange(offsets, -500, 6000), { startIndex: 0, endIndex: 3 });
      // Overlaps only item 0
      assert.deepEqual(computeWindowRange(offsets, 100, 500), { startIndex: 0, endIndex: 0 });
    });

    it('returns -1 for ranges completely outside the column', () => {
      assert.deepEqual(computeWindowRange(offsets, -1000, 0), { startIndex: -1, endIndex: -1 });
      assert.deepEqual(computeWindowRange(offsets, 5000, 6000), { startIndex: -1, endIndex: -1 });
      assert.deepEqual(computeWindowRange([], 0, 1000), { startIndex: -1, endIndex: -1 });
    });
  });

  describe('setDimensions on viewportState', () => {
    it('updates natural dimensions and clamps pan', () => {
      const vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
      const state = createViewportState({ getViewport: () => vp });
      state.applyFitMode('none', 1000, 2000);
      assert.equal(state.getNaturalW(), 1000);
      assert.equal(state.getNaturalH(), 2000);

      // Pan to bottom boundary
      state.panBy(0, -600);
      assert.equal(state.getTy(), -600);

      // Update dimensions to shorter height
      state.setDimensions(1000, 1500);
      assert.equal(state.getNaturalH(), 1500);
      // Clamped to new maxY: (1500 - 800) / 2 = 350
      assert.equal(state.getTy(), -350);
    });
  });
});
