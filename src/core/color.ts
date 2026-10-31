/** Fonctions de couleur partagées par le pipeline CPU et les tests. */

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Luminance Rec.709 (sur des valeurs linéaires ou encodées selon le contexte). */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
      o[i * 3 + j] = s;
    }
  return o;
}

export function invertMat3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('Matrice non inversible');
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

/** sRGB (primaires) → XYZ adapté D50, colonnes = colorants du profil sRGB ICC. */
export const SRGB_TO_XYZD50: Mat3 = [
  0.4360747, 0.3850649, 0.1430804,
  0.2225045, 0.7168786, 0.0606169,
  0.0139322, 0.0971045, 0.7141733,
];
export const XYZD50_TO_SRGB: Mat3 = invertMat3(SRGB_TO_XYZD50);

/**
 * Multiplicateurs RVB (linéaires) pour une température (-100..100, négatif = plus froid)
 * et une teinte (-100..100, négatif = plus vert). Normalisés pour conserver la luminance.
 */
export function whiteBalanceGains(temperature: number, tint: number): [number, number, number] {
  const t = temperature / 100;
  const m = tint / 100;
  let r = Math.pow(2, 0.6 * t);
  let g = Math.pow(2, -0.5 * m);
  let b = Math.pow(2, -0.6 * t);
  const l = luma(r, g, b);
  r /= l; g /= l; b /= l;
  return [r, g, b];
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
