/**
 * cache.js: reusable cache primitives.
 */

export class BoundedMap extends Map {
  constructor(maxSize = 50, onEvict = null) {
    super();
    this.maxSize = maxSize;
    this._onEvict = onEvict;
  }

  set(key, value) {
    if (this.has(key)) {
      if (this._onEvict) {
        const prev = this.get(key);
        if (prev !== value) this._onEvict(key, prev);
      }
    } else if (this.size >= this.maxSize) {
      const oldestKey = this.keys().next().value;
      this.delete(oldestKey);
    }
    return super.set(key, value);
  }

  delete(key) {
    if (this._onEvict && this.has(key)) this._onEvict(key, this.get(key));
    return super.delete(key);
  }

  clear() {
    if (this._onEvict) {
      for (const [key, value] of this) this._onEvict(key, value);
    }
    super.clear();
  }
}

export class BoundedSet extends Set {
  constructor(maxSize = 50) {
    super();
    this.maxSize = maxSize;
  }

  add(value) {
    if (!this.has(value) && this.size >= this.maxSize) {
      const oldestValue = this.keys().next().value;
      this.delete(oldestValue);
    }
    return super.add(value);
  }
}
