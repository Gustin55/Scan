// Flou gaussien séparable (carte de halo).
uniform sampler2D u_src;
uniform vec2 u_dir;      // (1,0) ou (0,1)
uniform float u_sigma;
uniform int u_radius;
in vec2 v_uv;
out vec4 o_color;
void main() {
  ivec2 size = textureSize(u_src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float sum = 0.0, wsum = 0.0;
  for (int i = -u_radius; i <= u_radius; i++) {
    float w = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    ivec2 q = clamp(p + ivec2(u_dir) * i, ivec2(0), size - 1);
    sum += texelFetch(u_src, q, 0).r * w;
    wsum += w;
  }
  float v = sum / wsum;
  o_color = vec4(v, v, v, 1.0);
}
