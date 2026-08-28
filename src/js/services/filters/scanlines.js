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

    const vec3  LUMA_W       = vec3(0.299, 0.587, 0.114);
    const float BEAM_MIN     = 0.90;
    const float BEAM_MAX     = 1.8;
    const float SCAN_WEIGHT  = 0.24;
    const float BRIGHTNESS   = 1.16;
    const float BEAM_FLOOR   = 0.72;    // minimum beam value (prevents pitch-black gaps)
    const vec3  GAP_TINT     = vec3(1.12, 0.82, 1.18);
    const float GAP_STRENGTH = 0.7;
    const float GHOST_PX     = 0.001;
    const float GHOST_STRENGTH = 0.5;
    const vec3  GHOST_RIGHT  = vec3(1.0, 0.0, 0.8);
    const vec3  GHOST_LEFT   = vec3(0.0, 1.0, 0.2);

    void main() {
      vec2 texUV = screenToTexUV(v_screenCoord);
      if (texUV.x < 0.0 || texUV.x > 1.0 || texUV.y < 0.0 || texUV.y > 1.0) {
        outColor = vec4(0.0);
        return;
      }

      vec4 tex = texture(u_texture, texUV);
      vec3 col = tex.rgb * tex.a;
      float alpha = tex.a;

      if (GHOST_PX > 0.0001) {
        vec4 rTex = texture(u_texture, vec2(texUV.x + GHOST_PX, texUV.y));
        vec4 lTex = texture(u_texture, vec2(texUV.x - GHOST_PX, texUV.y));
        vec3 rS = rTex.rgb * rTex.a;
        vec3 lS = lTex.rgb * lTex.a;
        float gs = GHOST_STRENGTH * alpha;
        // Right offset → magenta (R + B channels)
        col.r = mix(col.r, rS.r, gs * GHOST_RIGHT.r);
        col.g = mix(col.g, rS.g, gs * GHOST_RIGHT.g);
        col.b = mix(col.b, rS.b, gs * GHOST_RIGHT.b);
        
        col.r = mix(col.r, lS.r, gs * GHOST_LEFT.r);
        col.g = mix(col.g, lS.g, gs * GHOST_LEFT.g);
        col.b = mix(col.b, lS.b, gs * GHOST_LEFT.b);
      }

      float screenY = v_screenCoord.y * u_viewport.y;
      // Pixel centers evaluate at 0.5, 1.5, 2.5. We align beam centers to 0.5, 2.5, 4.5.
      float d = screenY - (floor(screenY * 0.5) * 2.0 + 0.5);
      float sigma = mix(BEAM_MIN, BEAM_MAX, dot(col, LUMA_W));
      float beam = exp(-0.5 * (d * d) / (sigma * sigma * SCAN_WEIGHT));
      beam = max(beam, BEAM_FLOOR);

      float gapAmount = 1.0 - smoothstep(BEAM_FLOOR, 0.9, beam);
      col = mix(col, col * GAP_TINT, gapAmount * GAP_STRENGTH);

      col *= BRIGHTNESS;
      col *= beam;
      col = min(col, vec3(1.0));

      outColor = vec4(col, alpha);
    }`
    }
  ]
};
