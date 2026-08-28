import { getCleanImage } from '../../shared/blobImage.js';

export function createGlRuntime(canvas) {
  let _active = true;
  let _gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: true,
    alpha: true,
    premultipliedAlpha: true,
  });

  if (!_gl) {
    console.warn('WebGL2 not supported');
    return { type: 'webgl', render: () => Promise.resolve(null), setFilter() {}, cancel() {}, dispose() {} };
  }

  let _sourceTexture = null;
  let _texSrc = null;

  const vsSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_screenCoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_screenCoord = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
    }
  `;

  function compileShader(type, source) {
    const shader = _gl.createShader(type);
    _gl.shaderSource(shader, source);
    _gl.compileShader(shader);
    if (!_gl.getShaderParameter(shader, _gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', _gl.getShaderInfoLog(shader));
      _gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function linkProgram(fsSource) {
    const vs = compileShader(_gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(_gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;
    const prog = _gl.createProgram();
    _gl.attachShader(prog, vs);
    _gl.attachShader(prog, fs);
    _gl.linkProgram(prog);
    if (!_gl.getProgramParameter(prog, _gl.LINK_STATUS)) {
      console.error('Program link error:', _gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  const posBuffer = _gl.createBuffer();
  _gl.bindBuffer(_gl.ARRAY_BUFFER, posBuffer);
  _gl.bufferData(_gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), _gl.STATIC_DRAW);

  let _programs = [];
  
  let _fbos = [null, null];
  let _fboTextures = [null, null];
  let _fboWidth = 0;
  let _fboHeight = 0;

  function resizeFbos(width, height) {
    if (_fboWidth === width && _fboHeight === height) return;
    _fboWidth = width;
    _fboHeight = height;

    for (let i = 0; i < 2; i++) {
      if (_fboTextures[i]) _gl.deleteTexture(_fboTextures[i]);
      if (_fbos[i]) _gl.deleteFramebuffer(_fbos[i]);

      _fboTextures[i] = _gl.createTexture();
      _gl.bindTexture(_gl.TEXTURE_2D, _fboTextures[i]);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MIN_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MAG_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_S, _gl.CLAMP_TO_EDGE);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_T, _gl.CLAMP_TO_EDGE);
      _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, width, height, 0, _gl.RGBA, _gl.UNSIGNED_BYTE, null);

      _fbos[i] = _gl.createFramebuffer();
      _gl.bindFramebuffer(_gl.FRAMEBUFFER, _fbos[i]);
      _gl.framebufferTexture2D(_gl.FRAMEBUFFER, _gl.COLOR_ATTACHMENT0, _gl.TEXTURE_2D, _fboTextures[i], 0);
    }
    _gl.bindFramebuffer(_gl.FRAMEBUFFER, null);
  }

  function setFilter(filterModule) {
    _programs.forEach(p => _gl.deleteProgram(p.program));
    _programs = [];

    if (!filterModule || !filterModule.passes) return;

    for (const pass of filterModule.passes) {
      const prog = linkProgram(pass.fsSource);
      if (!prog) continue;

      const pData = {
        program: prog,
        posLoc: _gl.getAttribLocation(prog, 'a_position'),
        applyUniforms: pass.applyUniforms,
        standardLocs: {
          texture:   _gl.getUniformLocation(prog, 'u_texture'),
          viewport:  _gl.getUniformLocation(prog, 'u_viewport'),
          imageSize: _gl.getUniformLocation(prog, 'u_imageSize'),
          scale:     _gl.getUniformLocation(prog, 'u_scale'),
          translate: _gl.getUniformLocation(prog, 'u_translate'),
          rotation:  _gl.getUniformLocation(prog, 'u_rotation'),
          flip:      _gl.getUniformLocation(prog, 'u_flip'),
        },
        customLocs: {}
      };

      if (pass.init) {
        pass.init(_gl, prog, pData.customLocs);
      }
      _programs.push(pData);
    }
  }

  async function render(imgElement, geometry) {
    if (!_active || !_gl || _programs.length === 0) return null;

    const nw = imgElement.naturalWidth;
    const nh = imgElement.naturalHeight;
    if (nw <= 0 || nh <= 0) return null;

    let cleanImg;
    try {
      cleanImg = await getCleanImage(imgElement.src);
    } catch { return null; }
    if (!_active) return null;
    if (!cleanImg.complete || cleanImg.naturalWidth <= 0 || cleanImg.naturalHeight <= 0) return null;

    if (_texSrc !== imgElement.src || !_sourceTexture) {
      if (_sourceTexture) _gl.deleteTexture(_sourceTexture);
      _sourceTexture = _gl.createTexture();
      _gl.bindTexture(_gl.TEXTURE_2D, _sourceTexture);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MIN_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MAG_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_S, _gl.CLAMP_TO_EDGE);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_T, _gl.CLAMP_TO_EDGE);
      try {
        _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, _gl.RGBA, _gl.UNSIGNED_BYTE, cleanImg);
      } catch (e) {
        console.warn('WebGL texImage2D failed', e);
        return null;
      }
      _texSrc = imgElement.src;
    }

    const vpW = geometry.viewport.clientWidth;
    const vpH = geometry.viewport.clientHeight;

    canvas.width = vpW;
    canvas.height = vpH;
    canvas.style.removeProperty('width');
    canvas.style.removeProperty('height');
    _gl.viewport(0, 0, vpW, vpH);

    if (_programs.length > 1) {
      resizeFbos(vpW, vpH);
    }

    const { scale, tx, ty, rotation, flipX, flipY } = geometry;
    const geomExt = { nw, nh, scale, tx, ty, rotation: rotation || 0, flipX: flipX || 1, flipY: flipY || 1 };
    const vpExt = { width: vpW, height: vpH };

    _gl.bindBuffer(_gl.ARRAY_BUFFER, posBuffer);

    let currentInputTex = _sourceTexture;
    
    for (let i = 0; i < _programs.length; i++) {
      const p = _programs[i];
      const isLast = i === _programs.length - 1;

      if (isLast) {
        _gl.bindFramebuffer(_gl.FRAMEBUFFER, null);
      } else {
        _gl.bindFramebuffer(_gl.FRAMEBUFFER, _fbos[i % 2]);
        _gl.clearColor(0, 0, 0, 0);
        _gl.clear(_gl.COLOR_BUFFER_BIT);
      }

      _gl.useProgram(p.program);

      _gl.activeTexture(_gl.TEXTURE0);
      _gl.bindTexture(_gl.TEXTURE_2D, currentInputTex);
      _gl.uniform1i(p.standardLocs.texture, 0);

      _gl.uniform2f(p.standardLocs.viewport, vpW, vpH);
      _gl.uniform2f(p.standardLocs.imageSize, nw, nh);
      _gl.uniform1f(p.standardLocs.scale, scale);
      _gl.uniform2f(p.standardLocs.translate, tx, ty);
      _gl.uniform1f(p.standardLocs.rotation, geomExt.rotation * Math.PI / 180.0);
      _gl.uniform2f(p.standardLocs.flip, geomExt.flipX, geomExt.flipY);

      if (p.applyUniforms) {
        p.applyUniforms(_gl, p.customLocs, geomExt, vpExt);
      }

      _gl.enableVertexAttribArray(p.posLoc);
      _gl.vertexAttribPointer(p.posLoc, 2, _gl.FLOAT, false, 0, 0);
      _gl.drawArrays(_gl.TRIANGLES, 0, 6);

      if (!isLast) {
        currentInputTex = _fboTextures[i % 2];
      }
    }

    return true;
  }

  return {
    type: 'webgl',
    setFilter,
    render,
    cancel() {},
    dispose() {
      _active = false;
      if (_gl) {
        _gl.clearColor(0, 0, 0, 0);
        _gl.clear(_gl.COLOR_BUFFER_BIT);
        if (_sourceTexture) _gl.deleteTexture(_sourceTexture);
        _programs.forEach(p => _gl.deleteProgram(p.program));
        for (let i = 0; i < 2; i++) {
          if (_fboTextures[i]) _gl.deleteTexture(_fboTextures[i]);
          if (_fbos[i]) _gl.deleteFramebuffer(_fbos[i]);
        }
        _gl.deleteBuffer(posBuffer);
        _gl = null;
      }
    },
  };
}
