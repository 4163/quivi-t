import assert from 'node:assert/strict';
import {
  createViewportState,
  getEffectiveScaling,
  invertViewport,
  checkIsSpread,
  computeStripWidth,
  computeColumnOffsets,
  computeColumnLayout,
  seamOverlapForScale,
  findAnchorIndex,
  computeWindowRange,
  computeTopAlignTy,
  computeBottomAlignTy,
  computeSlotHue,
  computeStripFitScale
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

    it('mirrors the CSS seam overlap for any zoom scale', () => {
      assert.equal(seamOverlapForScale(1), 1);
      assert.equal(seamOverlapForScale(2), 1);
      assert.equal(seamOverlapForScale(0.5), 2);
      assert.equal(seamOverlapForScale(0.25), 4);
      assert.equal(seamOverlapForScale(0), 1);
    });

    it('shifts offsets up by the seam overlap per boundary', () => {
      const items = [
        { naturalWidth: 800, naturalHeight: 1000 },
        { naturalWidth: 800, naturalHeight: 1500 },
        { naturalWidth: 800, naturalHeight: 1000 }
      ];
      const layout = computeColumnOffsets(items, 1, 1);
      assert.deepEqual(layout.offsets.map((o) => o.top), [0, 999, 2498]);
      assert.equal(layout.totalHeight, 3498);

      const plain = computeColumnOffsets(items, 1);
      assert.deepEqual(plain.offsets.map((o) => o.top), [0, 1000, 2500]);
      assert.equal(plain.totalHeight, 3500);
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

    it('picks correct slot when center coordinate is in seam overlap', () => {
      const seamOffsets = [
        { top: 0, bottom: 1000, height: 1000 },
        { top: 999, bottom: 2499, height: 1500 }
      ];
      // 999.5 is in item 1's visual domain (since item 1 starts at 999 and covers item 0)
      assert.equal(findAnchorIndex(seamOffsets, 999.5), 1);
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

    it('handles exact exclusive boundaries and single visible item', () => {
      // Exactly covers item 0 with exclusive boundary at 1000 (item 1 top)
      assert.deepEqual(computeWindowRange(offsets, 0, 1000), { startIndex: 0, endIndex: 0 });
      // Exactly covers item 1 with exclusive boundary at 1000 (item 0 bottom)
      assert.deepEqual(computeWindowRange(offsets, 1000, 2000), { startIndex: 1, endIndex: 1 });
      // Window fully inside item 1
      assert.deepEqual(computeWindowRange(offsets, 1200, 1800), { startIndex: 1, endIndex: 1 });
    });

    it('does not include preceding slot when next slot is top aligned with seam overlap', () => {
      const seamOffsets = [
        { top: 0, bottom: 1000, height: 1000 },
        { top: 999, bottom: 2499, height: 1500 },
        { top: 2498, bottom: 3498, height: 1000 },
      ];
      // Top aligned to item 1 (top: 999) with viewport height 800
      assert.deepEqual(computeWindowRange(seamOffsets, 999, 1799), { startIndex: 1, endIndex: 1 });
      // Top aligned to item 2 (top: 2498) with viewport height 800
      assert.deepEqual(computeWindowRange(seamOffsets, 2498, 3298), { startIndex: 2, endIndex: 2 });
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

  describe('short content clamping on viewportState', () => {
    it('allows panning shorter content within viewport bounds', () => {
      const vp = { clientWidth: 1000, clientHeight: 800, left: 0, top: 0 };
      const state = createViewportState({ getViewport: () => vp });
      state.applyFitMode('none', 800, 400);

      // Short height 400 in 800 viewport clamps ty to +/- 200, never locked
      state.panTo(0, -200);
      assert.equal(state.getTy(), -200);
      state.panTo(0, 200);
      assert.equal(state.getTy(), 200);
      state.panTo(0, 0);
      assert.equal(state.getTy(), 0);

      // Attempts past the edges clamp to viewport bounds
      state.panBy(0, 500);
      assert.equal(state.getTy(), 200);
      state.panBy(0, -500);
      assert.equal(state.getTy(), -200);
    });
  });

  describe('computeTopAlignTy', () => {
    it('pins the first item to viewport top', () => {
      const ty = computeTopAlignTy({
        slotTop: 0,
        totalHeight: 3000,
        scale: 1,
        viewportHeight: 800
      });
      // (3000 - 800) / 2 = 1100
      assert.equal(ty, 1100);
    });

    it('aligns middle item top to viewport top', () => {
      const ty = computeTopAlignTy({
        slotTop: 1000,
        totalHeight: 3000,
        scale: 1,
        viewportHeight: 800
      });
      // (1500 - 1000) * 1 - 400 = 100
      assert.equal(ty, 100);
    });

    it('clamps last item to column bottom boundary', () => {
      const ty = computeTopAlignTy({
        slotTop: 2600,
        totalHeight: 3000,
        scale: 1,
        viewportHeight: 800
      });
      // minTy = -(3000 - 800) / 2 = -1100
      assert.equal(ty, -1100);
    });

    it('pins short columns down/towards bottom on top align regardless of slot offset', () => {
      const tyFirst = computeTopAlignTy({
        slotTop: 0,
        totalHeight: 500,
        scale: 1,
        viewportHeight: 800
      });
      // -(500 - 800) / 2 = 150
      assert.equal(tyFirst, 150);

      const tyLater = computeTopAlignTy({
        slotTop: 200,
        totalHeight: 500,
        scale: 1,
        viewportHeight: 800
      });
      assert.equal(tyLater, 150);
    });

    it('scales correctly for zoomed in and zoomed out states', () => {
      // Zoomed in (scale 2): visual height = 6000
      const tyZoomIn = computeTopAlignTy({
        slotTop: 1000,
        totalHeight: 3000,
        scale: 2,
        viewportHeight: 800
      });
      // (1500 - 1000) * 2 - 400 = 600
      assert.equal(tyZoomIn, 600);

      // Zoomed out (scale 0.5): visual height = 1500
      const tyZoomOut = computeTopAlignTy({
        slotTop: 1000,
        totalHeight: 3000,
        scale: 0.5,
        viewportHeight: 800
      });
      // (1500 - 1000) * 0.5 - 400 = -150
      assert.equal(tyZoomOut, -150);
    });
  });

  describe('computeBottomAlignTy', () => {
    it('pins the last item to viewport bottom', () => {
      const ty = computeBottomAlignTy({
        slotBottom: 3000,
        totalHeight: 3000,
        scale: 1,
        viewportHeight: 800
      });
      // -(3000 - 800) / 2 = -1100
      assert.equal(ty, -1100);
    });

    it('pins short columns up/towards top on bottom align regardless of slot offset', () => {
      const tyLast = computeBottomAlignTy({
        slotBottom: 500,
        totalHeight: 500,
        scale: 1,
        viewportHeight: 800
      });
      // (500 - 800) / 2 = -150
      assert.equal(tyLast, -150);

      const tyEarlier = computeBottomAlignTy({
        slotBottom: 200,
        totalHeight: 500,
        scale: 1,
        viewportHeight: 800
      });
      assert.equal(tyEarlier, -150);
    });

    it('scales correctly for zoomed in and zoomed out states', () => {
      // Zoomed in (scale 2): visual height = 6000
      const tyZoomIn = computeBottomAlignTy({
        slotBottom: 2000,
        totalHeight: 3000,
        scale: 2,
        viewportHeight: 800
      });
      // (1500 - 2000) * 2 + 400 = -600
      assert.equal(tyZoomIn, -600);

      // Zoomed out (scale 0.5): visual height = 1500
      const tyZoomOut = computeBottomAlignTy({
        slotBottom: 2000,
        totalHeight: 3000,
        scale: 0.5,
        viewportHeight: 800
      });
      // (1500 - 2000) * 0.5 + 400 = 150
      assert.equal(tyZoomOut, 150);
    });
  });

  describe('computeSlotHue', () => {
    it('produces distinct hues for all items in a set', () => {
      const colors = new Set();
      const count = 8;
      for (let i = 0; i < count; i++) {
        colors.add(computeSlotHue(i, count));
      }
      assert.equal(colors.size, count);
    });

    it('wraps around cleanly when index exceeds total or is negative', () => {
      const count = 6;
      assert.equal(computeSlotHue(count, count), computeSlotHue(0, count));
      assert.equal(computeSlotHue(count + 2, count), computeSlotHue(2, count));
      assert.equal(computeSlotHue(-1, count), computeSlotHue(count - 1, count));
    });

    it('skips the 190 through 240 blue/cyan range across various counts', () => {
      for (let count = 1; count <= 50; count++) {
        for (let i = 0; i < count; i++) {
          const color = computeSlotHue(i, count);
          const match = color.match(/^hsl\((\d+),\s*80%,\s*45%\)$/);
          assert.ok(match, `Invalid hsl format: ${color}`);
          const hue = parseInt(match[1], 10);
          assert.ok(hue < 190 || hue > 240, `Hue ${hue} fell inside skipped range [190, 240] for index ${i}/${count}`);
        }
      }
    });

    it('handles zero or negative total gracefully without NaN', () => {
      assert.equal(computeSlotHue(0, 0), 'hsl(0, 80%, 45%)');
      assert.equal(computeSlotHue(3, -5), 'hsl(0, 80%, 45%)');
    });
  });

  describe('computeStripFitScale', () => {
    it('calculates scaleY matching viewport height with seam overlap on first call', () => {
      const items = Array.from({ length: 10 }, () => ({ naturalHeight: 1000, naturalWidth: 800 }));
      const rawSumH = 10 * 1000;
      const vh = 800;
      const scale = computeStripFitScale({
        fitMode: 'height',
        vw: 1000,
        vh,
        maxW: 800,
        rawSumH,
        itemCount: items.length,
      });

      const seam = seamOverlapForScale(scale);
      const layout = computeColumnOffsets(items, 1, seam);
      const visualH = layout.totalHeight * scale;

      assert.ok(Math.abs(visualH - vh) < 1e-9, `Visual height ${visualH} did not match viewport ${vh}`);
    });

    it('handles short strips that fit within viewport at scale 1 or larger', () => {
      const items = [{ naturalHeight: 300, naturalWidth: 400 }, { naturalHeight: 300, naturalWidth: 400 }];
      const rawSumH = 600;
      const vh = 800;
      const scale = computeStripFitScale({
        fitMode: 'height',
        vw: 1000,
        vh,
        maxW: 400,
        rawSumH,
        itemCount: items.length,
      });

      assert.ok(scale > 1);
      const seam = seamOverlapForScale(scale);
      const layout = computeColumnOffsets(items, 1, seam);
      const visualH = layout.totalHeight * scale;
      assert.ok(Math.abs(visualH - vh) < 1e-9);
    });

    it('handles window and window-if-larger correctly', () => {
      const scaleWindow = computeStripFitScale({
        fitMode: 'window',
        vw: 600,
        vh: 800,
        maxW: 800,
        rawSumH: 6000,
        itemCount: 6,
      });
      assert.equal(scaleWindow, (800 + 5) / 6000);
    });
  });
});

