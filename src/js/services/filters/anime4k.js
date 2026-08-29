import { inverseTransformGLSL } from '../pipelines/glCommon.js';
import { FAST_CHAIN, NORMAL_CHAIN } from './anime4k/chains.js';

const drawPass = {
  name: 'DrawToViewport',
  space: 'viewport',
  input: 'previous',
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
      outColor = texture(u_texture, vec2(texUV.x, 1.0 - texUV.y));
    }
  `
};

export const filter = {
  resolve(filterOptions) {
    const variant = filterOptions?.anime4k?.variant === 'normal' ? 'normal' : 'fast';
    const chain = variant === 'normal' ? NORMAL_CHAIN : FAST_CHAIN;
    return { passes: [...chain, drawPass] };
  }
};
