import { inverseTransformGLSL } from '../pipelines/glCommon.js';

export const filter = {
  passes: [
    {
      fsSource: `#version 300 es
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
      vec2 visualUV = (v_screenCoord - u_visualRect.xy) / u_visualRect.zw;
      vec2 mixUV = vec2(
        u_clamp.x > 0.5 ? v_screenCoord.x : visualUV.x,
        u_clamp.y > 0.5 ? v_screenCoord.y : visualUV.y
      );

      vec2 barrelUV = curve(mixUV);
      if (barrelUV.x < 0.0 || barrelUV.x > 1.0 || barrelUV.y < 0.0 || barrelUV.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      vec2 distortedScreen = vec2(
        u_clamp.x > 0.5 ? barrelUV.x : barrelUV.x * u_visualRect.z + u_visualRect.x,
        u_clamp.y > 0.5 ? barrelUV.y : barrelUV.y * u_visualRect.w + u_visualRect.y
      );

      vec2 sampledUV = screenToTexUV(distortedScreen);
      if (sampledUV.x < 0.0 || sampledUV.x > 1.0 || sampledUV.y < 0.0 || sampledUV.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }

      float dx = 0.001;
      vec4 rTex = texture(u_texture, vec2(sampledUV.x + dx, sampledUV.y));
      vec4 centerTex = texture(u_texture, sampledUV);
      vec4 bTex = texture(u_texture, vec2(sampledUV.x - dx, sampledUV.y));
      
      float colR = rTex.r * rTex.a;
      float colG = centerTex.g * centerTex.a;
      float colB = bTex.b * bTex.a;
      float alpha = centerTex.a;
      vec3 col = vec3(colR, colG, colB);

      float crtHeightPx = u_clamp.y > 0.5 ? u_viewport.y : (u_visualRect.w * u_viewport.y);
      float scanline = sin(barrelUV.y * crtHeightPx * 2.0) * 0.04;
      col -= scanline * alpha;

      float vx = 4.0 * barrelUV.x * (1.0 - barrelUV.x);
      float vy = 4.0 * barrelUV.y * (1.0 - barrelUV.y);
      float vig = vx * vy;
      float v = pow(vig, 0.3);
      col *= v;
      alpha = mix(1.0, alpha, v);

      outColor = vec4(col, alpha);
    }`,

      init(gl, program, loc) {
        loc.clamp = gl.getUniformLocation(program, 'u_clamp');
        loc.visualRect = gl.getUniformLocation(program, 'u_visualRect');
      },

      applyUniforms(gl, loc, geometry, viewport) {
        const { scale, rotation, tx, ty, nw, nh } = geometry;
        const vpW = viewport.width;
        const vpH = viewport.height;

        const isRotated = Math.abs(Math.round(rotation / 90)) % 2 === 1;
        const visualW = (isRotated ? nh : nw) * scale;
        const visualH = (isRotated ? nw : nh) * scale;
        
        const clampX = visualW >= vpW - 1 ? 1 : 0;
        const clampY = visualH >= vpH - 1 ? 1 : 0;
        gl.uniform2f(loc.clamp, clampX, clampY);

        const cx = vpW / 2 + tx;
        const cy = vpH / 2 + ty;
        const left = cx - visualW / 2;
        const top = cy - visualH / 2;
        gl.uniform4f(loc.visualRect, left / vpW, top / vpH, visualW / vpW, visualH / vpH);
      }
    }
  ]
};
