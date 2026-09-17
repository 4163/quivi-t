import assert from 'node:assert/strict';
import { ACTION_REGISTRY, dispatch } from '../src/js/services/actions.js';
import { UrlLoader, isValidUrl, loadUrl } from '../src/js/urlLoader.js';

describe('UrlLoader and cmd-use-url', () => {
  describe('action registration', () => {
    it('registers cmd-use-url in ACTION_REGISTRY', () => {
      const action = ACTION_REGISTRY.find(a => a.id === 'cmd-use-url');
      assert.ok(action, 'cmd-use-url should be registered');
      assert.equal(action.label, 'Open URL...');
      assert.equal(action.category, 'File Operations');
      assert.deepEqual(action.defaultBinds, 'Ctrl+u');
    });

    it('dispatches cmd-use-url to ctx.UrlLoader.openPrompt', () => {
      let promptOpened = false;
      const ctx = {
        UrlLoader: {
          openPrompt: () => {
            promptOpened = true;
          }
        }
      };

      dispatch('cmd-use-url', null, ctx);
      assert.equal(promptOpened, true);
    });
  });

  describe('URL validation', () => {
    it('validates HTTP and HTTPS URLs', () => {
      assert.equal(isValidUrl('https://example.com/gallery/1'), true);
      assert.equal(isValidUrl('http://example.com/image.jpg'), true);
      assert.equal(isValidUrl('https://sub.domain.org/path?a=1&b=2'), true);
    });

    it('rejects invalid or non-HTTP URLs', () => {
      assert.equal(isValidUrl(''), false);
      assert.equal(isValidUrl('   '), false);
      assert.equal(isValidUrl(null), false);
      assert.equal(isValidUrl(undefined), false);
      assert.equal(isValidUrl('ftp://example.com/file'), false);
      assert.equal(isValidUrl('file:///C:/test.png'), false);
      assert.equal(isValidUrl('not a url'), false);
    });

    it('loadUrl rejects invalid URLs with an informative error', async () => {
      await assert.rejects(
        async () => loadUrl('invalid-url'),
        /valid HTTP or HTTPS URL/
      );
    });

    it('loadUrl accepts valid URLs', async () => {
      const res = await loadUrl('https://example.com/gallery/42');
      assert.deepEqual(res, { url: 'https://example.com/gallery/42' });
    });
  });

  describe('UrlLoader service lifecycle', () => {
    it('delegates openPrompt to overlay show()', () => {
      let shown = false;
      const mockOverlay = {
        show: () => { shown = true; }
      };

      UrlLoader.init({
        Core: {},
        FsUtils: {},
        urlOverlay: mockOverlay
      });

      UrlLoader.openPrompt();
      assert.equal(shown, true);
    });
  });
});
