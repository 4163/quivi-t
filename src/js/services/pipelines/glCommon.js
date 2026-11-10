export const inverseTransformGLSL = `
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

export const lanczos3ShaderSnippet = `
    const float PI = 3.14159265358979323846264;

    float lanczos3(float x) {
      x = abs(x);
      if (x < 0.0001) return 1.0;
      if (x >= 3.0) return 0.0;
      float px = PI * x;
      return (sin(px) / px) * (sin(px / 3.0) / (px / 3.0));
    }

    vec4 sampleLanczos3(sampler2D tex, vec2 uv, vec2 texSize) {
      vec2 texelSize = 1.0 / texSize;
      vec2 pxCoords = uv * texSize;
      vec2 center = floor(pxCoords - 0.5) + 0.5;
      vec2 offset = pxCoords - center;

      vec4 color = vec4(0.0);
      float totalWeight = 0.0;

      for (float y = -2.0; y <= 3.0; y++) {
        float dy = y - offset.y;
        float wy = lanczos3(dy);
        if (wy == 0.0) continue;

        for (float x = -2.0; x <= 3.0; x++) {
          float dx = x - offset.x;
          float wx = lanczos3(dx);
          float weight = wx * wy;

          vec2 sampleUV = clamp((center + vec2(x, y)) * texelSize, 0.0, 1.0);
          vec4 texel = texture(tex, sampleUV);

          // Premultiply for interpolation
          texel.rgb *= texel.a;

          color += texel * weight;
          totalWeight += weight;
        }
      }

      if (totalWeight > 0.00001) {
        color /= totalWeight;
      }

      // Keep output premultiplied for WebGL composite
      return clamp(color, 0.0, 1.0);
    }
`;

export const lanczos3GLSL = lanczos3ShaderSnippet;
export const LANCZOS3_FS_FUNCS = lanczos3ShaderSnippet;

