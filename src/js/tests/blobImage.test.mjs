import test from 'node:test';
import assert from 'node:assert/strict';

const {
  TEXTURE_CACHE_CAPACITY,
  getCleanImage,
  getCleanImageCrop,
} = await import('../shared/blobImage.js');

test('Blob image cache: keeps only one full clean image', async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const closed = [];
  let created = 0;

  globalThis.fetch = async () => ({
    blob: async () => new Blob([new Uint8Array(4)]),
  });
  globalThis.createImageBitmap = async () => {
    const bitmap = {
      id: ++created,
      width: 100,
      height: 200,
      close() { closed.push(this.id); },
    };
    return bitmap;
  };

  try {
    assert.equal(TEXTURE_CACHE_CAPACITY, 1);

    const first = await getCleanImage('asset://first.jpg');
    const same = await getCleanImage('asset://first.jpg');
    assert.equal(same, first, 'same source reuses the cached bitmap');

    const second = await getCleanImage('asset://second.jpg');
    assert.notEqual(second, first, 'new source creates a new bitmap');
    assert.deepEqual(closed, [1], 'capacity eviction closes the previous bitmap');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});

test('Blob image crop: returns caller-owned cropped bitmap without filling the full-image cache', async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const calls = [];
  const closed = [];
  let created = 0;

  globalThis.fetch = async () => ({
    blob: async () => new Blob([new Uint8Array(4)]),
  });
  globalThis.createImageBitmap = async (_blob, sx, sy, sw, sh) => {
    calls.push({ sx, sy, sw, sh });
    return {
      id: ++created,
      width: sw,
      height: sh,
      close() { closed.push(this.id); },
    };
  };

  try {
    const crop = await getCleanImageCrop('asset://large-page.jpg', 10, 20, 300, 400);

    assert.deepEqual(calls, [{ sx: 10, sy: 20, sw: 300, sh: 400 }]);
    assert.equal(crop.width, 300);
    assert.equal(crop.height, 400);

    crop.close();
    assert.deepEqual(closed, [1], 'crop bitmap ownership stays with the caller');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});
