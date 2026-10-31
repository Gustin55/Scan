// Fonctions partagées. Miroir exact de src/core/noise.ts et src/core/pipeline.ts.
precision highp float;
precision highp int;
precision highp sampler2D;

uint hash3u(int x, int y, int seed) {
  uint h = (uint(x) * 0x8da6b343u) ^ (uint(y) * 0xd8163841u) ^ (uint(seed) * 0xcb1ab31fu);
  h = (h ^ (h >> 13u)) * 0x5bd1e995u;
  h = h ^ (h >> 15u);
  return h;
}
float hash3(int x, int y, int seed) { return float(hash3u(x, y, seed)) / 4294967295.0; }

float valueNoise(vec2 p, int seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  int ix = int(i.x), iy = int(i.y);
  float a = hash3(ix, iy, seed), b = hash3(ix + 1, iy, seed);
  float c = hash3(ix, iy + 1, seed), d = hash3(ix + 1, iy + 1, seed);
  float v = a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
  return v * 2.0 - 1.0;
}

float grainNoise(vec2 p, float roughness, int seed) {
  float n1 = valueNoise(p, seed);
  float n2 = valueNoise(p * 2.03 + vec2(17.0, 31.0), seed + 101);
  return (n1 * (1.0 - 0.5 * roughness) + n2 * roughness) * 1.6;
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Table 1D (RGBA, une ligne) échantillonnée avec interpolation linéaire manuelle.
vec3 lut3(sampler2D t, int size, vec3 v) {
  vec3 x = clamp(v, 0.0, 1.0) * float(size - 1);
  vec3 i = floor(x);
  vec3 f = x - i;
  ivec3 i0 = ivec3(i);
  ivec3 i1 = min(i0 + 1, ivec3(size - 1));
  float r = mix(texelFetch(t, ivec2(i0.r, 0), 0).r, texelFetch(t, ivec2(i1.r, 0), 0).r, f.r);
  float g = mix(texelFetch(t, ivec2(i0.g, 0), 0).g, texelFetch(t, ivec2(i1.g, 0), 0).g, f.g);
  float b = mix(texelFetch(t, ivec2(i0.b, 0), 0).b, texelFetch(t, ivec2(i1.b, 0), 0).b, f.b);
  return vec3(r, g, b);
}

vec3 encodeSrgb(vec3 v) {
  v = clamp(v, 0.0, 1.0);
  return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));
}
vec3 decodeSrgb(vec3 v) {
  return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), v));
}
