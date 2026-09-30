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

    it('binds mute to m and manhwa to Ctrl+m with no default conflicts', () => {
      const byId = Object.fromEntries(ACTION_REGISTRY.map((a) => [a.id, a]));
      const asArray = (binds) => Array.isArray(binds) ? binds : [binds];
      assert.deepEqual(asArray(byId['cmd-toggle-audio'].defaultBinds), ['m']);
      assert.deepEqual(asArray(byId['cmd-toggle-manhwa'].defaultBinds), ['Ctrl+m']);

      const seen = new Map();
      for (const action of ACTION_REGISTRY) {
        const binds = Array.isArray(action.defaultBinds) ? action.defaultBinds : [action.defaultBinds];
        for (const bind of binds) {
          const norm = normalizeCombo(bind);
          assert.ok(!seen.has(norm), `Default bind conflict: ${norm} on ${action.id} and ${seen.get(norm)}`);
          seen.set(norm, action.id);
        }
      }
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

    it('routes audio toggle to the strip coordinator when manhwa is active', async () => {
      let stripAnchor = null;
      let legacyMuted = false;
      const fakeCtx = {
        Core: { getState: () => ({ manhwaEnabled: true }) },
        getStripAnchorImgIdx: () => 4,
        ManhwaAudio: { toggleStripMute: (anchor) => { stripAnchor = anchor; } },
        ViewerAudio: { toggleAudioMute: () => { legacyMuted = true; } }
      };

      await dispatch('cmd-toggle-audio', null, fakeCtx);
      assert.equal(stripAnchor, 4);
      assert.equal(legacyMuted, false);

      fakeCtx.Core = { getState: () => ({ manhwaEnabled: false }) };
      await dispatch('cmd-toggle-audio', null, fakeCtx);
      assert.equal(legacyMuted, true);
    });

    it('routes navigation to navigateManhwa and pan/zoom to Viewer when manhwa is active', async () => {
      let manhwaNavDelta = 0;
      let coreNavigated = 0;
      let panCalls = [];
      let zoomCalls = [];
      let rotateCalled = false;
      let flipCalls = [];

      const fakeCtx = {
        Core: {
          getState: () => ({ manhwaEnabled: true }),
          navigate: (d) => { coreNavigated += d; }
        },
        keyboardPanStep: 72,
        navigateManhwa: (delta) => { manhwaNavDelta += delta; },
        Viewer: {
          panBy: (dx, dy) => { panCalls.push({ dx, dy }); },
          zoomAt: (d, x, y) => { zoomCalls.push({ d, x, y }); },
          zoomCenter: (d) => { zoomCalls.push({ d }); },
          setZoom: (z) => { zoomCalls.push({ z }); },
          rotate: () => { rotateCalled = true; },
          flipHorizontal: () => { flipCalls.push('x'); },
          flipVertical: () => { flipCalls.push('y'); }
        }
      };

      let pageStripDelta = 0;
      fakeCtx.pageStrip = (dir) => { pageStripDelta += dir; };

      // cmd-next / cmd-prev page the strip like PageDown / PageUp
      await dispatch('cmd-next', null, fakeCtx);
      assert.equal(pageStripDelta, 1);

      await dispatch('cmd-prev', null, fakeCtx);
      assert.equal(pageStripDelta, 0);

      // Fallback with navigateManhwa
      delete fakeCtx.pageStrip;
      await dispatch('cmd-next', null, fakeCtx);
      assert.equal(manhwaNavDelta, 1);

      await dispatch('cmd-prev', null, fakeCtx);
      assert.equal(manhwaNavDelta, 0);

      // Fallback without navigateManhwa calls Core.navigate and centerListItem / alignListItemTop
      delete fakeCtx.navigateManhwa;
      let centeredIdx = -1;
      fakeCtx.centerListItem = (idx) => { centeredIdx = idx; };
      fakeCtx.Core.getState = () => ({ manhwaEnabled: true, index: 3 });
      await dispatch('cmd-next', null, fakeCtx);
      assert.equal(coreNavigated, 1);
      assert.equal(centeredIdx, 3);

      let alignedIdx = -1;
      fakeCtx.alignListItemTop = (idx) => { alignedIdx = idx; };
      await dispatch('cmd-next', null, fakeCtx);
      assert.equal(alignedIdx, 3);

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

      // Rotation is guarded, but flips are unforwarded in manhwa mode
      await dispatch('cmd-rotate-ccw', null, fakeCtx);
      await dispatch('cmd-rotate-cw', null, fakeCtx);
      assert.equal(rotateCalled, false);

      await dispatch('cmd-flip-horizontal', null, fakeCtx);
      await dispatch('cmd-flip-vertical', null, fakeCtx);
      assert.deepEqual(flipCalls, ['x', 'y']);

      // Fit modes work in manhwa mode; lanczos and filters remain guarded
      let fitCalled = [];
      let filterCalled = false;
      let scalingSet = null;
      fakeCtx.Core.setFitMode = (m) => { fitCalled.push(m); };
      fakeCtx.Core.setActiveFilter = () => { filterCalled = true; };
      fakeCtx.Core.setScalingMode = (m) => { scalingSet = m; };

      await dispatch('cmd-fit-width', null, fakeCtx);
      await dispatch('cmd-fit-none', null, fakeCtx);
      assert.deepEqual(fitCalled, ['width', 'none']);

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
