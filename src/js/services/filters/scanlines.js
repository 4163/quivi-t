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
    const float GHOST_PX     = 0.001;
    const float GHOST_STRENGTH = 0.3;
    const vec3  GHOST_RIGHT  = vec3(1.0, 0.0, 0.8);
    const vec3  GHOST_LEFT   = vec3(0.0, 1.0, 0.2);
    const float GAP_HUE_SHIFT_DEG = 30.0;
    const float GAP_HUE_STRENGTH  = 0.35;

    // Architectural note:
    // We use Oklab for perceptually uniform hue shifting instead of a cheaper RGB approximation. 
    // While it requires heavy ALU math (matrices, powers), it runs in the fragment shader 
    // where ALU operations are practically free compared to texture fetches. This prevents 
    // color clipping in the scanline gaps without impacting framerate.

    // Perceptually uniform color spaces for accurate hue rotation
    vec3 linear_srgb_to_oklab(vec3 c) {
      float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
      float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
      float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
      float l_ = pow(l, 1.0/3.0);
      float m_ = pow(m, 1.0/3.0);
      float s_ = pow(s, 1.0/3.0);
      return vec3(
        0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_,
        1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_,
        0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_
      );
    }

    vec3 oklab_to_linear_srgb(vec3 c) {
      float l_ = c.x + 0.3963377774*c.y + 0.2158037573*c.z;
      float m_ = c.x - 0.1055613458*c.y - 0.0638541728*c.z;
      float s_ = c.x - 0.0894841775*c.y - 1.2914855480*c.z;
      float l = l_*l_*l_;
      float m = m_*m_*m_;
      float s = s_*s_*s_;
      return vec3(
         4.0767416621*l - 3.3077115913*m + 0.2309699292*s,
        -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
        -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
      );
    }

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
        // [BUGFIX]: Ghosting must be offset in screen space, not texture space, 
        // to ensure it bleeds horizontally on the physical monitor regardless of image rotation.
        float screen_dx = GHOST_PX * u_imageSize.x * u_scale / u_viewport.x;
        vec2 texRight = screenToTexUV(v_screenCoord + vec2(screen_dx, 0.0));
        vec2 texLeft  = screenToTexUV(v_screenCoord - vec2(screen_dx, 0.0));
        
        vec4 rTex = texture(u_texture, texRight);
        vec4 lTex = texture(u_texture, texLeft);
        
        vec3 rS = rTex.rgb * rTex.a;
        vec3 lS = lTex.rgb * lTex.a;
        float gs = GHOST_STRENGTH * alpha;
        
        // Right offset magenta (R + B channels)
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
      
      // Use Oklab for mathematically accurate, perceptually uniform hue shifting 
      // in the scanline gaps, preventing the color distortion typical of RGB rotations.
      vec3 base = tex.rgb;
      vec3 baseLinear = pow(base, vec3(2.2));
      vec3 lab = linear_srgb_to_oklab(baseLinear);
      
      float C = length(lab.yz);
      float satGate = smoothstep(0.02, 0.06, C); // Only apply hue shift to colored areas
      
      float angle = radians(GAP_HUE_SHIFT_DEG);
      float cosA = cos(angle);
      float sinA = sin(angle);
      
      vec2 ab = lab.yz;
      vec2 abRot = vec2(ab.x * cosA - ab.y * sinA, ab.x * sinA + ab.y * cosA);
      
      vec3 labAnalog = vec3(lab.x, abRot * 0.95); // Slight chroma attenuation
      vec3 analogLinear = oklab_to_linear_srgb(labAnalog);
      vec3 analogSrgb = pow(max(analogLinear, vec3(0.0)), vec3(1.0/2.2));
      
      vec3 gapColor = analogSrgb * alpha; // Premultiply by alpha to avoid edge bleed
      float strength = GAP_HUE_STRENGTH * satGate;
      
      col = mix(col, gapColor, gapAmount * strength);
      col *= BRIGHTNESS;
      col *= beam;
      col = min(col, vec3(1.0));

      outColor = vec4(col, alpha);
    }`
    }
  ]
};
