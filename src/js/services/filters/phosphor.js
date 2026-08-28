import { inverseTransformGLSL } from '../pipelines/glCommon.js';

export const filter = {
  passes: [
    {
      fsSource: `#version 300 es
    precision highp float;
    in vec2 v_screenCoord;
    uniform sampler2D u_texture;
    ${inverseTransformGLSL}
    out vec4 outColor;

    void main() {
      vec2 texUV = screenToTexUV(v_screenCoord);
      if (texUV.x < 0.0 || texUV.x > 1.0 || texUV.y < 0.0 || texUV.y > 1.0) {
        outColor = vec4(0.0);
        return;
      }

      vec4 tex = texture(u_texture, texUV);
      vec3 col = tex.rgb * tex.a;
      float alpha = tex.a;

      // Anchored to the image, but units are 1:1 with screen pixels (unscaled)
      vec2 patternPx = texUV * u_imageSize * u_scale;

      // Phosphor triad: 3 pattern pixels per triad
      int col3 = int(mod(patternPx.x, 3.0));
      
      // Softer mask — 0.75/1.25 vs 0.70/1.30 — less candy, more paper
      vec3 mask = vec3(0.75);
      if (col3 == 0) mask.r = 1.25;
      else if (col3 == 1) mask.g = 1.25;
      else mask.b = 1.25;
      col *= mask;

      // Scanline darkening (softer to maintain brightness)
      float scan = 0.92 + 0.08 * sin(patternPx.y * 3.14159);
      col *= scan;

      // Compensate for overall darkening from the grid/scanlines
      col *= 1.1;

      // Subtle phosphor glow via neighbor bleed (1 screen pixel distance)
      vec2 d = 1.0 / (u_imageSize * u_scale);
      vec4 bR = texture(u_texture, texUV + vec2(d.x, 0.0));
      vec4 bL = texture(u_texture, texUV - vec2(d.x, 0.0));
      vec3 bleed = (bR.rgb * bR.a) + (bL.rgb * bL.a);
      col += bleed * 0.05;

      outColor = vec4(col, alpha);
    }`
    }
  ]
};
