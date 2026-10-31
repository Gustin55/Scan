/**
 * Génère le jeu d'essai dans fixtures/ (et les exemples de l'app dans public/samples/).
 *   npm run fixtures        → petites et moyennes images
 *   npm run fixtures:big    → en plus, un scan 16 bits de 40 Mpx dans fixtures/big/ (non versionné)
 */
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { createRaster, type Raster } from '../src/core/raster.ts';
import { encodeTiff } from '../src/core/tiff/encode.ts';
import { buildSrgbIcc } from '../src/core/icc.ts';
import { linearToSrgb } from '../src/core/color.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'fixtures');
mkdirSync(out, { recursive: true });

/** Scène de test « naturelle » : ciel, soleil, collines, mire de gris, aplats colorés. */
function scene(w: number, h: number) {
  return (x: number, y: number): [number, number, number] => {
    const u = x / w, v = y / h;
    // mire de gris en bas à gauche, aplats en bas à droite
    if (v > 0.78) {
      if (u < 0.5) { const g = Math.pow(Math.floor(u * 20) / 9, 2.2) * 0.9 + 0.005; return [g, g, g]; }
      const P: [number, number, number][] = [[0.55, 0.12, 0.08], [0.1, 0.4, 0.12], [0.08, 0.12, 0.5], [0.65, 0.55, 0.1], [0.42, 0.28, 0.2], [0.18, 0.36, 0.55]];
      return P[Math.min(5, Math.floor((u - 0.5) * 12))];
    }
    const sun = Math.hypot(u - 0.72, (v - 0.22) * h / w);
    const hill = 0.55 + 0.08 * Math.sin(u * 9) + 0.04 * Math.sin(u * 23 + 1);
    if (v > hill) {
      const t = (v - hill) / (0.78 - hill);
      const tex = 0.85 + 0.15 * Math.sin(x * 0.21) * Math.sin(y * 0.17);
      return [0.08 * tex * (1 - t * 0.3), 0.16 * tex, 0.05 * tex];
    }
    if (sun < 0.035) return [1, 0.97, 0.9];
    const glow = Math.exp(-sun * 14) * 0.6;
    const sky = 1 - v / hill;
    // personnage stylisé (tons chair)
    const face = Math.hypot(u - 0.3, (v - 0.4) * h / w);
    if (face < 0.06) return [0.48, 0.3, 0.22];
    return [0.18 + 0.1 * sky + glow, 0.3 + 0.15 * sky + glow * 0.8, 0.55 + 0.2 * sky + glow * 0.5];
  };
}

/** Négatif simulé : densité = base + γ·log E, transmission en sRGB 16 bits, bord non exposé. */
function negative(w: number, h: number, border: number, mono: boolean): Raster {
  const W = w + 2 * border, H = h + 2 * border;
  const r = createRaster(W, H, mono ? 1 : 3, 16);
  const base = [0.22, 0.58, 0.95], gamma = [0.62, 0.66, 0.7];
  const f = scene(w, h);
  const logMin = Math.log10(0.003);
  let seed = 1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inside = x >= border && x < W - border && y >= border && y < H - border;
      const c = inside ? f(x - border, y - border) : null;
      const L = c ? (mono ? [0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]] : c) : null;
      for (let k = 0; k < (mono ? 1 : 3); k++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const noise = ((seed >>> 16) / 65536 - 0.5) * 0.01;
        let d = mono ? 0.12 : base[k];
        if (L) d += (mono ? 0.7 : gamma[k]) * Math.max(0, Math.log10(L[k] + 0.003) - logMin) + noise;
        r.data[(y * W + x) * (mono ? 1 : 3) + k] = Math.round(linearToSrgb(Math.pow(10, -d)) * 65535);
      }
    }
  return r;
}

function positiveRGBA(w: number, h: number): Uint8Array {
  const f = scene(w, h);
  const buf = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = f(x, y);
      const o = (y * w + x) * 4;
      buf[o] = linearToSrgb(c[0]) * 255; buf[o + 1] = linearToSrgb(c[1]) * 255; buf[o + 2] = linearToSrgb(c[2]) * 255; buf[o + 3] = 255;
    }
  return buf;
}

function write(name: string, data: Uint8Array) {
  const p = join(out, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  console.log(`${name.padEnd(36)} ${(data.length / 1e6).toFixed(2)} Mo`);
}

const icc = buildSrgbIcc();
write('negatif-couleur.tif', encodeTiff(negative(1200, 800, 40, false), { compression: 'deflate', icc }));
write('negatif-nb.tif', encodeTiff(negative(1000, 800, 30, true), { compression: 'lzw' }));
write('negatif-couleur-8bits.tif', encodeTiff(negative(900, 600, 30, false), { bits: 8, compression: 'none' }));
write('positif.jpg', jpeg.encode({ data: positiveRGBA(1200, 800), width: 1200, height: 800 }, 90).data);
// Taille moyenne (≈ 6 Mpx) pour la mesure de réactivité.
write('moyenne-6mpx.tif', encodeTiff(negative(2960, 1960, 20, false), { compression: 'deflate' }));

const samples = join(root, 'public', 'samples');
mkdirSync(samples, { recursive: true });
for (const n of ['negatif-couleur.tif', 'negatif-nb.tif', 'positif.jpg']) copyFileSync(join(out, n), join(samples, n));

if (process.argv.includes('--big')) {
  // 7400 × 5400 ≈ 40 Mpx, 16 bits RVB : ≈ 240 Mo décodés.
  write('big/scan-40mpx.tif', encodeTiff(negative(7360, 5360, 20, false), { compression: 'deflate' }));
}
