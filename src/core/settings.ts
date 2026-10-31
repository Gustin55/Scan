import type { Curve } from './curves.ts';
import { IDENTITY_CURVE, normalizeCurve } from './curves.ts';
import { defaultGeometry, sanitizeGeometry, type Geometry } from './geometry.ts';

export type InputKind = 'auto' | 'positive' | 'negative-color' | 'negative-bw';
export type ResolvedKind = Exclude<InputKind, 'auto'>;
export type TransferOverride = 'profile' | 'srgb' | 'linear' | 'gamma22';
export type RGB = [number, number, number];

export interface InversionParams {
  /** Transmission du support (masque orange), linéaire, par canal. */
  base: RGB;
  /** Densités (log10 base/v) envoyées au noir et au blanc, par canal. */
  dmin: RGB;
  dmax: RGB;
  /** Gamma par canal appliqué après normalisation (balance des tons moyens). */
  gamma: RGB;
}

export interface GrainParams { amount: number; size: number; roughness: number; color: number; luminance: number }
export interface HalationParams { amount: number; radius: number; threshold: number }
export interface VignetteParams { amount: number; midpoint: number; feather: number }
export interface SharpenParams { amount: number }

export interface CurveSet { rgb: Curve; r: Curve; g: Curve; b: Curve }

export interface Settings {
  version: 1;
  input: { kind: InputKind; transfer: TransferOverride };
  /** Paramètres d'inversion ; `null` = calcul automatique à l'ouverture. */
  inversion: InversionParams | null;
  /** Réglage fin de l'inversion. */
  inversionAdjust: { blackPoint: number; whitePoint: number };
  presetId: string | null;
  intensity: number;
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  curves: CurveSet;
  /** `null` = valeur du préset (pondérée par l'intensité). */
  grain: GrainParams | null;
  halation: HalationParams | null;
  vignette: VignetteParams | null;
  sharpen: SharpenParams | null;
  /** Recadrage, rotation, miroir. */
  geometry: Geometry;
}

export const NEUTRAL_GRAIN: GrainParams = { amount: 0, size: 1, roughness: 0.5, color: 0, luminance: 0.6 };
export const NEUTRAL_HALATION: HalationParams = { amount: 0, radius: 0.4, threshold: 0.75 };
export const NEUTRAL_VIGNETTE: VignetteParams = { amount: 0, midpoint: 0.5, feather: 0.5 };
export const NEUTRAL_SHARPEN: SharpenParams = { amount: 0 };

export function defaultCurves(): CurveSet {
  const c = () => IDENTITY_CURVE.map((p) => [...p]) as Curve;
  return { rgb: c(), r: c(), g: c(), b: c() };
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    input: { kind: 'auto', transfer: 'profile' },
    inversion: null,
    inversionAdjust: { blackPoint: 0, whitePoint: 0 },
    presetId: null,
    intensity: 1,
    exposure: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    curves: defaultCurves(),
    grain: null,
    halation: null,
    vignette: null,
    sharpen: null,
    geometry: defaultGeometry(),
  };
}

/** Bornes et pas des réglages numériques (UI, validation, import JSON). */
export const RANGES = {
  intensity: { min: 0, max: 1, step: 0.01 },
  exposure: { min: -3, max: 3, step: 0.05 },
  contrast: { min: -100, max: 100, step: 1 },
  saturation: { min: -100, max: 100, step: 1 },
  temperature: { min: -100, max: 100, step: 1 },
  tint: { min: -100, max: 100, step: 1 },
  blackPoint: { min: -50, max: 50, step: 1 },
  whitePoint: { min: -50, max: 50, step: 1 },
  grainAmount: { min: 0, max: 1, step: 0.01 },
  grainSize: { min: 0.5, max: 4, step: 0.05 },
  grainRoughness: { min: 0, max: 1, step: 0.01 },
  grainColor: { min: 0, max: 1, step: 0.01 },
  grainLuminance: { min: 0, max: 1, step: 0.01 },
  halationAmount: { min: 0, max: 1, step: 0.01 },
  halationRadius: { min: 0.05, max: 1, step: 0.01 },
  halationThreshold: { min: 0.3, max: 0.98, step: 0.01 },
  vignetteAmount: { min: -1, max: 1, step: 0.01 },
  vignetteMidpoint: { min: 0, max: 1, step: 0.01 },
  vignetteFeather: { min: 0.05, max: 1, step: 0.01 },
  sharpenAmount: { min: 0, max: 2, step: 0.01 },
} as const;

const clampN = (v: unknown, lo: number, hi: number, def: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, n));
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const rgb = (v: unknown, lo: number, hi: number, def: number): RGB =>
  Array.isArray(v) && v.length === 3 ? (v.map((x) => clampN(x, lo, hi, def)) as RGB) : [def, def, def];

function curveFrom(v: unknown): Curve {
  if (!Array.isArray(v)) return IDENTITY_CURVE.map((p) => [...p]) as Curve;
  const pts = v.filter((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)));
  return normalizeCurve(pts.slice(0, 32) as Curve);
}

/** Valide et complète des réglages venant d'un JSON (valeurs inconnues ignorées, bornes appliquées). */
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const kinds: InputKind[] = ['auto', 'positive', 'negative-color', 'negative-bw'];
  const transfers: TransferOverride[] = ['profile', 'srgb', 'linear', 'gamma22'];
  const input = isObj(raw.input) ? raw.input : {};
  const s: Settings = {
    ...d,
    input: {
      kind: kinds.includes(input.kind as InputKind) ? (input.kind as InputKind) : 'auto',
      transfer: transfers.includes(input.transfer as TransferOverride) ? (input.transfer as TransferOverride) : 'profile',
    },
    presetId: typeof raw.presetId === 'string' ? raw.presetId : null,
    intensity: clampN(raw.intensity, 0, 1, 1),
    exposure: clampN(raw.exposure, RANGES.exposure.min, RANGES.exposure.max, 0),
    contrast: clampN(raw.contrast, -100, 100, 0),
    saturation: clampN(raw.saturation, -100, 100, 0),
    temperature: clampN(raw.temperature, -100, 100, 0),
    tint: clampN(raw.tint, -100, 100, 0),
  };
  if (isObj(raw.inversion)) {
    const inv = raw.inversion;
    s.inversion = {
      base: rgb(inv.base, 1e-4, 1, 1),
      dmin: rgb(inv.dmin, -1, 4, 0),
      dmax: rgb(inv.dmax, 0.01, 5, 1),
      gamma: rgb(inv.gamma, 0.2, 5, 1),
    };
  }
  if (isObj(raw.inversionAdjust)) {
    s.inversionAdjust = {
      blackPoint: clampN(raw.inversionAdjust.blackPoint, -50, 50, 0),
      whitePoint: clampN(raw.inversionAdjust.whitePoint, -50, 50, 0),
    };
  }
  if (isObj(raw.curves)) {
    s.curves = { rgb: curveFrom(raw.curves.rgb), r: curveFrom(raw.curves.r), g: curveFrom(raw.curves.g), b: curveFrom(raw.curves.b) };
  }
  if (isObj(raw.grain)) s.grain = sanitizeGrain(raw.grain);
  if (isObj(raw.halation)) s.halation = sanitizeHalation(raw.halation);
  if (isObj(raw.vignette)) s.vignette = sanitizeVignette(raw.vignette);
  if (isObj(raw.sharpen)) s.sharpen = { amount: clampN(raw.sharpen.amount, 0, 2, 0) };
  if (isObj(raw.geometry)) s.geometry = sanitizeGeometry(raw.geometry);
  return s;
}

export function sanitizeGrain(g: Record<string, unknown>): GrainParams {
  return {
    amount: clampN(g.amount, 0, 1, 0),
    size: clampN(g.size, RANGES.grainSize.min, RANGES.grainSize.max, 1),
    roughness: clampN(g.roughness, 0, 1, 0.5),
    color: clampN(g.color, 0, 1, 0),
    luminance: clampN(g.luminance, 0, 1, 0.6),
  };
}
export function sanitizeHalation(h: Record<string, unknown>): HalationParams {
  return {
    amount: clampN(h.amount, 0, 1, 0),
    radius: clampN(h.radius, RANGES.halationRadius.min, 1, 0.4),
    threshold: clampN(h.threshold, RANGES.halationThreshold.min, RANGES.halationThreshold.max, 0.75),
  };
}
export function sanitizeVignette(v: Record<string, unknown>): VignetteParams {
  return {
    amount: clampN(v.amount, -1, 1, 0),
    midpoint: clampN(v.midpoint, 0, 1, 0.5),
    feather: clampN(v.feather, RANGES.vignetteFeather.min, 1, 0.5),
  };
}

export function cloneSettings(s: Settings): Settings {
  return structuredClone(s);
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Réglages « copiables » vers une autre image : sans l'inversion mesurée ni le cadrage. */
export function transferableSettings(s: Settings): Settings {
  const c = cloneSettings(s);
  c.inversion = null;
  c.geometry = defaultGeometry();
  return c;
}

export interface SettingsFile {
  format: 'scan-pellicule/settings';
  version: 1;
  exportedAt: string;
  images: { name: string; fingerprint?: string; settings: Settings }[];
}

export function settingsToJson(images: SettingsFile['images']): string {
  const f: SettingsFile = { format: 'scan-pellicule/settings', version: 1, exportedAt: new Date().toISOString(), images };
  return JSON.stringify(f, null, 2);
}

export function settingsFromJson(text: string): SettingsFile['images'] {
  const raw = JSON.parse(text) as unknown;
  if (isObj(raw) && raw.format === 'scan-pellicule/settings' && Array.isArray(raw.images)) {
    return raw.images
      .filter(isObj)
      .map((im) => ({
        name: typeof im.name === 'string' ? im.name : '',
        fingerprint: typeof im.fingerprint === 'string' ? im.fingerprint : undefined,
        settings: sanitizeSettings(im.settings),
      }));
  }
  // Réglages nus
  if (isObj(raw) && raw.version === 1) return [{ name: '', settings: sanitizeSettings(raw) }];
  throw new Error('Ce fichier JSON ne contient pas de réglages reconnus.');
}
