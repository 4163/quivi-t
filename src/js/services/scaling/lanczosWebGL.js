import { inverseTransformGLSL, lanczos3ShaderSnippet } from '../pipelines/glCommon.js';

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
    ${lanczos3ShaderSnippet}
    out vec4 outColor;

    void main() {
      vec2 sampledUV = screenToTexUV(v_screenCoord);
      if (sampledUV.x < 0.0 || sampledUV.x > 1.0 || sampledUV.y < 0.0 || sampledUV.y > 1.0) {
        outColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
      }

      outColor = sampleLanczos3(u_texture, sampledUV, u_inputSize);
    }`
    }
  ]
};
