/** Conversion Float32 → Float16 (bits), pour les textures RGBA16F. */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  // Un arrondi qui déborde sur l'exposant donne la bonne valeur (puissance de 2 suivante).
  return sign | ((exp << 10) + ((mant + 0x1000) >> 13));
}

/** Table 16 bits entier → demi-flottant (0..65535 → 0..1). */
let table: Uint16Array | undefined;
export function u16ToHalfTable(): Uint16Array {
  if (table) return table;
  table = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) table[i] = toHalf(i / 65535);
  return table;
}

export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}
