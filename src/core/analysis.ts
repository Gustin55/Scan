import type { Analysis } from './compile.ts';
import type { InputColor } from './icc.ts';
import type { Raster } from './raster.ts';
import type { InversionParams, RGB } from './settings.ts';

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

function lutLookup(t: Float32Array, v: number): number {
  const n = t.length;
  const x = Math.min(1, Math.max(0, v)) * (n - 1);
  const i = x | 0;
  if (i >= n - 1) return t[n - 1];
  return t[i] + (t[i + 1] - t[i]) * (x - i);
}

/** Convertit le proxy en sRGB linéaire (même calcul que le début de l'étape 1). */
export function toLinear(proxy: Raster, color: InputColor): Float32Array {
  const n = proxy.width * proxy.height;
  const out = new Float32Array(n * 3);
  const M = color.toSrgb;
  const ch = proxy.channels;
  for (let i = 0; i < n; i++) {
    const s = i * ch;
    const r = proxy.data[s] / 65535;
    const g = ch === 3 ? proxy.data[s + 1] / 65535 : r;
    const b = ch === 3 ? proxy.data[s + 2] / 65535 : r;
    const lr = lutLookup(color.trc[0], r), lg = lutLookup(color.trc[1], g), lb = lutLookup(color.trc[2], b);
    out[i * 3] = M[0] * lr + M[1] * lg + M[2] * lb;
    out[i * 3 + 1] = M[3] * lr + M[4] * lg + M[5] * lb;
    out[i * 3 + 2] = M[6] * lr + M[7] * lg + M[8] * lb;
  }
  return out;
}

/** Indices des pixels d'une bande périphérique (fraction `band` de chaque bord). */
function borderMask(w: number, h: number, band: number): Uint8Array {
  const m = new Uint8Array(w * h);
  const bx = Math.max(1, Math.round(w * band));
  const by = Math.max(1, Math.round(h * band));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (x < bx || x >= w - bx || y < by || y >= h - by) m[y * w + x] = 1;
  return m;
}

const LOG10 = Math.LN10;

/** Part de la correction « monde gris » des tons moyens (0 = aucune, 1 = complète). */
export const GRAY_WORLD_STRENGTH = 0.35;

/**
 * Estime la transmission du support (masque orange) : pixels les plus clairs du bord
 * non exposé, en écartant la lumière directe (pixels saturés). Sans bord exploitable,
 * on se rabat sur les pixels les plus clairs de toute l'image.
 */
export function estimateBase(lin: Float32Array, w: number, h: number, mono: boolean): { base: RGB; fromBorder: boolean } {
  const border = borderMask(w, h, 0.04);
  const pick = (useBorder: boolean) => {
    const lumArr: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < w * h; i++) {
      if (useBorder && !border[i]) continue;
      const r = lin[i * 3], g = lin[i * 3 + 1], b = lin[i * 3 + 2];
      if (r > 0.985 && g > 0.985 && b > 0.985) continue; // lumière directe
      lumArr.push(mono ? (r + g + b) / 3 : 0.2126 * r + 0.7152 * g + 0.0722 * b);
      idx.push(i);
    }
    // Float32 partout : les comparaisons au seuil (lui aussi Float32) restent exactes.
    return { lum: Float32Array.from(lumArr), idx };
  };
  let { lum, idx } = pick(true);
  let fromBorder = true;
  const sortedAll = Float32Array.from(pick(false).lum).sort();
  const sortedBorder = lum.slice().sort();
  // Un bord de film non exposé doit être au moins aussi clair que l'image elle-même.
  if (lum.length < 16 || percentile(sortedBorder, 0.97) < percentile(sortedAll, 0.99) * 0.92) {
    ({ lum, idx } = pick(false));
    fromBorder = false;
  }
  const sorted = lum.slice().sort();
  const thr = percentile(sorted, fromBorder ? 0.85 : 0.995);
  let r = 0, g = 0, b = 0, n = 0;
  for (let k = 0; k < idx.length; k++) {
    if (lum[k] < thr) continue;
    const i = idx[k];
    r += lin[i * 3]; g += lin[i * 3 + 1]; b += lin[i * 3 + 2]; n++;
  }
  if (!n) return { base: [1, 1, 1], fromBorder };
  const base: RGB = [r / n, g / n, b / n].map((v) => Math.max(1e-4, Math.min(1, v))) as RGB;
  if (mono) { const m = (base[0] + base[1] + base[2]) / 3; return { base: [m, m, m], fromBorder }; }
  return { base, fromBorder };
}

/**
 * Calcule les paramètres d'inversion : densités par canal, niveaux automatiques
 * (percentiles), puis gamma par canal pour équilibrer les tons moyens.
 */
export function estimateInversion(lin: Float32Array, w: number, h: number, mono: boolean): InversionParams {
  const { base, fromBorder } = estimateBase(lin, w, h, mono);
  const border = fromBorder ? borderMask(w, h, 0.06) : new Uint8Array(w * h);
  const count = w * h;
  const dens: Float32Array[] = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (border[i]) continue;
    let r = lin[i * 3], g = lin[i * 3 + 1], b = lin[i * 3 + 2];
    if (mono) r = g = b = Math.max(1e-6, 0.2126 * r + 0.7152 * g + 0.0722 * b);
    dens[0][n] = Math.log(base[0] / Math.max(1e-6, r)) / LOG10;
    dens[1][n] = Math.log(base[1] / Math.max(1e-6, g)) / LOG10;
    dens[2][n] = Math.log(base[2] / Math.max(1e-6, b)) / LOG10;
    n++;
  }
  const dmin: RGB = [0, 0, 0], dmax: RGB = [1, 1, 1], gamma: RGB = [1, 1, 1];
  const med: RGB = [0.5, 0.5, 0.5];
  for (let c = 0; c < 3; c++) {
    const s = dens[c].subarray(0, n).slice().sort();
    dmin[c] = Math.max(-0.05, percentile(s, 0.002));
    dmax[c] = Math.max(dmin[c] + 0.05, percentile(s, 0.998));
    const m = (percentile(s, 0.5) - dmin[c]) / (dmax[c] - dmin[c]);
    med[c] = Math.min(0.95, Math.max(0.05, m));
  }
  // Tons moyens : un gamma commun amène la médiane vers un gris moyen ; la correction
  // par canal (« monde gris ») n'est appliquée qu'à 35 %, car les niveaux par canal
  // neutralisent déjà le masque, et une scène dominée par une couleur (ciel, feuillage)
  // serait sinon décolorée.
  const geo = Math.cbrt(med[0] * med[1] * med[2]);
  const target = Math.min(0.55, Math.max(0.32, 0.5 * geo + 0.5 * 0.46));
  const common = Math.log(target) / Math.log(geo);
  for (let c = 0; c < 3; c++) {
    const own = Math.log(target) / Math.log(med[c]);
    const g = common * Math.pow(own / common, GRAY_WORLD_STRENGTH);
    gamma[c] = Math.min(2.5, Math.max(0.4, g));
  }
  if (mono) {
    return { base, dmin: [dmin[1], dmin[1], dmin[1]], dmax: [dmax[1], dmax[1], dmax[1]], gamma: [gamma[1], gamma[1], gamma[1]] };
  }
  return { base, dmin, dmax, gamma };
}

/**
 * Détecte un négatif couleur : dominante orange marquée (rouge > vert > bleu) sur
 * l'ensemble de l'image. Les autres images sont traitées comme des positifs.
 */
export function detectKind(lin: Float32Array, w: number, h: number): { kind: Analysis['detectedKind']; confidence: number } {
  const n = w * h;
  const step = Math.max(1, Math.floor(n / 20000));
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let i = 0; i < n; i += step) { rs.push(lin[i * 3]); gs.push(lin[i * 3 + 1]); bs.push(lin[i * 3 + 2]); }
  const med = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 1e-6; };
  const r = med(rs), g = med(gs), b = med(bs);
  const rg = g / Math.max(1e-6, r);
  const gb = b / Math.max(1e-6, g);
  // Un masque orange donne typiquement V/R ≈ 0,4–0,75 et B/V ≈ 0,3–0,7.
  const orange = rg < 0.8 && gb < 0.8 && r > 0.04;
  const score = Math.min(1, Math.max(0, (0.85 - rg) * 2.5) * Math.min(1, Math.max(0, (0.85 - gb) * 2.5)));
  if (orange) return { kind: 'negative-color', confidence: Math.max(0.5, score) };
  // Négatif N&B : image neutre dont le bord (support clair non exposé) est plus lumineux
  // que presque toute l'image. Sans bord visible, on ne peut pas trancher : positif.
  const neutral = Math.abs(rg - 1) < 0.06 && Math.abs(gb - 1) < 0.06;
  if (neutral) {
    const border = borderMask(w, h, 0.03);
    const inner: number[] = [], edge: number[] = [];
    for (let i = 0; i < n; i += step) (border[i] ? edge : inner).push(lin[i * 3 + 1]);
    for (let i = 0; i < n; i++) if (border[i] && (i % 7 === 0)) edge.push(lin[i * 3 + 1]);
    const pct = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))] ?? 0; };
    if (edge.length > 8 && inner.length > 8 && pct(edge, 0.5) > pct(inner, 0.95) * 0.98 && pct(edge, 0.5) > 0.05) {
      return { kind: 'negative-bw', confidence: 0.6 };
    }
  }
  return { kind: 'positive', confidence: 1 - score };
}

export function analyze(proxy: Raster, color: InputColor): Analysis {
  const lin = toLinear(proxy, color);
  const { width: w, height: h } = proxy;
  const det = detectKind(lin, w, h);
  return {
    detectedKind: det.kind,
    confidence: det.confidence,
    color: estimateInversion(lin, w, h, false),
    bw: estimateInversion(lin, w, h, true),
  };
}
