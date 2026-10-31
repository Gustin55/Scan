// Étape 1 : inversion, balance, mélange, tonalité, virage, saturation.
uniform sampler2D u_src;
uniform sampler2D u_trc;
uniform sampler2D u_tone;
uniform int u_trcSize;
uniform int u_toneSize;
uniform int u_mode;          // 0 positif, 1 négatif couleur, 2 négatif N&B
uniform mat3 u_toSrgb;
uniform vec3 u_base;
uniform vec3 u_dmin;
uniform vec3 u_drange;
uniform vec3 u_gamma;
uniform vec3 u_gains;
uniform mat3 u_mixer;
uniform vec3 u_splitShadows;
uniform vec3 u_splitHighlights;
uniform float u_saturation;
uniform int u_maskOnly;      // 1 = sortie = masque de hautes lumières (carte de halo)
uniform float u_threshold;

in vec2 v_uv;
out vec4 o_color;

vec3 stage1(vec3 enc) {
  vec3 lin = u_toSrgb * lut3(u_trc, u_trcSize, enc);
  if (u_mode != 0) {
    if (u_mode == 2) lin = vec3(max(1e-6, luma(lin)));
    vec3 p = log(u_base / max(vec3(1e-6), lin)) / log(10.0);
    vec3 q = max(vec3(0.0), (p - u_dmin) / u_drange);
    lin = decodeSrgb(pow(q, u_gamma));
  }
  lin *= u_gains;
  lin = u_mixer * lin;
  vec3 e = lut3(u_tone, u_toneSize, encodeSrgb(lin));
  float l = luma(e);
  e += u_splitShadows * (1.0 - l) * (1.0 - l) + u_splitHighlights * l * l;
  float l2 = luma(e);
  return l2 + (e - l2) * u_saturation;
}

void main() {
  vec3 c = stage1(texture(u_src, sourceUV(v_uv)).rgb);
  if (u_maskOnly == 1) {
    float m = smoothstep(u_threshold, 1.0, luma(c));
    o_color = vec4(m, m, m, 1.0);
  } else {
    o_color = vec4(c, 1.0);
  }
}
