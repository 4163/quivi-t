import assert from 'node:assert/strict';
import { ACTION_REGISTRY, dispatch } from '../src/js/services/actions.js';
import { UrlLoader, isValidUrl, findExtractor, extractGallery, MAX_PAGINATION_PAGES } from '../src/js/urlLoader.js';

const MOCK_MANIFEST = {
  version: 1,
  extractors: [
    { id: 'imgur', name: 'Imgur', patterns: ['^https?://(www\\.)?imgur\\.com/(a|gallery)/'], source: 'imgur.js' },
    { id: 'danbooru', name: 'Danbooru', patterns: ['^https?://(www\\.)?danbooru\\.donmai\\.us/posts'], source: 'danbooru.js' }
  ]
};

function mockExtractor(overrides = {}) {
  return {
    match: () => true,
    extract: () => ({
      provider: 'test',
      title: 'Test Gallery',
      images: [{ url: 'https://example.com/1.jpg', filename: '001.jpg', displayName: 'Image 1' }],
      nextPageUrl: null,
      ...overrides
    })
  };
}

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
  });

  describe('manifest matching', () => {
    it('returns matching entry for known URL patterns', () => {
      const entry = findExtractor('https://imgur.com/a/abc123', MOCK_MANIFEST);
      assert.ok(entry);
      assert.equal(entry.id, 'imgur');
    });

    it('matches gallery-style imgur URLs', () => {
      const entry = findExtractor('https://www.imgur.com/gallery/xyz789', MOCK_MANIFEST);
      assert.ok(entry);
      assert.equal(entry.id, 'imgur');
    });

    it('matches danbooru URLs', () => {
      const entry = findExtractor('https://danbooru.donmai.us/posts?tags=landscape', MOCK_MANIFEST);
      assert.ok(entry);
      assert.equal(entry.id, 'danbooru');
    });

    it('returns null for unmatched URLs', () => {
      const entry = findExtractor('https://example.com/gallery', MOCK_MANIFEST);
      assert.equal(entry, null);
    });

    it('picks the first match when multiple extractors could match', () => {
      const manifest = {
        version: 1,
        extractors: [
          { id: 'first', patterns: ['^https?://example\\.com/'], source: 'first.js' },
          { id: 'second', patterns: ['^https?://example\\.com/gallery'], source: 'second.js' }
        ]
      };
      const entry = findExtractor('https://example.com/gallery/1', manifest);
      assert.equal(entry.id, 'first');
    });

    it('skips entries with invalid regex patterns', () => {
      const manifest = {
        version: 1,
        extractors: [
          { id: 'broken', patterns: ['[invalid(regex'], source: 'broken.js' },
          { id: 'valid', patterns: ['^https?://valid\\.com/'], source: 'valid.js' }
        ]
      };
      const entry = findExtractor('https://valid.com/page', manifest);
      assert.equal(entry.id, 'valid');
    });

    it('returns null for null or empty manifest', () => {
      assert.equal(findExtractor('https://example.com/', null), null);
      assert.equal(findExtractor('https://example.com/', {}), null);
      assert.equal(findExtractor('https://example.com/', { extractors: [] }), null);
    });
  });

  describe('extraction result validation', () => {
    it('returns valid result from a well-formed extractor', () => {
      const ext = mockExtractor();
      const result = extractGallery(ext, '<html></html>', 'https://example.com/');
      assert.equal(result.provider, 'test');
      assert.equal(result.title, 'Test Gallery');
      assert.ok(Array.isArray(result.images));
      assert.equal(result.images.length, 1);
    });

    it('throws when provider is missing', () => {
      const ext = mockExtractor({ provider: undefined });
      // extract returns an object without provider
      const badExt = { match: () => true, extract: () => ({ images: [] }) };
      assert.throws(() => extractGallery(badExt, '', ''), /missing 'provider'/);
    });

    it('throws when images is missing', () => {
      const badExt = { match: () => true, extract: () => ({ provider: 'test' }) };
      assert.throws(() => extractGallery(badExt, '', ''), /'images' must be an array/);
    });

    it('throws when images is not an array', () => {
      const badExt = { match: () => true, extract: () => ({ provider: 'test', images: 'not-array' }) };
      assert.throws(() => extractGallery(badExt, '', ''), /'images' must be an array/);
    });

    it('accepts an extractor that returns zero images', () => {
      const ext = mockExtractor({ images: [] });
      const emptyExt = { match: () => true, extract: () => ({ provider: 'test', title: 'Empty', images: [], nextPageUrl: null }) };
      const result = extractGallery(emptyExt, '', '');
      assert.equal(result.images.length, 0);
    });
  });

  describe('pagination safety', () => {
    it('MAX_PAGINATION_PAGES is a positive integer', () => {
      assert.ok(Number.isInteger(MAX_PAGINATION_PAGES));
      assert.ok(MAX_PAGINATION_PAGES > 0);
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
