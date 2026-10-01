/**
 * quadCompositor.js: WebGL quad compositor for multi-image viewport rendering.
 *
 * Renders textured rectangular quads with bilinear sampling into a destination
 * viewport or offscreen FBO. Pre-allocates a single reusable Float32Array(24)
 * and updates a dynamic VBO per quad to eliminate garbage collection on hot paths.
 */

export const QUAD_VERTEX_COUNT = 6;
export const QUAD_FLOATS_PER_VERTEX = 4;
export const QUAD_VERTEX_FLOAT_COUNT = QUAD_VERTEX_COUNT * QUAD_FLOATS_PER_VERTEX; // 24 floats

/**
 * Maps screen coordinates (0 to vp, top-left origin) to NDC (-1 to 1, WebGL convention).
 * @param {number} x Screen x in pixels
 * @param {number} y Screen y in pixels
 * @param {number} vpW Viewport width in pixels
 * @param {number} vpH Viewport height in pixels
 * @param {number} [flipY=1.0] 1.0 for canvas, -1.0 for FBO targets
 * @returns {{ x: number, y: number }}
 */
export function screenToNdc(x, y, vpW, vpH, flipY = 1.0) {
  if (vpW <= 0 || vpH <= 0) return { x: 0, y: 0 };
  return {
    x: (x / vpW) * 2.0 - 1.0,
    y: (1.0 - (y / vpH) * 2.0) * flipY,
  };
}

/**
 * Maps a destination rectangle in screen pixels to NDC bounds.
 * @param {object} destRect { x, y, width, height } or { dx, dy, dw, dh }
 * @param {number} vpW Viewport width
 * @param {number} vpH Viewport height
 * @param {number} [flipY=1.0]
 * @returns {{ ndcX0: number, ndcY0: number, ndcX1: number, ndcY1: number }}
 */
export function destRectToNdc(destRect, vpW, vpH, flipY = 1.0) {
  const x = destRect.x ?? destRect.dx ?? 0;
  const y = destRect.y ?? destRect.dy ?? 0;
  const w = destRect.width ?? destRect.w ?? destRect.dw ?? 0;
  const h = destRect.height ?? destRect.h ?? destRect.dh ?? 0;

  const tl = screenToNdc(x, y, vpW, vpH, flipY);
  const br = screenToNdc(x + w, y + h, vpW, vpH, flipY);

  return {
    ndcX0: tl.x,
    ndcY0: tl.y,
    ndcX1: br.x,
    ndcY1: br.y,
  };
}

/**
 * Fills a 24-float array with 6 quad vertices (2 triangles) in screen pixel coordinates.
 * Stride per vertex is 4 floats: [posX, posY, texU, texV].
 * @param {object} destRect { x, y, width, height }
 * @param {object} sourceUV { u0, v0, u1, v1 }
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function fillQuadBuffer(destRect, sourceUV, out = null) {
  const buf = out || new Float32Array(QUAD_VERTEX_FLOAT_COUNT);

  const x0 = destRect.x ?? destRect.dx ?? 0;
  const y0 = destRect.y ?? destRect.dy ?? 0;
  const w = destRect.width ?? destRect.w ?? destRect.dw ?? 0;
  const h = destRect.height ?? destRect.h ?? destRect.dh ?? 0;
  const x1 = x0 + w;
  const y1 = y0 + h;

  const u0 = sourceUV.u0 ?? sourceUV.sx ?? 0;
  const v0 = sourceUV.v0 ?? sourceUV.sy ?? 0;
  const u1 = sourceUV.u1 ?? sourceUV.sw ?? 1;
  const v1 = sourceUV.v1 ?? sourceUV.sh ?? 1;

  // Triangle 1: Top-Left, Top-Right, Bottom-Left
  buf[0] = x0;  buf[1] = y0;  buf[2] = u0;  buf[3] = v0;
  buf[4] = x1;  buf[5] = y0;  buf[6] = u1;  buf[7] = v0;
  buf[8] = x0;  buf[9] = y1;  buf[10] = u0; buf[11] = v1;

  // Triangle 2: Bottom-Left, Top-Right, Bottom-Right
  buf[12] = x0; buf[13] = y1; buf[14] = u0; buf[15] = v1;
  buf[16] = x1; buf[17] = y0; buf[18] = u1; buf[19] = v0;
  buf[20] = x1; buf[21] = y1; buf[22] = u1; buf[23] = v1;

  return buf;
}

/**
 * Fills a 24-float array with 6 quad vertices (2 triangles) mapped directly to NDC.
 * @param {object} destRect
 * @param {object} sourceUV
 * @param {number} vpW
 * @param {number} vpH
 * @param {number} [flipY=1.0]
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function fillQuadNdcBuffer(destRect, sourceUV, vpW, vpH, flipY = 1.0, out = null) {
  const buf = out || new Float32Array(QUAD_VERTEX_FLOAT_COUNT);
  const ndc = destRectToNdc(destRect, vpW, vpH, flipY);

  const u0 = sourceUV.u0 ?? sourceUV.sx ?? 0;
  const v0 = sourceUV.v0 ?? sourceUV.sy ?? 0;
  const u1 = sourceUV.u1 ?? sourceUV.sw ?? 1;
  const v1 = sourceUV.v1 ?? sourceUV.sh ?? 1;

  // Triangle 1: Top-Left, Top-Right, Bottom-Left
  buf[0] = ndc.ndcX0; buf[1] = ndc.ndcY0; buf[2] = u0;  buf[3] = v0;
  buf[4] = ndc.ndcX1; buf[5] = ndc.ndcY0; buf[6] = u1;  buf[7] = v0;
  buf[8] = ndc.ndcX0; buf[9] = ndc.ndcY1; buf[10] = u0; buf[11] = v1;

  // Triangle 2: Bottom-Left, Top-Right, Bottom-Right
  buf[12] = ndc.ndcX0; buf[13] = ndc.ndcY1; buf[14] = u0; buf[15] = v1;
  buf[16] = ndc.ndcX1; buf[17] = ndc.ndcY0; buf[18] = u1; buf[19] = v0;
  buf[20] = ndc.ndcX1; buf[21] = ndc.ndcY1; buf[22] = u1; buf[23] = v1;

  return buf;
}

const VS_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
uniform vec2 u_viewport;
uniform float u_flipY;

void main() {
  vec2 ndc = vec2(
    (a_position.x / u_viewport.x) * 2.0 - 1.0,
    (1.0 - (a_position.y / u_viewport.y) * 2.0) * u_flipY
  );
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

const FS_SOURCE = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;

void main() {
  fragColor = texture(u_texture, v_texCoord);
}
`;

function compileShader(gl, type, source, name) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(`[QuadCompositor] Shader compile error in ${name}:`, gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource, 'vertex');
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, 'fragment');
  if (!vs || !fs) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[QuadCompositor] Program link error:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

export class QuadCompositor {
  /**
   * @param {WebGL2RenderingContext} gl
   */
  constructor(gl) {
    this.gl = gl;
    this._program = null;
    this._vbo = null;
    this._buffer = new Float32Array(QUAD_VERTEX_FLOAT_COUNT);
    this._disposed = false;

    this._aPosLoc = -1;
    this._aTexCoordLoc = -1;
    this._uViewportLoc = null;
    this._uFlipYLoc = null;
    this._uTextureLoc = null;

    if (this.gl) {
      this._init();
    }
  }

  _init() {
    const gl = this.gl;
    this._program = linkProgram(gl, VS_SOURCE, FS_SOURCE);
    if (!this._program) return;

    this._aPosLoc = gl.getAttribLocation(this._program, 'a_position');
    this._aTexCoordLoc = gl.getAttribLocation(this._program, 'a_texCoord');
    this._uViewportLoc = gl.getUniformLocation(this._program, 'u_viewport');
    this._uFlipYLoc = gl.getUniformLocation(this._program, 'u_flipY');
    this._uTextureLoc = gl.getUniformLocation(this._program, 'u_texture');

    this._vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this._buffer.byteLength, gl.DYNAMIC_DRAW);
  }

  /**
   * Draws a textured quad mapping destRect (pixels) to viewport dimensions with sourceUV.
   * @param {WebGLTexture} texture
   * @param {object} destRect { x, y, width, height }
   * @param {object} sourceUV { u0, v0, u1, v1 }
   * @param {number} vpW Viewport width in pixels
   * @param {number} vpH Viewport height in pixels
   * @param {number} [flipY=1.0] 1.0 for screen render, -1.0 when rendering into FBO
   * @returns {boolean} True if rendered, false otherwise.
   */
  drawQuad(texture, destRect, sourceUV, vpW, vpH, flipY = 1.0) {
    if (this._disposed || !this.gl || !this._program || !texture) return false;
    if (vpW <= 0 || vpH <= 0) return false;

    const gl = this.gl;
    fillQuadBuffer(destRect, sourceUV, this._buffer);

    gl.useProgram(this._program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._buffer);

    const stride = QUAD_FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT; // 16 bytes
    gl.enableVertexAttribArray(this._aPosLoc);
    gl.vertexAttribPointer(this._aPosLoc, 2, gl.FLOAT, false, stride, 0);

    gl.enableVertexAttribArray(this._aTexCoordLoc);
    gl.vertexAttribPointer(this._aTexCoordLoc, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

    gl.uniform2f(this._uViewportLoc, vpW, vpH);
    gl.uniform1f(this._uFlipYLoc, flipY);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this._uTextureLoc, 0);

    gl.drawArrays(gl.TRIANGLES, 0, QUAD_VERTEX_COUNT);
    return true;
  }

  /**
   * Releases allocated VBO and shader program.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.gl) {
      if (this._vbo) this.gl.deleteBuffer(this._vbo);
      if (this._program) this.gl.deleteProgram(this._program);
      this.gl = null;
    }
    this._program = null;
    this._vbo = null;
  }
}

export function createQuadCompositor(gl) {
  return new QuadCompositor(gl);
}
