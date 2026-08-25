import { getCleanImage } from '../shared/blobImage.js';

export function createWebglPipeline(canvas, scalingMode, activeFilter) {
  let _active = true;
  let _gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: true,
    alpha: true,
    premultipliedAlpha: true,
  });
  if (!_gl) {
    console.warn('WebGL2 not supported');
    return { type: 'webgl', render: () => Promise.resolve(null), cancel() {}, dispose() {} };
  }

  let _sourceTexture = null;
  let _texSrc = null;

  // ── Vertex shader ──
  // Fullscreen quad. Outputs screen coordinates in CSS convention
  // (0,0 = top-left, 1,1 = bottom-right).
  const vsSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_screenCoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_screenCoord = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
    }
  `;

  // ── Shared inverse-transform (screen pixel → texture UV) ──
  const inverseTransformGLSL = `
    uniform vec2  u_viewport;
    uniform vec2  u_imageSize;
    uniform float u_scale;
    uniform vec2  u_translate;
    uniform float u_rotation;
    uniform vec2  u_flip;

    vec2 screenToTexUV(vec2 screenUV) {
      vec2 px = (screenUV - 0.5) * u_viewport;
      vec2 ut = px - u_translate;
      float c = cos(-u_rotation);
      float s = sin(-u_rotation);
      vec2 ur = vec2(ut.x * c - ut.y * s, ut.x * s + ut.y * c);
      vec2 us = ur / u_scale * u_flip;
      vec2 imgPx = us + u_imageSize * 0.5;
      return imgPx / u_imageSize;
    }
  `;

  // ── CRT fragment shader ──
  const crtFsSource = `#version 300 es
    precision highp float;
    in vec2 v_screenCoord;
    uniform sampler2D u_texture;
    uniform bool u_blackBezel;
    ${inverseTransformGLSL}
    out vec4 outColor;

    vec2 curve(vec2 uv) {
      uv = (uv - 0.5) * 2.0;
      uv *= 1.1;
      uv.x *= 1.0 + pow(abs(uv.y) / 5.0, 2.0);
      uv.y *= 1.0 + pow(abs(uv.x) / 4.0, 2.0);
      uv = (uv / 2.0) + 0.5;
      uv = uv * 0.92 + 0.04;
      return uv;
    }

    void main() {
      vec2 distorted = curve(v_screenCoord);

      if (distorted.x < 0.0 || distorted.x > 1.0 ||
          distorted.y < 0.0 || distorted.y > 1.0) {
        outColor = u_blackBezel ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(0.0);
        return;
      }

      vec2 texUV = screenToTexUV(distorted);

      if (texUV.x < 0.0 || texUV.x > 1.0 ||
          texUV.y < 0.0 || texUV.y > 1.0) {
        outColor = vec4(0.0);
        return;
      }

      // Chromatic aberration
      float dx = 0.001;
      vec4 rTex = texture(u_texture, vec2(texUV.x + dx, texUV.y));
      vec4 centerTex = texture(u_texture, texUV);
      vec4 bTex = texture(u_texture, vec2(texUV.x - dx, texUV.y));
      
      // Premultiply by alpha immediately to suppress invisible RGB bleed
      float colR = rTex.r * rTex.a;
      float colG = centerTex.g * centerTex.a;
      float colB = bTex.b * bTex.a;
      float alpha = centerTex.a;
      vec3 col = vec3(colR, colG, colB);

      // Scanlines (tied to screen pixels, not texture pixels)
      float scanline = sin(distorted.y * u_viewport.y * 2.0) * 0.04;
      // Only apply scanlines to visible pixels to avoid making transparent areas negative/weird
      col -= scanline * alpha;

      // Vignette
      float vig = 16.0 * distorted.x * distorted.y *
                  (1.0 - distorted.x) * (1.0 - distorted.y);
      float v = pow(vig, 0.3);
      col *= v;
      if (u_blackBezel) {
        alpha = mix(1.0, alpha, v);
      }

      // Output directly since col is already premultiplied and vignette scales it down
      outColor = vec4(col, alpha);
    }
  `;

  // ── Anime4K edge-sharpening fragment shader ──
  const animeFsSource = `#version 300 es
    precision highp float;
    in vec2 v_screenCoord;
    uniform sampler2D u_texture;
    ${inverseTransformGLSL}
    out vec4 outColor;

    float getLum(vec3 c) {
      return dot(c, vec3(0.299, 0.587, 0.114));
    }

    void main() {
      vec2 texUV = screenToTexUV(v_screenCoord);

      if (texUV.x < 0.0 || texUV.x > 1.0 ||
          texUV.y < 0.0 || texUV.y > 1.0) {
        outColor = vec4(0.0);
        return;
      }

      vec4 texColor = texture(u_texture, texUV);
      vec3 color = texColor.rgb;
      float alpha = texColor.a;

      // Sample four neighbours in screen space
      vec2 d = 1.0 / u_viewport;
      vec4 t_tex = texture(u_texture, screenToTexUV(v_screenCoord + vec2( 0.0, -d.y)));
      vec4 b_tex = texture(u_texture, screenToTexUV(v_screenCoord + vec2( 0.0,  d.y)));
      vec4 l_tex = texture(u_texture, screenToTexUV(v_screenCoord + vec2(-d.x,  0.0)));
      vec4 r_tex = texture(u_texture, screenToTexUV(v_screenCoord + vec2( d.x,  0.0)));

      // Premultiply by alpha to suppress sharpening against invisible RGB bleed
      vec3 c = color * alpha;
      vec3 t = t_tex.rgb * t_tex.a;
      vec3 b = b_tex.rgb * b_tex.a;
      vec3 l = l_tex.rgb * l_tex.a;
      vec3 r = r_tex.rgb * r_tex.a;

      vec3 laplacian = 4.0 * c - t - b - l - r;
      float edge = abs(getLum(laplacian));
      if (edge > 0.05) {
        c += laplacian * 0.25;
      }

      outColor = vec4(c, alpha);
    }
  `;

  // ── Shader compilation ──

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

  const _program = activeFilter === 'crt'
    ? linkProgram(crtFsSource)
    : linkProgram(animeFsSource);

  if (!_program) {
    return { type: 'webgl', render: () => Promise.resolve(null), cancel() {}, dispose() {} };
  }

  // Cache uniform locations
  const _loc = {
    texture:   _gl.getUniformLocation(_program, 'u_texture'),
    viewport:  _gl.getUniformLocation(_program, 'u_viewport'),
    imageSize: _gl.getUniformLocation(_program, 'u_imageSize'),
    scale:     _gl.getUniformLocation(_program, 'u_scale'),
    translate: _gl.getUniformLocation(_program, 'u_translate'),
    rotation:  _gl.getUniformLocation(_program, 'u_rotation'),
    flip:      _gl.getUniformLocation(_program, 'u_flip'),
    blackBezel:_gl.getUniformLocation(_program, 'u_blackBezel'),
  };

  // Fullscreen quad buffer
  const posBuffer = _gl.createBuffer();
  _gl.bindBuffer(_gl.ARRAY_BUFFER, posBuffer);
  _gl.bufferData(_gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), _gl.STATIC_DRAW);

  const posLoc = _gl.getAttribLocation(_program, 'a_position');

  return {
    type: 'webgl',

    async render(imgElement, geometry) {
      if (!_active || !_gl || !_program) return null;

      const { scale, tx, ty, rotation, flipX, flipY, viewport } = geometry;
      const nw = imgElement.naturalWidth;
      const nh = imgElement.naturalHeight;
      if (nw <= 0 || nh <= 0) return null;

      // Fetch as blob for same-origin texture upload
      let cleanImg;
      try {
        cleanImg = await getCleanImage(imgElement.src);
      } catch { return null; }
      if (!_active) return null;
      if (!cleanImg.complete || cleanImg.naturalWidth <= 0 || cleanImg.naturalHeight <= 0) return null;

      // Upload texture when source changes
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

      // Size canvas to viewport
      const vpW = viewport.clientWidth;
      const vpH = viewport.clientHeight;
      canvas.width = vpW;
      canvas.height = vpH;
      _gl.viewport(0, 0, vpW, vpH);

      _gl.useProgram(_program);

      // Set transform uniforms
      _gl.uniform2f(_loc.viewport, vpW, vpH);
      _gl.uniform2f(_loc.imageSize, nw, nh);
      _gl.uniform1f(_loc.scale, scale);
      _gl.uniform2f(_loc.translate, tx, ty);
      _gl.uniform1f(_loc.rotation, (rotation || 0) * Math.PI / 180.0);
      _gl.uniform2f(_loc.flip, flipX || 1, flipY || 1);

      const isRotated = Math.abs(Math.round((rotation || 0) / 90)) % 2 === 1;
      const visualW = (isRotated ? nh : nw) * scale;
      const visualH = (isRotated ? nw : nh) * scale;
      if (_loc.blackBezel !== null) {
        _gl.uniform1i(_loc.blackBezel, (visualW >= vpW - 1.0 && visualH >= vpH - 1.0) ? 1 : 0);
      }

      // Bind texture
      _gl.activeTexture(_gl.TEXTURE0);
      _gl.bindTexture(_gl.TEXTURE_2D, _sourceTexture);
      _gl.uniform1i(_loc.texture, 0);

      // Draw fullscreen quad
      _gl.bindBuffer(_gl.ARRAY_BUFFER, posBuffer);
      _gl.enableVertexAttribArray(posLoc);
      _gl.vertexAttribPointer(posLoc, 2, _gl.FLOAT, false, 0, 0);
      _gl.drawArrays(_gl.TRIANGLES, 0, 6);

      return true;
    },

    cancel() {
      // Blob fetch is not cancellable, but _active flag prevents
      // stale renders from applying.
    },

    dispose() {
      _active = false;
      if (_gl) {
        _gl.clearColor(0, 0, 0, 0);
        _gl.clear(_gl.COLOR_BUFFER_BIT);
        if (_sourceTexture) _gl.deleteTexture(_sourceTexture);
        if (_program) _gl.deleteProgram(_program);
        _gl.deleteBuffer(posBuffer);
        _gl = null;
      }
    },
  };
}
