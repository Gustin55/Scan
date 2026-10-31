// Affichage « avant » : le fichier tel quel.
uniform sampler2D u_src;
in vec2 v_uv;
out vec4 o_color;
void main() { o_color = vec4(texture(u_src, v_uv).rgb, 1.0); }
