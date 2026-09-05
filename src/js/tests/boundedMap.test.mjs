import test from 'node:test';
import assert from 'node:assert/strict';

// Mock browser globals required for Node test environment
if (typeof window === 'undefined') {
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async () => ({}),
        convertFileSrc: (p) => p
      }
    },
    dispatchEvent: () => {}
  };
}

const { BoundedMap } = await import('../fsUtils.js');

test('BoundedMap: basic store and retrieval', () => {
  const map = new BoundedMap(3);
  map.set('a', 1);
  map.set('b', 2);
  assert.equal(map.get('a'), 1);
  assert.equal(map.get('b'), 2);
  assert.equal(map.size, 2);
});

test('BoundedMap: evicts oldest key when exceeding maxSize', () => {
  const map = new BoundedMap(3);
  map.set('a', 1);
  map.set('b', 2);
  map.set('c', 3);
  assert.equal(map.size, 3);
  assert.equal(map.has('a'), true);

  // Inserting 4th item evicts 'a'
  map.set('d', 4);
  assert.equal(map.size, 3);
  assert.equal(map.has('a'), false);
  assert.equal(map.get('b'), 2);
  assert.equal(map.get('c'), 3);
  assert.equal(map.get('d'), 4);
});

test('BoundedMap: updating existing key does not evict', () => {
  const map = new BoundedMap(2);
  map.set('a', 1);
  map.set('b', 2);
  map.set('a', 10);
  assert.equal(map.size, 2);
  assert.equal(map.get('a'), 10);
  assert.equal(map.get('b'), 2);
});
