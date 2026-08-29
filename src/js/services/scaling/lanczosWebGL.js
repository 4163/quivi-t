import { inverseTransformGLSL } from '../pipelines/glCommon.js';

export const filter = {
  passes: [
    {
      fsSource: `#version 300 es
    precision highp float;
    
    // Architectural note:
    // We use a 1-pass 2D convolution (36 lookups) instead of a 2-pass separable one (12 lookups). 
    // A separable convolution requires asymmetric intermediate FBOs (scaling X but not Y), 
    // which glRuntime does not support. Modifying the pipeline manager for this edge case 
    // adds unnecessary complexity, as GPUs easily handle 36 lookups at 1080p60.

    in vec2 v_screenCoord;
    uniform sampler2D u_texture;
    uniform vec2 u_inputSize;
    ${inverseTransformGLSL}
    out vec4 outColor;

    const float PI = 3.14159265358979323846264;

    float lanczos3(float x) {
      x = abs(x);
      if (x == 0.0) return 1.0;
      if (x >= 3.0) return 0.0;
      float px = PI * x;
      return (sin(px) / px) * (sin(px / 3.0) / (px / 3.0));
    }

    void main() {
      vec2 sampledUV = screenToTexUV(v_screenCoord);
      if (sampledUV.x < 0.0 || sampledUV.x > 1.0 || sampledUV.y < 0.0 || sampledUV.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
      }

      vec2 texelSize = 1.0 / u_inputSize;
      vec2 pxCoords = sampledUV * u_inputSize;
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
          vec4 texel = texture(u_texture, sampleUV);
          
          // Premultiply for interpolation
          texel.rgb *= texel.a;
          
          color += texel * weight;
          totalWeight += weight;
        }
      }
      
      color /= totalWeight;
      
      // Keep output premultiplied for WebGL composite
      outColor = clamp(color, 0.0, 1.0);
    }`
    }
  ]
};
