/** Générateurs d'images synthétiques partagés par les tests et le script de fixtures. */
import { createRaster, type Raster } from '../src/core/raster.ts';
import { linearToSrgb, srgbToLinear } from '../src/core/color.ts';

/** Scène positive linéaire : dégradé, mire de gris, aplats colorés. */
export function sceneLinear(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  const patches: [number, number, number][] = [
    [0.6, 0.15, 0.1], [0.12, 0.45, 0.15], [0.1, 0.15, 0.55], [0.7, 0.6, 0.12], [0.45, 0.3, 0.22], [0.2, 0.4, 0.6],
  ];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1), v = y / (h - 1);
      let c: [number, number, number];
      if (v < 0.4) {
        // gamme de gris par paliers de 0,02 à 0,9
        const g = srgbToLinear(Math.floor(u * 10) / 9 * 0.9 + 0.05);
        c = [g, g, g];
      } else if (v < 0.7) {
        c = patches[Math.min(5, Math.floor(u * 6))];
      } else {
        const g = srgbToLinear(u);
        c = [g * 0.9, g * 0.8, g * 0.7];
      }
      out.set(c, (y * w + x) * 3);
    }
  return out;
}

export interface FilmModel { baseDensity: [number, number, number]; gamma: [number, number, number] }
export const COLOR_FILM: FilmModel = { baseDensity: [0.22, 0.58, 0.95], gamma: [0.62, 0.66, 0.7] };

/**
 * Simule le scan d'un négatif : densité = base + γ·(log E − log Emin), transmission
 * enregistrée en sRGB 16 bits, avec un bord non exposé de `border` pixels.
 */
export function simulateNegative(scene: Float32Array, w: number, h: number, border: number, film = COLOR_FILM, mono = false): Raster {
  const W = w + border * 2, H = h + border * 2;
  const r = createRaster(W, H, mono ? 1 : 3, 16);
  const logMin = Math.log10(0.003);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inside = x >= border && x < W - border && y >= border && y < H - border;
      const o = (y * W + x) * (mono ? 1 : 3);
      for (let c = 0; c < (mono ? 1 : 3); c++) {
        let d = film.baseDensity[c];
        if (inside) {
          const s = (y - border) * w + (x - border);
          const L = mono ? 0.2126 * scene[s * 3] + 0.7152 * scene[s * 3 + 1] + 0.0722 * scene[s * 3 + 2] : scene[s * 3 + c];
          d += film.gamma[c] * Math.max(0, Math.log10(L + 0.003) - logMin);
        }
        const t = Math.pow(10, -d);
        r.data[o + c] = Math.round(linearToSrgb(t) * 65535);
      }
    }
  return r;
}

export function sceneToRaster(scene: Float32Array, w: number, h: number): Raster {
  const r = createRaster(w, h, 3, 8);
  for (let i = 0; i < w * h * 3; i++) r.data[i] = Math.round(linearToSrgb(scene[i]) * 255) * 257;
  return r;
}
