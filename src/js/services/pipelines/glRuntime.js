import { getCleanImage } from '../../shared/blobImage.js';

export function createGlRuntime(canvas) {
  let _active = true;
  let _gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: false,
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
    uniform float u_renderTargetFlipY;
    void main() {
      gl_Position = vec4(a_position.x, a_position.y * u_renderTargetFlipY, 0.0, 1.0);
      v_screenCoord = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
    }
  `;

  function compileShader(type, source, name) {
    const shader = _gl.createShader(type);
    _gl.shaderSource(shader, source);
    _gl.compileShader(shader);
    if (!_gl.getShaderParameter(shader, _gl.COMPILE_STATUS)) {
      console.error(`Shader compile error in ${name}:`, _gl.getShaderInfoLog(shader));
      _gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function linkProgram(fsSource, name) {
    const vs = compileShader(_gl.VERTEX_SHADER, vsSource, `${name} vertex`);
    const fs = compileShader(_gl.FRAGMENT_SHADER, fsSource, `${name} fragment`);
    if (!vs || !fs) return null;
    const prog = _gl.createProgram();
    _gl.attachShader(prog, vs);
    _gl.attachShader(prog, fs);
    _gl.linkProgram(prog);
    if (!_gl.getProgramParameter(prog, _gl.LINK_STATUS)) {
      console.error(`Program link error in ${name}:`, _gl.getProgramInfoLog(prog));
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
  
  let _fbos = new Map(); // key -> { fbo, tex, width, height }

  function clearFbos() {
    for (const fboData of _fbos.values()) {
      _gl.deleteTexture(fboData.tex);
      _gl.deleteFramebuffer(fboData.fbo);
    }
    _fbos.clear();
  }

  function getFbo(key, width, height) {
    let fboData = _fbos.get(key);
    if (!fboData || fboData.width !== width || fboData.height !== height) {
      if (fboData) {
        _gl.deleteTexture(fboData.tex);
        _gl.deleteFramebuffer(fboData.fbo);
      }
      const tex = _gl.createTexture();
      _gl.bindTexture(_gl.TEXTURE_2D, tex);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MIN_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MAG_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_S, _gl.CLAMP_TO_EDGE);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_T, _gl.CLAMP_TO_EDGE);
      _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, width, height, 0, _gl.RGBA, _gl.UNSIGNED_BYTE, null);

      const fbo = _gl.createFramebuffer();
      _gl.bindFramebuffer(_gl.FRAMEBUFFER, fbo);
      _gl.framebufferTexture2D(_gl.FRAMEBUFFER, _gl.COLOR_ATTACHMENT0, _gl.TEXTURE_2D, tex, 0);

      fboData = { fbo, tex, width, height };
      _fbos.set(key, fboData);
    }
    return fboData;
  }

  function setFilter(filterModule) {
    _programs.forEach(p => _gl.deleteProgram(p.program));
    _programs = [];
    clearFbos();

    if (!filterModule || !filterModule.passes) return;

    for (const pass of filterModule.passes) {
      const name = pass.name || 'unnamed WebGL pass';
      const prog = linkProgram(pass.fsSource, name);
      if (!prog) continue;

      const pData = {
        program: prog,
        name,
        space: pass.space || 'viewport',
        outputScale: pass.outputScale || 1,
        save: pass.save || null,
        input: pass.input || 'previous',
        posLoc: _gl.getAttribLocation(prog, 'a_position'),
        applyUniforms: pass.applyUniforms,
        renderTargetFlipYLoc: _gl.getUniformLocation(prog, 'u_renderTargetFlipY'),
        standardLocs: {
          texture:   _gl.getUniformLocation(prog, 'u_texture'),
          viewport:  _gl.getUniformLocation(prog, 'u_viewport'),
          imageSize: _gl.getUniformLocation(prog, 'u_imageSize'),
          inputSize: _gl.getUniformLocation(prog, 'u_inputSize'),
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

  function updateSource(canvasOrImage) {
    if (!_active || !_gl) return;
    
    const sourceIdentity = 'live_pump';
    
    if (_texSrc !== sourceIdentity || !_sourceTexture) {
      if (_sourceTexture) _gl.deleteTexture(_sourceTexture);
      _sourceTexture = _gl.createTexture();
      _gl.bindTexture(_gl.TEXTURE_2D, _sourceTexture);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MIN_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_MAG_FILTER, _gl.LINEAR);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_S, _gl.CLAMP_TO_EDGE);
      _gl.texParameteri(_gl.TEXTURE_2D, _gl.TEXTURE_WRAP_T, _gl.CLAMP_TO_EDGE);
      _texSrc = sourceIdentity;
    } else {
      _gl.bindTexture(_gl.TEXTURE_2D, _sourceTexture);
    }
    
    try {
      _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, _gl.RGBA, _gl.UNSIGNED_BYTE, canvasOrImage);
    } catch (e) {
      console.warn('WebGL texImage2D live update failed', e);
    }
  }

  async function render(imgElement, geometry, skipUpload = false) {
    if (!_active || !_gl || _programs.length === 0) return null;

    const nw = imgElement.naturalWidth;
    const nh = imgElement.naturalHeight;
    if (nw <= 0 || nh <= 0) return null;

    if (!skipUpload) {
      let cleanImg;
      try {
        cleanImg = await getCleanImage(imgElement.src);
      } catch { return null; }
      if (!_active) return null;
      
      // Support both HTMLImageElement (naturalWidth) and ImageBitmap (width)
      const cleanW = cleanImg.naturalWidth || cleanImg.width;
      const cleanH = cleanImg.naturalHeight || cleanImg.height;
      if (!cleanW || cleanW <= 0 || !cleanH || cleanH <= 0) return null;

      const sourceIdentity = imgElement.src + '|' + nw + '|' + nh;

      if (_texSrc !== sourceIdentity || !_sourceTexture) {
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
        _texSrc = sourceIdentity;
      }
    }

    const vpW = geometry.viewport.clientWidth;
    const vpH = geometry.viewport.clientHeight;

    if (canvas.width !== vpW || canvas.height !== vpH) {
      canvas.width = vpW;
      canvas.height = vpH;
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');
    }

    const { scale, tx, ty, rotation, flipX, flipY } = geometry;
    const geomExt = { nw, nh, scale, tx, ty, rotation: rotation || 0, flipX: flipX || 1, flipY: flipY || 1 };
    const vpExt = { width: vpW, height: vpH };

    _gl.bindBuffer(_gl.ARRAY_BUFFER, posBuffer);

    let currentInputTex = _sourceTexture;
    let _savedTextures = new Map();
    let currentInputSize = { w: nw, h: nh };

    function resolveInput(input) {
      if (input === 'source') return { tex: _sourceTexture, w: nw, h: nh };
      if (input === 'previous') return { tex: currentInputTex, ...currentInputSize };

      const saved = _savedTextures.get(input);
      if (saved) return saved;

      console.warn(`[WebGL] Missing texture input "${input}"`);
      return null;
    }
    
    for (let i = 0; i < _programs.length; i++) {
      const p = _programs[i];
      const isLast = i === _programs.length - 1;
      const requestedInputs = Array.isArray(p.input) ? p.input : [p.input];
      const resolvedInputs = requestedInputs.map(resolveInput);
      if (resolvedInputs.some(input => !input)) return null;

      let inW = resolvedInputs[0].w;
      let inH = resolvedInputs[0].h;

      let outW = vpW, outH = vpH;
      if (p.space === 'image') {
        outW = Math.max(1, Math.round(inW * p.outputScale));
        outH = Math.max(1, Math.round(inH * p.outputScale));
      }

      let outputFboData = null;
      const outputKey = `pass_${i}_${p.save || 'tmp'}`;

      if (isLast) {
        _gl.bindFramebuffer(_gl.FRAMEBUFFER, null);
        _gl.viewport(0, 0, vpW, vpH);
        _gl.clearColor(0, 0, 0, 0);
        _gl.clear(_gl.COLOR_BUFFER_BIT);
      } else {
        outputFboData = getFbo(outputKey, outW, outH);
        _gl.bindFramebuffer(_gl.FRAMEBUFFER, outputFboData.fbo);
        _gl.viewport(0, 0, outW, outH);
        _gl.clearColor(0, 0, 0, 0);
        _gl.clear(_gl.COLOR_BUFFER_BIT);
      }

      _gl.useProgram(p.program);

      if (Array.isArray(p.input)) {
        for (let j = 0; j < resolvedInputs.length; j++) {
          _gl.activeTexture(_gl.TEXTURE0 + j);
          _gl.bindTexture(_gl.TEXTURE_2D, resolvedInputs[j].tex);

          const loc = _gl.getUniformLocation(p.program, `u_tex${j}`);
          if (loc !== null) {
            _gl.uniform1i(loc, j);
          }
        }
      } else {
        _gl.activeTexture(_gl.TEXTURE0);
        _gl.bindTexture(_gl.TEXTURE_2D, resolvedInputs[0].tex);
        _gl.uniform1i(p.standardLocs.texture, 0);
      }

      _gl.uniform2f(p.standardLocs.viewport, vpW, vpH);
      _gl.uniform2f(p.standardLocs.imageSize, nw, nh);
      _gl.uniform2f(p.standardLocs.inputSize, inW, inH);
      _gl.uniform1f(p.standardLocs.scale, scale);
      _gl.uniform2f(p.standardLocs.translate, tx, ty);
      _gl.uniform1f(p.standardLocs.rotation, geomExt.rotation * Math.PI / 180.0);
      _gl.uniform2f(p.standardLocs.flip, geomExt.flipX, geomExt.flipY);
      
      if (p.renderTargetFlipYLoc !== null) {
        _gl.uniform1f(p.renderTargetFlipYLoc, isLast ? 1.0 : -1.0);
      }

      if (p.applyUniforms) {
        p.applyUniforms(_gl, p.customLocs, geomExt, vpExt, { inW, inH, outW, outH });
      }

      _gl.enableVertexAttribArray(p.posLoc);
      _gl.vertexAttribPointer(p.posLoc, 2, _gl.FLOAT, false, 0, 0);
      _gl.drawArrays(_gl.TRIANGLES, 0, 6);

      if (!isLast) {
        const output = { tex: outputFboData.tex, w: outW, h: outH };
        if (p.save) _savedTextures.set(p.save, output);
        currentInputTex = output.tex;
        currentInputSize = { w: outW, h: outH };
      }
    }

    return true;
  }

  return {
    type: 'webgl',
    setFilter,
    render,
    updateSource,
    cancel() {},
    dispose() {
      _active = false;
      if (_gl) {
        _gl.clearColor(0, 0, 0, 0);
        _gl.clear(_gl.COLOR_BUFFER_BIT);
        if (_sourceTexture) _gl.deleteTexture(_sourceTexture);
        _programs.forEach(p => _gl.deleteProgram(p.program));
        clearFbos();
        _gl.deleteBuffer(posBuffer);
        _gl = null;
      }
    },
  };
}
