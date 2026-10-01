/**
 * textureCache.js: LRU texture pool bounded by VRAM byte budgeting.
 *
 * Each entry tracks width, height, bytes (width * height * 4), and the WebGLTexture.
 * When totalBytes exceeds maxBytes, least-recently-used textures are deleted via
 * gl.deleteTexture() and evicted from the pool.
 */

export const DEFAULT_TEXTURE_CACHE_BYTES = 128 * 1024 * 1024; // 128 MB

/**
 * Computes memory consumption in bytes for an RGBA8 texture.
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function computeTextureBytes(width, height) {
  const w = Math.max(0, Math.round(width || 0));
  const h = Math.max(0, Math.round(height || 0));
  return w * h * 4;
}

/**
 * Allocates and uploads an image or bitmap to a WebGLTexture with linear filtering.
 * @param {WebGL2RenderingContext|WebGLRenderingContext} gl
 * @param {TexImageSource} imageSource
 * @returns {WebGLTexture|null}
 */
export function uploadTexture(gl, imageSource) {
  if (!gl) return null;
  const tex = gl.createTexture();
  if (!tex) return null;

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageSource);
  return tex;
}

async function defaultImageLoader(src) {
  if (typeof globalThis.fetch !== 'function' || typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('ImageBitmap loader not supported in current environment');
  }
  const resp = await globalThis.fetch(src);
  const blob = await resp.blob();
  return await globalThis.createImageBitmap(blob);
}

export class TextureCache {
  /**
   * @param {WebGL2RenderingContext|WebGLRenderingContext|null} [gl=null]
   * @param {object} [options={}]
   * @param {number} [options.maxBytes=DEFAULT_TEXTURE_CACHE_BYTES]
   * @param {number} [options.maxEntries=0]
   * @param {function(string, object):void} [options.onEvict=null]
   */
  constructor(gl = null, options = {}) {
    this.gl = gl;
    this.maxBytes = options.maxBytes ?? DEFAULT_TEXTURE_CACHE_BYTES;
    this.maxEntries = options.maxEntries ?? 0;
    this.onEvict = options.onEvict || null;
    this._entries = new Map();
    this._totalBytes = 0;
    this._pending = new Map();
  }

  get totalBytes() {
    return this._totalBytes;
  }

  get size() {
    return this._entries.size;
  }

  setContext(gl) {
    this.gl = gl;
  }

  has(key) {
    return this._entries.has(key);
  }

  /**
   * Retrieves an entry and marks it as most recently used.
   * @param {string} key
   * @returns {object|null} { texture, width, height, bytes, src }
   */
  get(key) {
    const entry = this._entries.get(key);
    if (!entry) return null;
    this._entries.delete(key);
    this._entries.set(key, entry);
    return entry;
  }

  /**
   * Convenience getter returning WebGLTexture or null.
   * @param {string} key
   * @returns {WebGLTexture|null}
   */
  getTexture(key) {
    const entry = this.get(key);
    return entry ? entry.texture : null;
  }

  /**
   * Inserts or updates an entry, evicting LRU items to satisfy maxBytes.
   * @param {string} key
   * @param {WebGLTexture} texture
   * @param {number} width
   * @param {number} height
   * @returns {object} The stored entry.
   */
  put(key, texture, width, height) {
    const bytes = computeTextureBytes(width, height);

    if (this._entries.has(key)) {
      const prev = this._entries.get(key);
      if (prev.texture && prev.texture !== texture && this.gl) {
        this.gl.deleteTexture(prev.texture);
      }
      if (this.onEvict && prev.texture !== texture) {
        this.onEvict(key, prev);
      }
      this._totalBytes -= prev.bytes;
      this._entries.delete(key);
    }

    while (
      ((this.maxBytes > 0 && this._totalBytes + bytes > this.maxBytes) ||
       (this.maxEntries > 0 && this._entries.size >= this.maxEntries)) &&
      this._entries.size > 0
    ) {
      const oldestKey = this._entries.keys().next().value;
      this.delete(oldestKey);
    }

    const entry = { texture, width, height, bytes, src: key };
    this._entries.set(key, entry);
    this._totalBytes += bytes;
    return entry;
  }

  /**
   * Retrieves or asynchronously loads and uploads a texture.
   * Deduplicates concurrent in-flight requests for the same source.
   * Immediately closes ImageBitmap after upload to free CPU memory.
   * @param {string} src
   * @param {function(string):Promise<TexImageSource>|null} [loader=null]
   * @returns {Promise<object|null>}
   */
  async getOrCreate(src, loader = null) {
    const cached = this.get(src);
    if (cached) return cached;

    if (this._pending.has(src)) {
      return this._pending.get(src);
    }

    const promise = (async () => {
      try {
        let imageSource = null;
        if (loader) {
          imageSource = await loader(src);
        } else {
          imageSource = await defaultImageLoader(src);
        }

        if (!imageSource) return null;

        const width = imageSource.naturalWidth || imageSource.videoWidth || imageSource.width || 0;
        const height = imageSource.naturalHeight || imageSource.videoHeight || imageSource.height || 0;
        if (width <= 0 || height <= 0) {
          if (typeof imageSource.close === 'function') imageSource.close();
          return null;
        }

        let texture = null;
        if (this.gl) {
          texture = uploadTexture(this.gl, imageSource);
        }

        if (typeof imageSource.close === 'function') {
          imageSource.close();
        }

        return this.put(src, texture, width, height);
      } finally {
        this._pending.delete(src);
      }
    })();

    this._pending.set(src, promise);
    return promise;
  }

  /**
   * Deletes an entry by key, releasing its WebGLTexture.
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    const entry = this._entries.get(key);
    if (!entry) return false;

    if (entry.texture && this.gl) {
      this.gl.deleteTexture(entry.texture);
    }
    if (this.onEvict) {
      this.onEvict(key, entry);
    }
    this._totalBytes -= entry.bytes;
    return this._entries.delete(key);
  }

  /**
   * Releases all textures and clears the pool.
   */
  clear() {
    for (const [key, entry] of this._entries) {
      if (entry.texture && this.gl) {
        this.gl.deleteTexture(entry.texture);
      }
      if (this.onEvict) {
        this.onEvict(key, entry);
      }
    }
    this._entries.clear();
    this._totalBytes = 0;
    this._pending.clear();
  }

  /**
   * Disposes the cache and detaches the GL context.
   */
  dispose() {
    this.clear();
    this.gl = null;
  }
}

export function createTextureCache(gl, options) {
  return new TextureCache(gl, options);
}
