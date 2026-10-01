import assert from 'node:assert/strict';
import {
  TextureCache,
  createTextureCache,
  computeTextureBytes,
  DEFAULT_TEXTURE_CACHE_BYTES,
} from '../src/js/services/pipelines/textureCache.js';

describe('TextureCache pipeline module', () => {
  function createMockGl() {
    let nextTexId = 1;
    const deletedTextures = [];
    return {
      deletedTextures,
      createTexture() {
        return { id: nextTexId++ };
      },
      deleteTexture(tex) {
        deletedTextures.push(tex);
      },
      bindTexture() {},
      texParameteri() {},
      texImage2D() {},
    };
  }

  describe('computeTextureBytes', () => {
    it('calculates width * height * 4 for standard resolutions', () => {
      // 100 x 200 RGBA
      assert.equal(computeTextureBytes(100, 200), 80000);
      // 1080p: 1920 x 1080 * 4 = 8,294,400 bytes (~8.3 MB)
      assert.equal(computeTextureBytes(1920, 1080), 8294400);
      // 4K: 3840 x 2160 * 4 = 33,177,600 bytes (~33.2 MB)
      assert.equal(computeTextureBytes(3840, 2160), 33177600);
    });

    it('rounds fractional dimensions and handles zeroes or negatives', () => {
      assert.equal(computeTextureBytes(10.4, 20.6), 10 * 21 * 4);
      assert.equal(computeTextureBytes(0, 500), 0);
      assert.equal(computeTextureBytes(-100, 200), 0);
      assert.equal(computeTextureBytes(null, undefined), 0);
    });
  });

  describe('TextureCache construction and default limits', () => {
    it('initializes with default budget of 128 MB', () => {
      const cache = new TextureCache();
      assert.equal(cache.maxBytes, DEFAULT_TEXTURE_CACHE_BYTES);
      assert.equal(cache.maxBytes, 128 * 1024 * 1024);
      assert.equal(cache.size, 0);
      assert.equal(cache.totalBytes, 0);
    });

    it('accepts custom maxBytes and factory function', () => {
      const gl = createMockGl();
      const cache = createTextureCache(gl, { maxBytes: 10000 });
      assert.equal(cache.maxBytes, 10000);
      assert.equal(cache.gl, gl);
    });
  });

  describe('LRU eviction and byte budget accounting', () => {
    it('tracks totalBytes accurately on insertions and updates', () => {
      const gl = createMockGl();
      const cache = new TextureCache(gl, { maxBytes: 100000 });

      const tex1 = gl.createTexture();
      const tex2 = gl.createTexture();

      // 50 x 50 * 4 = 10,000 bytes
      cache.put('page-1', tex1, 50, 50);
      assert.equal(cache.size, 1);
      assert.equal(cache.totalBytes, 10000);
      assert.equal(cache.has('page-1'), true);

      // 100 x 50 * 4 = 20,000 bytes
      cache.put('page-2', tex2, 100, 50);
      assert.equal(cache.size, 2);
      assert.equal(cache.totalBytes, 30000);

      // Replace page-1 with 50 x 100 * 4 = 20,000 bytes
      const tex3 = gl.createTexture();
      cache.put('page-1', tex3, 50, 100);
      assert.equal(cache.size, 2);
      assert.equal(cache.totalBytes, 40000);
      // Previous tex1 should have been deleted
      assert.equal(gl.deletedTextures.length, 1);
      assert.equal(gl.deletedTextures[0], tex1);
    });

    it('evicts least recently used items when budget is exceeded', () => {
      const gl = createMockGl();
      const evictedList = [];
      // Budget: 35,000 bytes. Each item is 50x50 = 10,000 bytes.
      const cache = new TextureCache(gl, {
        maxBytes: 35000,
        onEvict: (k, e) => evictedList.push({ k, tex: e.texture }),
      });

      const t1 = gl.createTexture();
      const t2 = gl.createTexture();
      const t3 = gl.createTexture();
      const t4 = gl.createTexture();

      cache.put('p1', t1, 50, 50); // 10k
      cache.put('p2', t2, 50, 50); // 20k
      cache.put('p3', t3, 50, 50); // 30k
      assert.equal(cache.size, 3);
      assert.equal(cache.totalBytes, 30000);
      assert.equal(evictedList.length, 0);

      // Inserting 4th item (10k) requires 40k > 35k.
      // Oldest is 'p1', so 'p1' must be evicted.
      cache.put('p4', t4, 50, 50);
      assert.equal(cache.size, 3);
      assert.equal(cache.totalBytes, 30000);
      assert.equal(cache.has('p1'), false);
      assert.equal(cache.has('p2'), true);
      assert.equal(cache.has('p3'), true);
      assert.equal(cache.has('p4'), true);

      assert.equal(gl.deletedTextures.length, 1);
      assert.equal(gl.deletedTextures[0], t1);
      assert.equal(evictedList.length, 1);
      assert.equal(evictedList[0].k, 'p1');
    });

    it('get() refreshes LRU priority so accessed entry survives eviction', () => {
      const gl = createMockGl();
      const cache = new TextureCache(gl, { maxBytes: 25000 }); // Holds two 10k items

      const t1 = gl.createTexture();
      const t2 = gl.createTexture();
      const t3 = gl.createTexture();

      cache.put('p1', t1, 50, 50); // 10k
      cache.put('p2', t2, 50, 50); // 20k

      // Touch p1, so p2 becomes the oldest entry
      const entry = cache.get('p1');
      assert.equal(entry.texture, t1);

      // Insert p3 (10k) -> exceeds 25k -> should evict p2!
      cache.put('p3', t3, 50, 50);
      assert.equal(cache.has('p1'), true);
      assert.equal(cache.has('p2'), false);
      assert.equal(cache.has('p3'), true);
      assert.equal(gl.deletedTextures.length, 1);
      assert.equal(gl.deletedTextures[0], t2);
    });

    it('getTexture returns texture reference or null on miss', () => {
      const gl = createMockGl();
      const cache = new TextureCache(gl);
      const t = gl.createTexture();
      cache.put('test', t, 10, 10);

      assert.equal(cache.getTexture('test'), t);
      assert.equal(cache.getTexture('nonexistent'), null);
    });
  });

  describe('getOrCreate asynchronous loading and deduplication', () => {
    it('loads missing item, uploads texture, and closes source bitmap', async () => {
      const gl = createMockGl();
      const cache = new TextureCache(gl, { maxBytes: 100000 });

      let closed = false;
      const mockLoader = async (_src) => ({
        width: 100,
        height: 100,
        close() { closed = true; },
      });

      const entry = await cache.getOrCreate('img1', mockLoader);
      assert.ok(entry);
      assert.equal(entry.width, 100);
      assert.equal(entry.height, 100);
      assert.equal(entry.bytes, 40000);
      assert.equal(cache.totalBytes, 40000);
      assert.equal(closed, true, 'ImageBitmap.close() must be called immediately');

      // Calling again returns cached entry without invoking loader
      let secondCalled = false;
      const secondEntry = await cache.getOrCreate('img1', async () => {
        secondCalled = true;
      });
      assert.equal(secondCalled, false);
      assert.equal(secondEntry, entry);
    });

    it('deduplicates concurrent in-flight requests for the same source', async () => {
      const gl = createMockGl();
      const cache = new TextureCache(gl);

      let loadCount = 0;
      const slowLoader = async (src) => {
        loadCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { width: 50, height: 50, close() {} };
      };

      const [res1, res2, res3] = await Promise.all([
        cache.getOrCreate('shared-src', slowLoader),
        cache.getOrCreate('shared-src', slowLoader),
        cache.getOrCreate('shared-src', slowLoader),
      ]);

      assert.equal(loadCount, 1, 'Loader must only be called once');
      assert.equal(res1, res2);
      assert.equal(res2, res3);
    });

    it('returns null and releases resources on invalid image dimensions', async () => {
      const gl = createMockGl();
      const cache = new TextureCache(gl);

      let closed = false;
      const invalidLoader = async () => ({
        width: 0,
        height: 0,
        close() { closed = true; },
      });

      const res = await cache.getOrCreate('zero-size', invalidLoader);
      assert.equal(res, null);
      assert.equal(closed, true);
      assert.equal(cache.size, 0);
    });
  });

  describe('delete, clear, and dispose', () => {
    it('delete removes entry, releases GL texture, and decreases totalBytes', () => {
      const gl = createMockGl();
      const cache = new TextureCache(gl);
      const t = gl.createTexture();
      cache.put('a', t, 10, 10); // 400 bytes

      assert.equal(cache.totalBytes, 400);
      const deleted = cache.delete('a');
      assert.equal(deleted, true);
      assert.equal(cache.totalBytes, 0);
      assert.equal(cache.size, 0);
      assert.equal(gl.deletedTextures.length, 1);
      assert.equal(gl.deletedTextures[0], t);

      assert.equal(cache.delete('nonexistent'), false);
    });

    it('clear removes all entries and resets byte accounting', () => {
      const gl = createMockGl();
      const cache = new TextureCache(gl);
      const t1 = gl.createTexture();
      const t2 = gl.createTexture();

      cache.put('a', t1, 20, 20); // 1600
      cache.put('b', t2, 30, 30); // 3600
      assert.equal(cache.totalBytes, 5200);

      cache.clear();
      assert.equal(cache.totalBytes, 0);
      assert.equal(cache.size, 0);
      assert.equal(gl.deletedTextures.length, 2);
    });

    it('dispose clears entries and detaches context', () => {
      const gl = createMockGl();
      const cache = new TextureCache(gl);
      cache.put('a', gl.createTexture(), 10, 10);
      cache.dispose();

      assert.equal(cache.size, 0);
      assert.equal(cache.gl, null);
    });
  });
});
