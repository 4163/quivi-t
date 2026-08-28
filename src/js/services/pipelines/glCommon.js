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
