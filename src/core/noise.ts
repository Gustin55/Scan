/**
 * Bruit déterministe, identique à `src/gl/shaders/common.glsl` (hash entier 32 bits).
 * Toute modification doit être reportée dans le shader.
 */

export function hash3(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(seed | 0, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967295;
}

/** Bruit de valeur lissé, sortie dans [-1, 1]. */
export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash3(ix, iy, seed), b = hash3(ix + 1, iy, seed);
  const c = hash3(ix, iy + 1, seed), d = hash3(ix + 1, iy + 1, seed);
  const v = a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  return v * 2 - 1;
}

/** Grain : deux octaves, `roughness` pondère l'octave fine. */
export function grainNoise(x: number, y: number, roughness: number, seed: number): number {
  const n1 = valueNoise(x, y, seed);
  const n2 = valueNoise(x * 2.03 + 17.0, y * 2.03 + 31.0, seed + 101);
  return (n1 * (1 - 0.5 * roughness) + n2 * roughness) * 1.6;
}
