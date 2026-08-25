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
    uniform vec2 u_clamp;
    uniform vec4 u_visualRect;
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
      // 1. Calculate visual UV (0..1 across the image's bounding box on screen)
      vec2 visualUV = (v_screenCoord - u_visualRect.xy) / u_visualRect.zw;

      // 2. Mix screenCoord and visualUV based on latching
      vec2 mixUV = vec2(
        u_clamp.x > 0.5 ? v_screenCoord.x : visualUV.x,
        u_clamp.y > 0.5 ? v_screenCoord.y : visualUV.y
      );

      // 3. Apply CRT barrel distortion to the mixed 0..1 space
      vec2 barrelUV = curve(mixUV);

      // 4. Black bezel overlay (cut off anything outside the CRT glass)
      if (barrelUV.x < 0.0 || barrelUV.x > 1.0 || barrelUV.y < 0.0 || barrelUV.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      // 5. Convert distorted CRT coordinate back to true screen space
      vec2 distortedScreen = vec2(
        u_clamp.x > 0.5 ? barrelUV.x : barrelUV.x * u_visualRect.z + u_visualRect.x,
        u_clamp.y > 0.5 ? barrelUV.y : barrelUV.y * u_visualRect.w + u_visualRect.y
      );

      // 6. Map to texture UV for sampling
      vec2 sampledUV = screenToTexUV(distortedScreen);
      if (sampledUV.x < 0.0 || sampledUV.x > 1.0 || sampledUV.y < 0.0 || sampledUV.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      // Chromatic aberration
      float dx = 0.001;
      vec4 rTex = texture(u_texture, vec2(sampledUV.x + dx, sampledUV.y));
      vec4 centerTex = texture(u_texture, sampledUV);
      vec4 bTex = texture(u_texture, vec2(sampledUV.x - dx, sampledUV.y));
      
      float colR = rTex.r * rTex.a;
      float colG = centerTex.g * centerTex.a;
      float colB = bTex.b * bTex.a;
      float alpha = centerTex.a;
      vec3 col = vec3(colR, colG, colB);

      // Scanlines (curved with barrel, scaled based on actual CRT pixel height)
      float crtHeightPx = u_clamp.y > 0.5 ? u_viewport.y : (u_visualRect.w * u_viewport.y);
      float scanline = sin(barrelUV.y * crtHeightPx * 2.0) * 0.04;
      col -= scanline * alpha;

      // Vignette (perfectly hugs the CRT glass since barrelUV is 0..1 over it)
      float vx = 4.0 * barrelUV.x * (1.0 - barrelUV.x);
      float vy = 4.0 * barrelUV.y * (1.0 - barrelUV.y);
      float vig = vx * vy;
      float v = pow(vig, 0.3);
      col *= v;
      alpha = mix(1.0, alpha, v);

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
    clamp:     _gl.getUniformLocation(_program, 'u_clamp'),
    visualRect:_gl.getUniformLocation(_program, 'u_visualRect'),
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
    filter: activeFilter,

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

      const vpW = viewport.clientWidth;
      const vpH = viewport.clientHeight;

      canvas.width = vpW;
      canvas.height = vpH;
      canvas.style.removeProperty('width');
      canvas.style.removeProperty('height');

      _gl.viewport(0, 0, vpW, vpH);
      _gl.useProgram(_program);

      // Bind texture
      _gl.activeTexture(_gl.TEXTURE0);
      _gl.bindTexture(_gl.TEXTURE_2D, _sourceTexture);
      _gl.uniform1i(_loc.texture, 0);

      // Shared uniforms
      _gl.uniform2f(_loc.viewport, vpW, vpH);
      _gl.uniform2f(_loc.imageSize, nw, nh);
      _gl.uniform1f(_loc.scale, scale);
      _gl.uniform2f(_loc.translate, tx, ty);
      _gl.uniform1f(_loc.rotation, (rotation || 0) * Math.PI / 180.0);
      _gl.uniform2f(_loc.flip, flipX || 1, flipY || 1);

      if (activeFilter === 'crt') {
        if (_loc.clamp) {
          const isRotated = Math.abs(Math.round(rotation / 90)) % 2 === 1;
          const visualW = (isRotated ? nh : nw) * scale;
          const visualH = (isRotated ? nw : nh) * scale;
          const clampX = visualW >= vpW - 1 ? 1 : 0;
          const clampY = visualH >= vpH - 1 ? 1 : 0;
          _gl.uniform2f(_loc.clamp, clampX, clampY);

          const cx = vpW / 2 + tx;
          const cy = vpH / 2 + ty;
          const left = cx - visualW / 2;
          const top = cy - visualH / 2;
          if (_loc.visualRect) {
            _gl.uniform4f(_loc.visualRect, left / vpW, top / vpH, visualW / vpW, visualH / vpH);
          }
        }
      }

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
