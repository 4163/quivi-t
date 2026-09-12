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

const { BoundedMap } = await import('../services/cache.js');

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

test('BoundedMap: onEvict callback fires on capacity eviction', () => {
  const evicted = [];
  const map = new BoundedMap(2, (k, v) => evicted.push({ k, v }));
  map.set('a', 'alpha');
  map.set('b', 'beta');
  assert.equal(evicted.length, 0);

  map.set('c', 'gamma');
  assert.equal(evicted.length, 1);
  assert.deepEqual(evicted[0], { k: 'a', v: 'alpha' });
});

test('BoundedMap: onEvict callback fires on delete()', () => {
  const evicted = [];
  const map = new BoundedMap(3, (k, v) => evicted.push({ k, v }));
  map.set('a', 100);
  map.set('b', 200);

  const deleted = map.delete('a');
  assert.equal(deleted, true);
  assert.equal(evicted.length, 1);
  assert.deepEqual(evicted[0], { k: 'a', v: 100 });

  // Delete missing key should not invoke onEvict
  const deletedMissing = map.delete('nonexistent');
  assert.equal(deletedMissing, false);
  assert.equal(evicted.length, 1);
});

test('BoundedMap: onEvict callback fires on clear()', () => {
  const evicted = [];
  const map = new BoundedMap(3, (k, v) => evicted.push({ k, v }));
  map.set('a', 1);
  map.set('b', 2);
  map.set('c', 3);

  map.clear();
  assert.equal(map.size, 0);
  assert.equal(evicted.length, 3);
  assert.deepEqual(evicted, [
    { k: 'a', v: 1 },
    { k: 'b', v: 2 },
    { k: 'c', v: 3 },
  ]);
});

test('BoundedMap: onEvict callback fires when replacing value for existing key', () => {
  const evicted = [];
  const map = new BoundedMap(3, (k, v) => evicted.push({ k, v }));
  map.set('a', 'old');
  map.set('a', 'new');
  assert.equal(evicted.length, 1);
  assert.deepEqual(evicted[0], { k: 'a', v: 'old' });

  // Setting the same value again should not trigger eviction
  map.set('a', 'new');
  assert.equal(evicted.length, 1);
});
