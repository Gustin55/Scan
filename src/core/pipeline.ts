/**
 * Pipeline de rendu CPU : référence exacte du shader (src/gl/shaders/*.glsl).
 * Utilisé pour l'export pleine résolution, les miniatures et les tests.
 */
import { luma, smoothstep } from './color.ts';
import type { Compiled } from './compile.ts';
import { TONE_LUT_SIZE } from './compile.ts';
import { grainNoise } from './noise.ts';
import type { Raster } from './raster.ts';

const LOG10 = Math.LN10;

/** Échelle du grain : nombre de cellules sur le petit côté pour une taille 1. */
export const GRAIN_CELLS = 1600;

function lut(t: Float32Array, size: number, c: number, v: number): number {
  const x = (v < 0 ? 0 : v > 1 ? 1 : v) * (size - 1);
  const i = x | 0;
  if (i >= size - 1) return t[(size - 1) * 4 + c];
  const f = x - i;
  const a = t[i * 4 + c];
  return a + (t[(i + 1) * 4 + c] - a) * f;
}

function encodeSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
function decodeSrgb(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Étape 1 : entrée encodée (0..1) → couleur affichable avant effets spatiaux.
 * Écrit 3 valeurs dans `out` à partir de `o`.
 */
export function stage1(c: Compiled, r: number, g: number, b: number, out: Float32Array, o: number): void {
  const n = c.trcSize;
  const lr = lut(c.trc, n, 0, r), lg = lut(c.trc, n, 1, g), lb = lut(c.trc, n, 2, b);
  const M = c.toSrgb;
  let x = M[0] * lr + M[1] * lg + M[2] * lb;
  let y = M[3] * lr + M[4] * lg + M[5] * lb;
  let z = M[6] * lr + M[7] * lg + M[8] * lb;

  if (c.mode !== 0) {
    if (c.mode === 2) {
      const l = Math.max(1e-6, 0.2126 * x + 0.7152 * y + 0.0722 * z);
      x = y = z = l;
    }
    // Densité au-dessus du support, normalisée, puis gamma par canal.
    let p = Math.log(c.base[0] / Math.max(1e-6, x)) / LOG10;
    let q = (p - c.dmin[0]) / c.drange[0];
    x = decodeSrgb(Math.pow(q < 0 ? 0 : q, c.gamma[0]));
    p = Math.log(c.base[1] / Math.max(1e-6, y)) / LOG10;
    q = (p - c.dmin[1]) / c.drange[1];
    y = decodeSrgb(Math.pow(q < 0 ? 0 : q, c.gamma[1]));
    p = Math.log(c.base[2] / Math.max(1e-6, z)) / LOG10;
    q = (p - c.dmin[2]) / c.drange[2];
    z = decodeSrgb(Math.pow(q < 0 ? 0 : q, c.gamma[2]));
  }

  stageTail(c, x, y, z, out, o);
}

/**
 * Table 16 bits → valeur linéaire après inversion, par canal. Valable seulement si les
 * canaux sont indépendants (pas de matrice d'entrée, pas de N&B) : accélère l'export.
 */
export function buildInputLut(c: Compiled): [Float32Array, Float32Array, Float32Array] | null {
  const M = c.toSrgb;
  const identity = M.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-6);
  if (!identity || c.mode === 2) return null;
  const luts: Float32Array[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const t = new Float32Array(65536);
    for (let v = 0; v < 65536; v++) {
      let x = lut(c.trc, c.trcSize, ch, v / 65535);
      if (c.mode === 1) {
        const p = Math.log(c.base[ch] / Math.max(1e-6, x)) / LOG10;
        const q = (p - c.dmin[ch]) / c.drange[ch];
        x = decodeSrgb(Math.pow(q < 0 ? 0 : q, c.gamma[ch]));
      }
      t[v] = x;
    }
    luts.push(t);
  }
  return luts as [Float32Array, Float32Array, Float32Array];
}

/** Fin de l'étape 1, à partir de valeurs linéaires (après inversion). */
export function stageTail(c: Compiled, x: number, y: number, z: number, out: Float32Array, o: number): void {
  x *= c.gains[0]; y *= c.gains[1]; z *= c.gains[2];
  const X = c.mixer;
  const lr = X[0] * x + X[1] * y + X[2] * z;
  const lg = X[3] * x + X[4] * y + X[5] * z;
  const lb = X[6] * x + X[7] * y + X[8] * z;

  let er = lut(c.tone, TONE_LUT_SIZE, 0, encodeSrgb(lr));
  let eg = lut(c.tone, TONE_LUT_SIZE, 1, encodeSrgb(lg));
  let eb = lut(c.tone, TONE_LUT_SIZE, 2, encodeSrgb(lb));

  const l = luma(er, eg, eb);
  const ws = (1 - l) * (1 - l);
  const wh = l * l;
  er += c.splitShadows[0] * ws + c.splitHighlights[0] * wh;
  eg += c.splitShadows[1] * ws + c.splitHighlights[1] * wh;
  eb += c.splitShadows[2] * ws + c.splitHighlights[2] * wh;

  const l2 = luma(er, eg, eb);
  out[o] = l2 + (er - l2) * c.saturation;
  out[o + 1] = l2 + (eg - l2) * c.saturation;
  out[o + 2] = l2 + (eb - l2) * c.saturation;
}

/** Carte de halo basse résolution (luminance floutée des hautes lumières). */
export interface HalationMap { width: number; height: number; data: Float32Array }

export function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/** Sigma du flou de halo en pixels de la carte. */
export function halationSigma(c: Compiled, mapW: number, mapH: number): number {
  return Math.max(0.5, c.halation.radius * 0.035 * Math.max(mapW, mapH));
}

export function buildHalationMap(proxy: Raster, c: Compiled): HalationMap | undefined {
  if (c.halation.amount <= 0) return undefined;
  const { width: w, height: h } = proxy;
  const mask = new Float32Array(w * h);
  const tmp = new Float32Array(3);
  const ch = proxy.channels;
  for (let i = 0; i < w * h; i++) {
    const s = i * ch;
    const r = proxy.data[s] / 65535;
    const g = ch === 3 ? proxy.data[s + 1] / 65535 : r;
    const b = ch === 3 ? proxy.data[s + 2] / 65535 : r;
    stage1(c, r, g, b, tmp, 0);
    mask[i] = smoothstep(c.halation.threshold, 1, luma(tmp[0], tmp[1], tmp[2]));
  }
  const k = gaussianKernel(halationSigma(c, w, h));
  const rad = (k.length - 1) / 2;
  const pass = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        s += mask[y * w + xx] * k[i + rad];
      }
      pass[y * w + x] = s;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        s += pass[yy * w + x] * k[i + rad];
      }
      mask[y * w + x] = s;
    }
  return { width: w, height: h, data: mask };
}

/** Échantillonnage bilinéaire, coordonnées normalisées (centre des texels comme en GL). */
export function sampleMap(m: HalationMap, u: number, v: number): number {
  const x = Math.min(m.width - 1, Math.max(0, u * m.width - 0.5));
  const y = Math.min(m.height - 1, Math.max(0, v * m.height - 0.5));
  const x0 = x | 0, y0 = y | 0;
  const x1 = Math.min(m.width - 1, x0 + 1), y1 = Math.min(m.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const d = m.data, w = m.width;
  const a = d[y0 * w + x0] + (d[y0 * w + x1] - d[y0 * w + x0]) * fx;
  const b = d[y1 * w + x0] + (d[y1 * w + x1] - d[y1 * w + x0]) * fx;
  return a + (b - a) * fy;
}

export const HALATION_TINT = [1.0, 0.32, 0.12] as const;

export interface FinishContext {
  c: Compiled;
  width: number;
  height: number;
  halation?: HalationMap;
}

/**
 * Étape 2 : netteté, halo, vignettage, grain. `center` et les voisins sont les sorties
 * de l'étape 1 ; écrit le résultat (0..1) dans `out`.
 */
export function finish(
  ctx: FinishContext, px: number, py: number,
  rows: [Float32Array, Float32Array, Float32Array], out: Float32Array, o: number,
): void {
  const { c, width: W, height: H } = ctx;
  const cur = rows[1];
  const i = px * 3;
  let r = cur[i], g = cur[i + 1], b = cur[i + 2];

  if (c.sharpen.amount > 0) {
    const il = Math.max(0, px - 1) * 3, ir = Math.min(W - 1, px + 1) * 3;
    const lc = luma(r, g, b);
    const ln = luma(rows[0][i], rows[0][i + 1], rows[0][i + 2]);
    const ls = luma(rows[2][i], rows[2][i + 1], rows[2][i + 2]);
    const le = luma(cur[ir], cur[ir + 1], cur[ir + 2]);
    const lw = luma(cur[il], cur[il + 1], cur[il + 2]);
    const d = (lc - (ln + ls + le + lw) * 0.25) * c.sharpen.amount;
    r += d; g += d; b += d;
  }

  const u = (px + 0.5) / W, v = (py + 0.5) / H;

  if (ctx.halation && c.halation.amount > 0) {
    const h = sampleMap(ctx.halation, u, v) * c.halation.amount * 1.5;
    r = 1 - (1 - clamp(r)) * (1 - h * HALATION_TINT[0]);
    g = 1 - (1 - clamp(g)) * (1 - h * HALATION_TINT[1]);
    b = 1 - (1 - clamp(b)) * (1 - h * HALATION_TINT[2]);
  }

  if (c.vignette.amount !== 0) {
    const m = Math.max(W, H);
    const sx = W / m, sy = H / m;
    const dx = (u - 0.5) * 2 * sx, dy = (v - 0.5) * 2 * sy;
    const d = Math.sqrt(dx * dx + dy * dy) / Math.sqrt(sx * sx + sy * sy);
    const mid = c.vignette.midpoint;
    const t = smoothstep(mid, Math.min(1.5, mid + c.vignette.feather), d);
    const a = c.vignette.amount;
    if (a > 0) {
      const f = 1 - a * t;
      r *= f; g *= f; b *= f;
    } else {
      const f = -a * t;
      r += (1 - r) * f; g += (1 - g) * f; b += (1 - b) * f;
    }
  }

  const gr = c.grain;
  if (gr.amount > 0) {
    const scale = GRAIN_CELLS / (gr.size * Math.min(W, H));
    const gx = (px + 0.5) * scale, gy = (py + 0.5) * scale;
    const l = clamp(luma(r, g, b));
    const mid = 4 * l * (1 - l);
    const w = (1 - gr.luminance) + gr.luminance * mid;
    const s = gr.amount * 0.16 * w;
    const n = grainNoise(gx, gy, gr.roughness, 1);
    if (gr.color > 0) {
      const nr = grainNoise(gx, gy, gr.roughness, 2);
      const ng = grainNoise(gx, gy, gr.roughness, 3);
      const nb = grainNoise(gx, gy, gr.roughness, 4);
      r += (n + (nr - n) * gr.color) * s;
      g += (n + (ng - n) * gr.color) * s;
      b += (n + (nb - n) * gr.color) * s;
    } else {
      r += n * s; g += n * s; b += n * s;
    }
  }

  out[o] = clamp(r);
  out[o + 1] = clamp(g);
  out[o + 2] = clamp(b);
}

function clamp(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export interface RenderOptions {
  halation?: HalationMap;
  /** Sortie : 'rgba8' (pour un canvas) ou 'rgb16'. */
  output: 'rgba8' | 'rgb16';
  onProgress?: (p: number) => void;
  /** Vérifié régulièrement ; renvoyer true interrompt le rendu. */
  shouldAbort?: () => boolean;
}

export class RenderAborted extends Error {
  constructor() { super('Rendu annulé'); }
}

/**
 * Rend un raster complet, ligne par ligne (fenêtre de 3 lignes pour la netteté) :
 * la mémoire supplémentaire est limitée au tampon de sortie.
 */
export function renderRaster(src: Raster, c: Compiled, opts: RenderOptions): Uint8ClampedArray | Uint16Array {
  const { width: W, height: H, channels: ch } = src;
  const out = opts.output === 'rgba8' ? new Uint8ClampedArray(W * H * 4) : new Uint16Array(W * H * 3);
  const inLut = W * H > 250_000 ? buildInputLut(c) : null;
  const rowOf = (y: number, buf: Float32Array) => {
    const base = y * W * ch;
    const d = src.data;
    if (inLut) {
      const [lr, lg, lb] = inLut;
      for (let x = 0; x < W; x++) {
        const s = base + x * ch;
        if (ch === 3) stageTail(c, lr[d[s]], lg[d[s + 1]], lb[d[s + 2]], buf, x * 3);
        else stageTail(c, lr[d[s]], lg[d[s]], lb[d[s]], buf, x * 3);
      }
      return;
    }
    for (let x = 0; x < W; x++) {
      const s = base + x * ch;
      const r = d[s] / 65535;
      if (ch === 3) stage1(c, r, d[s + 1] / 65535, d[s + 2] / 65535, buf, x * 3);
      else stage1(c, r, r, r, buf, x * 3);
    }
  };
  let prev = new Float32Array(W * 3);
  let cur = new Float32Array(W * 3);
  let next = new Float32Array(W * 3);
  rowOf(0, cur);
  prev.set(cur);
  if (H > 1) rowOf(1, next); else next.set(cur);
  const px = new Float32Array(3);
  const ctx: FinishContext = { c, width: W, height: H, halation: opts.halation };
  const rows: [Float32Array, Float32Array, Float32Array] = [prev, cur, next];
  for (let y = 0; y < H; y++) {
    rows[0] = prev; rows[1] = cur; rows[2] = next;
    for (let x = 0; x < W; x++) {
      finish(ctx, x, y, rows, px, 0);
      if (opts.output === 'rgba8') {
        const o = (y * W + x) * 4;
        out[o] = px[0] * 255 + 0.5;
        out[o + 1] = px[1] * 255 + 0.5;
        out[o + 2] = px[2] * 255 + 0.5;
        out[o + 3] = 255;
      } else {
        const o = (y * W + x) * 3;
        out[o] = px[0] * 65535 + 0.5;
        out[o + 1] = px[1] * 65535 + 0.5;
        out[o + 2] = px[2] * 65535 + 0.5;
      }
    }
    const recycled = prev;
    prev = cur;
    cur = next;
    next = recycled;
    if (y + 2 < H) rowOf(y + 2, next); else next.set(cur);
    if ((y & 31) === 0) {
      if (opts.shouldAbort?.()) throw new RenderAborted();
      opts.onProgress?.(y / H);
    }
  }
  opts.onProgress?.(1);
  return out;
}
