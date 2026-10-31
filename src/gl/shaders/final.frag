// Étape 2 : netteté, halo, vignettage, grain. Miroir de finish() (pipeline.ts).
uniform sampler2D u_stage;
uniform sampler2D u_halo;
uniform int u_hasHalo;
uniform float u_sharpen;
uniform float u_haloAmount;
uniform float u_vigAmount;
uniform float u_vigMid;
uniform float u_vigFeather;
uniform float u_grainAmount;
uniform float u_grainRough;
uniform float u_grainColor;
uniform float u_grainLum;
uniform vec2 u_grainScale;   // = dimensions/min(dimensions) * GRAIN_CELLS / taille
uniform vec2 u_aspect;       // = dimensions / max(dimensions)
in vec2 v_uv;
out vec4 o_color;

void main() {
  ivec2 size = textureSize(u_stage, 0);
  // Les FBO ont leur origine en bas : on lit au même pixel, et on recalcule uv (origine en haut).
  ivec2 p = clamp(ivec2(gl_FragCoord.xy), ivec2(0), size - 1);
  vec3 c = texelFetch(u_stage, p, 0).rgb;
  vec2 uv = vec2((float(p.x) + 0.5) / float(size.x), 1.0 - (float(p.y) + 0.5) / float(size.y));

  if (u_sharpen > 0.0) {
    float ln = luma(texelFetch(u_stage, clamp(p + ivec2(0, -1), ivec2(0), size - 1), 0).rgb);
    float ls = luma(texelFetch(u_stage, clamp(p + ivec2(0, 1), ivec2(0), size - 1), 0).rgb);
    float le = luma(texelFetch(u_stage, clamp(p + ivec2(1, 0), ivec2(0), size - 1), 0).rgb);
    float lw = luma(texelFetch(u_stage, clamp(p + ivec2(-1, 0), ivec2(0), size - 1), 0).rgb);
    float d = (luma(c) - (ln + ls + le + lw) * 0.25) * u_sharpen;
    c += d;
  }

  if (u_hasHalo == 1 && u_haloAmount > 0.0) {
    float h = texture(u_halo, vec2(uv.x, 1.0 - uv.y)).r * u_haloAmount * 1.5;
    c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - h * vec3(1.0, 0.32, 0.12));
  }

  if (u_vigAmount != 0.0) {
    vec2 d2 = (uv - 0.5) * 2.0 * u_aspect;
    float d = length(d2) / length(u_aspect);
    float t = smoothstep(u_vigMid, min(1.5, u_vigMid + u_vigFeather), d);
    if (u_vigAmount > 0.0) c *= 1.0 - u_vigAmount * t;
    else c += (1.0 - c) * (-u_vigAmount * t);
  }

  if (u_grainAmount > 0.0) {
    vec2 g = uv * u_grainScale;
    float l = clamp(luma(c), 0.0, 1.0);
    float w = (1.0 - u_grainLum) + u_grainLum * 4.0 * l * (1.0 - l);
    float s = u_grainAmount * 0.16 * w;
    float n = grainNoise(g, u_grainRough, 1);
    if (u_grainColor > 0.0) {
      vec3 nc = vec3(grainNoise(g, u_grainRough, 2), grainNoise(g, u_grainRough, 3), grainNoise(g, u_grainRough, 4));
      c += (n + (nc - n) * u_grainColor) * s;
    } else {
      c += n * s;
    }
  }
  o_color = vec4(clamp(c, 0.0, 1.0), 1.0);
}
