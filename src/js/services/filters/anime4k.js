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
    }`
    }
  ]
};
