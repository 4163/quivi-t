import assert from 'node:assert/strict';
import {
  screenToNdc,
  destRectToNdc,
  fillQuadBuffer,
  fillQuadNdcBuffer,
  QuadCompositor,
  createQuadCompositor,
  QUAD_VERTEX_COUNT,
  QUAD_FLOATS_PER_VERTEX,
  QUAD_VERTEX_FLOAT_COUNT,
} from '../src/js/services/pipelines/quadCompositor.js';

describe('QuadCompositor pipeline module', () => {
  function createMockGl() {
    let nextId = 1;
    const calls = [];
    const createdBuffers = [];
    const createdPrograms = [];
    const createdShaders = [];
    const deletedBuffers = [];
    const deletedPrograms = [];
    const deletedShaders = [];
    let currentProgram = null;
    let boundBuffer = null;
    let boundTexture = null;
    let activeTex = 0;
    const uniformValues = new Map();
    let subDataPayload = null;

    return {
      calls,
      createdBuffers,
      createdPrograms,
      createdShaders,
      deletedBuffers,
      deletedPrograms,
      deletedShaders,
      subDataPayload,
      VERTEX_SHADER: 35633,
      FRAGMENT_SHADER: 35632,
      ARRAY_BUFFER: 34962,
      DYNAMIC_DRAW: 35048,
      FLOAT: 5126,
      TRIANGLES: 4,
      TEXTURE_2D: 3553,
      TEXTURE0: 33984,
      COMPILE_STATUS: 35713,
      LINK_STATUS: 35714,

      createShader(type) {
        const s = { id: nextId++, type };
        createdShaders.push(s);
        return s;
      },
      shaderSource(_shader, _source) {},
      compileShader(_shader) {},
      getShaderParameter(_shader, _param) {
        return true;
      },
      deleteShader(shader) {
        deletedShaders.push(shader);
      },
      getShaderInfoLog() {
        return '';
      },

      createProgram() {
        const p = { id: nextId++ };
        createdPrograms.push(p);
        return p;
      },
      attachShader(_prog, _shader) {},
      linkProgram(_prog) {},
      getProgramParameter(_prog, _param) {
        return true;
      },
      deleteProgram(prog) {
        deletedPrograms.push(prog);
      },
      getProgramInfoLog() {
        return '';
      },

      getAttribLocation(_prog, name) {
        if (name === 'a_position') return 0;
        if (name === 'a_texCoord') return 1;
        return -1;
      },
      getUniformLocation(_prog, name) {
        return { name };
      },

      createBuffer() {
        const b = { id: nextId++ };
        createdBuffers.push(b);
        return b;
      },
      deleteBuffer(buffer) {
        deletedBuffers.push(buffer);
      },
      bindBuffer(_target, buffer) {
        boundBuffer = buffer;
      },
      bufferData(_target, _size, _usage) {},
      bufferSubData(_target, offset, data) {
        this.subDataPayload = new Float32Array(data);
      },

      enableVertexAttribArray(_loc) {},
      vertexAttribPointer(_loc, _size, _type, _norm, _stride, _offset) {},

      useProgram(prog) {
        currentProgram = prog;
      },
      uniform2f(loc, x, y) {
        uniformValues.set(loc?.name, [x, y]);
      },
      uniform1f(loc, x) {
        uniformValues.set(loc?.name, x);
      },
      uniform1i(loc, x) {
        uniformValues.set(loc?.name, x);
      },

      activeTexture(tex) {
        activeTex = tex;
      },
      bindTexture(_target, tex) {
        boundTexture = tex;
      },
      drawArrays(mode, first, count) {
        calls.push({
          draw: true,
          mode,
          first,
          count,
          uniforms: new Map(uniformValues),
          activeTex,
          boundTexture,
          boundBuffer,
          currentProgram,
        });
      },
    };
  }

  describe('screenToNdc coordinate mapping', () => {
    it('maps screen corners to WebGL NDC bounds', () => {
      // Top-Left (0, 0) -> NDC (-1, 1)
      const tl = screenToNdc(0, 0, 1920, 1080);
      assert.equal(tl.x, -1);
      assert.equal(tl.y, 1);

      // Bottom-Right (1920, 1080) -> NDC (1, -1)
      const br = screenToNdc(1920, 1080, 1920, 1080);
      assert.equal(br.x, 1);
      assert.equal(br.y, -1);

      // Viewport Center (960, 540) -> NDC (0, 0)
      const center = screenToNdc(960, 540, 1920, 1080);
      assert.equal(center.x, 0);
      assert.equal(center.y, 0);
    });

    it('inverts NDC Y when flipY = -1.0 for FBO targets', () => {
      // With flipY = -1, Top-Left (0, 0) becomes NDC (-1, -1)
      const tlFlipped = screenToNdc(0, 0, 1000, 1000, -1.0);
      assert.equal(tlFlipped.x, -1);
      assert.equal(tlFlipped.y, -1);

      // Bottom-Right (1000, 1000) becomes NDC (1, 1)
      const brFlipped = screenToNdc(1000, 1000, 1000, 1000, -1.0);
      assert.equal(brFlipped.x, 1);
      assert.equal(brFlipped.y, 1);
    });

    it('handles degenerate viewport dimensions without NaN', () => {
      const res = screenToNdc(10, 10, 0, 0);
      assert.equal(res.x, 0);
      assert.equal(res.y, 0);
    });
  });

  describe('destRectToNdc bounds calculation', () => {
    it('calculates full viewport rectangle NDC bounds', () => {
      const ndc = destRectToNdc({ x: 0, y: 0, width: 800, height: 600 }, 800, 600);
      assert.equal(ndc.ndcX0, -1);
      assert.equal(ndc.ndcY0, 1);
      assert.equal(ndc.ndcX1, 1);
      assert.equal(ndc.ndcY1, -1);
    });

    it('calculates centered sub-rectangle NDC bounds and supports dx/dy aliases', () => {
      // Box at center: x=200, y=150, w=400, h=300 in 800x600 viewport
      const ndc = destRectToNdc({ dx: 200, dy: 150, dw: 400, dh: 300 }, 800, 600);
      assert.equal(ndc.ndcX0, -0.5);
      assert.equal(ndc.ndcY0, 0.5);
      assert.equal(ndc.ndcX1, 0.5);
      assert.equal(ndc.ndcY1, -0.5);
    });
  });

  describe('fillQuadBuffer vertex layout and reuse', () => {
    it('populates 24 floats for 6 vertices (2 triangles)', () => {
      const destRect = { x: 10, y: 20, width: 100, height: 200 };
      const sourceUV = { u0: 0.25, v0: 0.5, u1: 0.75, v1: 1.0 };
      const buf = fillQuadBuffer(destRect, sourceUV);

      assert.equal(buf.length, QUAD_VERTEX_FLOAT_COUNT);
      assert.equal(buf.length, 24);

      // Triangle 1:
      // Vertex 0: Top-Left (x0, y0, u0, v0)
      assert.deepEqual(Array.from(buf.slice(0, 4)), [10, 20, 0.25, 0.5]);
      // Vertex 1: Top-Right (x1, y0, u1, v0)
      assert.deepEqual(Array.from(buf.slice(4, 8)), [110, 20, 0.75, 0.5]);
      // Vertex 2: Bottom-Left (x0, y1, u0, v1)
      assert.deepEqual(Array.from(buf.slice(8, 12)), [10, 220, 0.25, 1.0]);

      // Triangle 2:
      // Vertex 3: Bottom-Left (x0, y1, u0, v1)
      assert.deepEqual(Array.from(buf.slice(12, 16)), [10, 220, 0.25, 1.0]);
      // Vertex 4: Top-Right (x1, y0, u1, v0)
      assert.deepEqual(Array.from(buf.slice(16, 20)), [110, 20, 0.75, 0.5]);
      // Vertex 5: Bottom-Right (x1, y1, u1, v1)
      assert.deepEqual(Array.from(buf.slice(20, 24)), [110, 220, 0.75, 1.0]);
    });

    it('mutates existing buffer in place to prevent allocation on hot paths', () => {
      const preallocated = new Float32Array(QUAD_VERTEX_FLOAT_COUNT);
      const res = fillQuadBuffer({ x: 0, y: 0, width: 50, height: 50 }, { u0: 0, v0: 0, u1: 1, v1: 1 }, preallocated);
      assert.equal(res, preallocated);
      assert.equal(preallocated[4], 50);
    });

    it('supports fillQuadNdcBuffer for direct NDC verification', () => {
      const buf = fillQuadNdcBuffer(
        { x: 0, y: 0, width: 100, height: 100 },
        { u0: 0, v0: 0, u1: 1, v1: 1 },
        100,
        100
      );
      assert.equal(buf.length, 24);
      // Vertex 0: Top-Left in NDC is (-1, 1)
      assert.equal(buf[0], -1);
      assert.equal(buf[1], 1);
      // Vertex 5: Bottom-Right in NDC is (1, -1)
      assert.equal(buf[20], 1);
      assert.equal(buf[21], -1);
    });
  });

  describe('QuadCompositor WebGL rendering and lifecycle', () => {
    it('initializes program, shader attributes, and dynamic VBO', () => {
      const gl = createMockGl();
      const compositor = createQuadCompositor(gl);

      assert.ok(compositor.gl);
      assert.equal(gl.createdPrograms.length, 2, 'Should create bilinear and lanczos programs');
      assert.equal(gl.createdShaders.length, 4);
      assert.equal(gl.deletedShaders.length, 4, 'Shaders should be deleted after linking');
      assert.equal(gl.createdBuffers.length, 1);
    });

    it('drawQuad updates VBO, sets viewport uniforms, and issues draw call', () => {
      const gl = createMockGl();
      const compositor = new QuadCompositor(gl);
      const texture = { id: 99 };

      const ok = compositor.drawQuad(
        texture,
        { x: 10, y: 20, width: 300, height: 400 },
        { u0: 0, v0: 0, u1: 1, v1: 1 },
        1920,
        1080,
        1.0
      );

      assert.equal(ok, true);
      assert.equal(gl.calls.length, 1);
      const call = gl.calls[0];
      assert.equal(call.draw, true);
      assert.equal(call.count, QUAD_VERTEX_COUNT);
      assert.equal(call.first, 0);
      assert.equal(call.boundTexture, texture);

      // Check uniforms
      assert.deepEqual(call.uniforms.get('u_viewport'), [1920, 1080]);
      assert.equal(call.uniforms.get('u_flipY'), 1.0);
      assert.equal(call.uniforms.get('u_texture'), 0);

      // Check buffer subdata payload contains screen coordinates
      assert.ok(gl.subDataPayload);
      assert.equal(gl.subDataPayload[0], 10);
      assert.equal(gl.subDataPayload[1], 20);
      assert.equal(gl.subDataPayload[4], 310);
    });

    it('drawQuad passes flipY = -1.0 when rendering to FBO targets', () => {
      const gl = createMockGl();
      const compositor = new QuadCompositor(gl);
      const texture = { id: 101 };

      compositor.drawQuad(
        texture,
        { x: 0, y: 0, width: 100, height: 100 },
        { u0: 0, v0: 0, u1: 1, v1: 1 },
        100,
        100,
        -1.0
      );

      assert.equal(gl.calls.length, 1);
      assert.equal(gl.calls[0].uniforms.get('u_flipY'), -1.0);
    });

    it('drawQuad with sampler = "lanczos" sets u_sourceSize uniform', () => {
      const gl = createMockGl();
      const compositor = new QuadCompositor(gl);
      const texture = { id: 102 };

      const ok = compositor.drawQuad(
        texture,
        { x: 0, y: 0, width: 200, height: 200 },
        { u0: 0, v0: 0, u1: 1, v1: 1 },
        1920,
        1080,
        1.0,
        'lanczos',
        { w: 800, h: 600 }
      );

      assert.equal(ok, true);
      assert.equal(gl.calls.length, 1);
      assert.deepEqual(gl.calls[0].uniforms.get('u_sourceSize'), [800, 600]);
    });

    it('returns false and ignores draw calls for invalid viewport dimensions', () => {
      const gl = createMockGl();
      const compositor = new QuadCompositor(gl);
      const ok = compositor.drawQuad({ id: 1 }, { x: 0, y: 0, w: 10, h: 10 }, {}, 0, 0);
      assert.equal(ok, false);
      assert.equal(gl.calls.length, 0);
    });

    it('dispose deletes VBO and program cleanly', () => {
      const gl = createMockGl();
      const compositor = new QuadCompositor(gl);
      compositor.dispose();

      assert.equal(gl.deletedBuffers.length, 1);
      assert.equal(gl.deletedPrograms.length, 2, 'Should delete both bilinear and lanczos programs');
      assert.equal(compositor.gl, null);

      // Subsequent draws return false
      assert.equal(compositor.drawQuad({ id: 1 }, {}, {}, 100, 100), false);
    });
  });
});
