import assert from 'node:assert/strict';
import {
  ACTION_REGISTRY,
  CATEGORIES,
  DEFAULT_KEYBINDS,
  dispatch
} from '../src/js/services/actions.js';
import { normalizeCombo } from '../src/js/services/keyCombo.js';

describe('Actions registry and keybindings', () => {
  describe('ACTION_REGISTRY integrity', () => {
    it('contains unique actions with required properties', () => {
      assert.ok(Array.isArray(ACTION_REGISTRY));
      assert.ok(ACTION_REGISTRY.length > 20);

      const seenIds = new Set();

      for (const action of ACTION_REGISTRY) {
        assert.ok(typeof action.id === 'string' && action.id.startsWith('cmd-'), `Invalid action id: ${action.id}`);
        assert.ok(!seenIds.has(action.id), `Duplicate action id detected: ${action.id}`);
        seenIds.add(action.id);

        assert.ok(typeof action.label === 'string' && action.label.length > 0, `Missing label for ${action.id}`);
        if (action.category) {
          assert.ok(typeof action.category === 'string' && action.category.length > 0);
        }
        assert.ok(typeof action.run === 'function', `Missing run function for ${action.id}`);
      }
    });

    it('contains all expected core command categories', () => {
      const categoryNames = CATEGORIES.map(c => c.name);
      assert.ok(categoryNames.includes('Navigation'));
      assert.ok(categoryNames.includes('View'));
      assert.ok(categoryNames.includes('Zoom'));
      assert.ok(categoryNames.includes('Pan'));
      assert.ok(categoryNames.includes('Rotation'));
      assert.ok(categoryNames.includes('Window & UI'));
      assert.ok(categoryNames.includes('File Operations'));
    });
  });

  describe('default keybinding mappings', () => {
    it('maps registered actions to valid key combo strings', () => {
      assert.ok(typeof DEFAULT_KEYBINDS === 'object');

      for (const [actionId, binds] of Object.entries(DEFAULT_KEYBINDS)) {
        assert.ok(Array.isArray(binds), `Keybinds for ${actionId} must be an array`);
        for (const bind of binds) {
          assert.ok(typeof bind === 'string');
          const normalized = normalizeCombo(bind);
          assert.ok(typeof normalized === 'string' && normalized.length > 0);
        }
      }
    });

    it('normalizes key combos according to keyCombo rules', () => {
      assert.equal(normalizeCombo('shift+ctrl+a'), 'Shift+Ctrl+a');
      assert.equal(normalizeCombo('alt+ctrl+z'), 'Alt+Ctrl+z');
      assert.equal(normalizeCombo('shift+arrowleft'), 'Shift+ArrowLeft');
      assert.equal(normalizeCombo('doubleclick'), 'DoubleClick');
      assert.equal(normalizeCombo('mouseback'), 'MouseBack');
      assert.equal(normalizeCombo('mouseforward'), 'MouseForward');
    });
  });

  describe('dispatch function', () => {
    it('dispatches registered actions to context handlers', async () => {
      let fitModeSet = null;
      const fakeCtx = {
        Core: {
          setFitMode: (mode) => {
            fitModeSet = mode;
          }
        }
      };

      await dispatch('cmd-fit-width', null, fakeCtx);
      assert.equal(fitModeSet, 'width');

      await dispatch('cmd-fit-height', null, fakeCtx);
      assert.equal(fitModeSet, 'height');
    });

    it('gracefully ignores unknown action IDs without throwing', async () => {
      await assert.doesNotReject(async () => {
        await dispatch('cmd-nonexistent-action-id', null, {});
      });
    });

    it('routes navigation to stepAnchor and pan/zoom to Viewer when manhwa is active', async () => {
      let steppedDelta = 0;
      let coreNavigated = 0;
      let panCalls = [];
      let zoomCalls = [];
      let rotateCalled = false;

      const fakeCtx = {
        Core: {
          getState: () => ({ manhwaEnabled: true }),
          navigate: (d) => { coreNavigated += d; }
        },
        keyboardPanStep: 72,
        stepAnchor: (delta) => { steppedDelta += delta; },
        Viewer: {
          panBy: (dx, dy) => { panCalls.push({ dx, dy }); },
          zoomAt: (d, x, y) => { zoomCalls.push({ d, x, y }); },
          zoomCenter: (d) => { zoomCalls.push({ d }); },
          setZoom: (z) => { zoomCalls.push({ z }); },
          rotate: () => { rotateCalled = true; },
          flipHorizontal: () => { rotateCalled = true; },
          flipVertical: () => { rotateCalled = true; }
        }
      };

      // cmd-next / cmd-prev jump one image in strip
      await dispatch('cmd-next', null, fakeCtx);
      assert.equal(steppedDelta, 1);
      assert.equal(coreNavigated, 0);

      await dispatch('cmd-prev', null, fakeCtx);
      assert.equal(steppedDelta, 0);
      assert.equal(coreNavigated, 0);

      // Pan keys move pixels via Viewer.panBy
      await dispatch('cmd-pan-up', null, fakeCtx);
      await dispatch('cmd-pan-down', null, fakeCtx);
      await dispatch('cmd-pan-left', null, fakeCtx);
      await dispatch('cmd-pan-right', null, fakeCtx);
      assert.equal(panCalls.length, 4);
      assert.deepEqual(panCalls[0], { dx: 0, dy: 72 });
      assert.deepEqual(panCalls[1], { dx: 0, dy: -72 });
      assert.deepEqual(panCalls[2], { dx: 72, dy: 0 });
      assert.deepEqual(panCalls[3], { dx: -72, dy: 0 });

      // Zoom keys call Viewer zoom
      await dispatch('cmd-zoom-in', null, fakeCtx);
      await dispatch('cmd-zoom-out', null, fakeCtx);
      await dispatch('cmd-zoom-100', null, fakeCtx);
      assert.equal(zoomCalls.length, 3);

      // Rotation and flip are guarded in manhwa mode
      await dispatch('cmd-rotate-ccw', null, fakeCtx);
      await dispatch('cmd-rotate-cw', null, fakeCtx);
      await dispatch('cmd-flip-horizontal', null, fakeCtx);
      await dispatch('cmd-flip-vertical', null, fakeCtx);
      assert.equal(rotateCalled, false);

      // Fit modes, lanczos, and filters are guarded in manhwa mode
      let fitCalled = false;
      let filterCalled = false;
      let scalingSet = null;
      fakeCtx.Core.setFitMode = () => { fitCalled = true; };
      fakeCtx.Core.setActiveFilter = () => { filterCalled = true; };
      fakeCtx.Core.setScalingMode = (m) => { scalingSet = m; };

      await dispatch('cmd-fit-width', null, fakeCtx);
      await dispatch('cmd-fit-none', null, fakeCtx);
      assert.equal(fitCalled, false);

      await dispatch('cmd-filter-off', null, fakeCtx);
      await dispatch('cmd-toggle-anime4k-filter', null, fakeCtx);
      assert.equal(filterCalled, false);

      await dispatch('cmd-scale-lanczos', null, fakeCtx);
      assert.equal(scalingSet, null);

      fakeCtx.Core.getState = () => ({ manhwaEnabled: true, scalingMode: 'bilinear' });
      await dispatch('cmd-cycle-scaling', null, fakeCtx);
      assert.equal(scalingSet, 'none');

      fakeCtx.Core.getState = () => ({ manhwaEnabled: true, scalingMode: 'none' });
      await dispatch('cmd-cycle-scaling', null, fakeCtx);
      assert.equal(scalingSet, 'bilinear');
    });

    it('routes to standard handlers when manhwa is inactive', async () => {
      let coreNavigated = 0;
      let panByDeltas = [];

      const fakeCtx = {
        Core: {
          getState: () => ({ manhwaEnabled: false }),
          navigate: (d) => { coreNavigated += d; }
        },
        keyboardPanStep: 50,
        Viewer: {
          panBy: (dx, dy) => { panByDeltas.push({ dx, dy }); }
        }
      };

      await dispatch('cmd-next', null, fakeCtx);
      assert.equal(coreNavigated, 1);

      await dispatch('cmd-prev', null, fakeCtx);
      assert.equal(coreNavigated, 0);

      await dispatch('cmd-pan-up', null, fakeCtx);
      assert.deepEqual(panByDeltas.pop(), { dx: 0, dy: 50 });

      await dispatch('cmd-pan-down', null, fakeCtx);
      assert.deepEqual(panByDeltas.pop(), { dx: 0, dy: -50 });
    });
  });
});
