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
  });
});
