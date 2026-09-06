/**
 * cache.js: reusable cache primitives.
 */

export class BoundedMap extends Map {
  constructor(maxSize = 50) {
    super();
    this.maxSize = maxSize;
  }

  set(key, value) {
    if (this.size >= this.maxSize && !this.has(key)) {
      const oldestKey = this.keys().next().value;
      this.delete(oldestKey);
    }
    return super.set(key, value);
  }
}
