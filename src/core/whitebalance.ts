import { srgbToLinear } from './color.ts';

/**
 * Correction de température / teinte (unités des curseurs, −100..100) qui rend neutre une
 * couleur observée (sRGB encodé 0..1). Inverse de whiteBalanceGains :
 * log2(R/V) = 0,6·t + 0,5·m et log2(B/V) = −0,6·t + 0,5·m (t, m en centièmes).
 */
export function neutralizeDelta(rgb: [number, number, number]): { temperature: number; tint: number } {
  const [r, g, b] = rgb.map((v) => Math.max(1e-4, srgbToLinear(v)));
  const kr = Math.log2(g / r); // facteur à appliquer au rouge
  const kb = Math.log2(g / b);
  return { temperature: ((kr - kb) / 1.2) * 100, tint: (kr + kb) * 100 };
}
