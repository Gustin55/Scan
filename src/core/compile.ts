import { IDENTITY3, linearToSrgb, luma, mulMat3, whiteBalanceGains, type Mat3 } from './color.ts';
import { contrastFn, curveEvaluator, isIdentityCurve, type Curve } from './curves.ts';
import type { InputColor } from './icc.ts';
import { defaultGeometry, type Geometry, type Rect } from './geometry.ts';
import type { FilmLook } from './presets.ts';
import {
  NEUTRAL_GRAIN, NEUTRAL_HALATION, NEUTRAL_SHARPEN, NEUTRAL_VIGNETTE,
  type GrainParams, type HalationParams, type InversionParams, type ResolvedKind, type RGB, type Settings,
  type SharpenParams, type VignetteParams,
} from './settings.ts';

export const TONE_LUT_SIZE = 1024;

/** Résultat de l'analyse automatique d'une image (proxy). */
export interface Analysis {
  detectedKind: ResolvedKind;
  /** Confiance de la détection, 0..1. */
  confidence: number;
  color: InversionParams;
  bw: InversionParams;
  /** Zone image détectée à l'intérieur du bord du film (négatifs), ou null. */
  frame?: Rect | null;
}

/** Paramètres de rendu « à plat », consommés par le shader et par le pipeline CPU. */
export interface Compiled {
  kind: ResolvedKind;
  /** 0 positif, 1 négatif couleur, 2 négatif N&B. */
  mode: 0 | 1 | 2;
  toSrgb: Mat3;
  /** TRC d'entrée, RGBA entrelacé, TRC_SIZE entrées. */
  trc: Float32Array;
  trcSize: number;
  base: RGB;
  dmin: RGB;
  drange: RGB;
  gamma: RGB;
  gains: RGB;
  mixer: Mat3;
  /** LUT de tonalité, RGBA entrelacé (A inutilisé). */
  tone: Float32Array;
  splitShadows: RGB;
  splitHighlights: RGB;
  saturation: number;
  halation: HalationParams;
  sharpen: SharpenParams;
  vignette: VignetteParams;
  grain: GrainParams;
  geometry: Geometry;
}

export const BW_WEIGHTS: RGB = [0.2126, 0.7152, 0.0722];

export function resolveKind(s: Settings, a: Analysis | undefined): ResolvedKind {
  if (s.input.kind !== 'auto') return s.input.kind;
  return a?.detectedKind ?? 'positive';
}

function lerpNum(a: number, b: number, t: number) { return a + (b - a) * t; }

function hueOffset(h: number, amount: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => 0.5 - 0.5 * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const c: RGB = [f(0), f(8), f(4)];
  const l = luma(c[0], c[1], c[2]);
  return [(c[0] - l) * amount * 0.5, (c[1] - l) * amount * 0.5, (c[2] - l) * amount * 0.5];
}

function blendCurve(c: Curve | undefined, k: number): (x: number) => number {
  if (!c || isIdentityCurve(c) || k <= 0) return (x) => x;
  const f = curveEvaluator(c);
  return (x) => x + (f(x) - x) * k;
}

function scaleEffect<T extends object>(user: T | null, preset: T | undefined, neutral: T, k: number, scaled: (keyof T)[]): T {
  if (user) return user;
  const p = preset ?? neutral;
  const out = { ...p };
  for (const key of scaled) (out[key] as number) = lerpNum(neutral[key] as number, p[key] as number, k);
  return out;
}

export function packTrc(color: InputColor): Float32Array {
  const n = color.trc[0].length;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = color.trc[0][i];
    out[i * 4 + 1] = color.trc[1][i];
    out[i * 4 + 2] = color.trc[2][i];
    out[i * 4 + 3] = 1;
  }
  return out;
}

export interface CompileInput {
  settings: Settings;
  look?: FilmLook;
  analysis?: Analysis;
  color: InputColor;
  /** TRC déjà empaquetée (évite de la recalculer à chaque rendu). */
  packedTrc?: Float32Array;
}

export function compile({ settings: s, look, analysis, color, packedTrc }: CompileInput): Compiled {
  const kind = resolveKind(s, analysis);
  const k = look ? s.intensity : 0;
  const mode = kind === 'positive' ? 0 : kind === 'negative-color' ? 1 : 2;

  // Inversion
  const inv: InversionParams =
    s.inversion ?? (kind === 'negative-bw' ? analysis?.bw : analysis?.color) ?? { base: [1, 1, 1], dmin: [0, 0, 0], dmax: [2, 2, 2], gamma: [1, 1, 1] };
  const dmin = [...inv.dmin] as RGB;
  const drange: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const range = inv.dmax[c] - inv.dmin[c];
    const lo = inv.dmin[c] + (s.inversionAdjust.blackPoint / 100) * range * 0.5;
    const hi = inv.dmax[c] - (s.inversionAdjust.whitePoint / 100) * range * 0.5;
    dmin[c] = lo;
    drange[c] = Math.max(0.02, hi - lo);
  }

  // Couleur
  const wb = whiteBalanceGains(s.temperature + (look?.temperature ?? 0) * k, s.tint + (look?.tint ?? 0) * k);
  const ev = Math.pow(2, s.exposure);
  const gains: RGB = [wb[0] * ev, wb[1] * ev, wb[2] * ev];
  let mixer: Mat3 = [...IDENTITY3] as Mat3;
  if (look?.mixer) mixer = mixer.map((v, i) => lerpNum(v, look.mixer![i], k)) as Mat3;
  if (look?.monochrome) {
    const [wr, wg, wb2] = look.monochrome;
    const mono: Mat3 = [wr, wg, wb2, wr, wg, wb2, wr, wg, wb2];
    mixer = mulMat3(mono.map((v, i) => lerpNum(IDENTITY3[i], v, k)) as Mat3, mixer);
  }

  // Tonalité : contraste → courbes du préset → noirs → courbes utilisateur
  const contrast = contrastFn(s.contrast + (look?.contrast ?? 0) * k);
  const pMaster = blendCurve(look?.curves.rgb, k);
  const pCh = [blendCurve(look?.curves.r, k), blendCurve(look?.curves.g, k), blendCurve(look?.curves.b, k)];
  const fade = (look?.fade ?? 0) * k;
  const uMaster = isIdentityCurve(s.curves.rgb) ? (x: number) => x : curveEvaluator(s.curves.rgb);
  const uCh = [s.curves.r, s.curves.g, s.curves.b].map((c) => (isIdentityCurve(c) ? (x: number) => x : curveEvaluator(c)));
  const tone = new Float32Array(TONE_LUT_SIZE * 4);
  for (let i = 0; i < TONE_LUT_SIZE; i++) {
    const x = i / (TONE_LUT_SIZE - 1);
    const xc = contrast(x);
    const m = pMaster(xc);
    for (let c = 0; c < 3; c++) {
      let v = pCh[c](m);
      v = fade + v * (1 - fade);
      v = uCh[c](uMaster(v));
      tone[i * 4 + c] = v;
    }
    tone[i * 4 + 3] = 1;
  }

  const split = look?.split;
  const splitShadows = split ? hueOffset(split.shadowsHue, split.shadowsAmount * k) : ([0, 0, 0] as RGB);
  const splitHighlights = split ? hueOffset(split.highlightsHue, split.highlightsAmount * k) : ([0, 0, 0] as RGB);
  const saturation = Math.max(0, (1 + s.saturation / 100) * (1 + ((look?.saturation ?? 0) / 100) * k));

  return {
    kind,
    mode,
    toSrgb: color.toSrgb,
    trc: packedTrc ?? packTrc(color),
    trcSize: color.trc[0].length,
    base: [...inv.base] as RGB,
    dmin,
    drange,
    gamma: [...inv.gamma] as RGB,
    gains,
    mixer,
    tone,
    splitShadows,
    splitHighlights,
    saturation,
    grain: scaleEffect(s.grain, look?.grain, NEUTRAL_GRAIN, k, ['amount', 'color']),
    halation: scaleEffect(s.halation, look?.halation, NEUTRAL_HALATION, k, ['amount']),
    vignette: scaleEffect(s.vignette, look?.vignette, NEUTRAL_VIGNETTE, k, ['amount']),
    sharpen: scaleEffect(s.sharpen, look?.sharpen, NEUTRAL_SHARPEN, k, ['amount']),
    geometry: s.geometry ?? defaultGeometry(),
  };
}

/** Valeurs effectives des effets (pour afficher « valeur du préset » dans l'UI). */
export function effectiveEffects(s: Settings, look?: FilmLook) {
  const k = look ? s.intensity : 0;
  return {
    grain: scaleEffect(s.grain, look?.grain, NEUTRAL_GRAIN, k, ['amount', 'color']),
    halation: scaleEffect(s.halation, look?.halation, NEUTRAL_HALATION, k, ['amount']),
    vignette: scaleEffect(s.vignette, look?.vignette, NEUTRAL_VIGNETTE, k, ['amount']),
    sharpen: scaleEffect(s.sharpen, look?.sharpen, NEUTRAL_SHARPEN, k, ['amount']),
  };
}

export { linearToSrgb };
