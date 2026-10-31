import type { Curve } from './curves.ts';
import { normalizeCurve } from './curves.ts';
import type { GrainParams, HalationParams, SharpenParams, VignetteParams } from './settings.ts';
import { sanitizeGrain, sanitizeHalation, sanitizeVignette } from './settings.ts';

export type Mat3Like = [number, number, number, number, number, number, number, number, number];

export interface SplitTone { shadowsHue: number; shadowsAmount: number; highlightsHue: number; highlightsAmount: number }

/** Préset de film : décrit en JSON (voir src/presets/*.json et README). */
export interface FilmLook {
  id: string;
  name: string;
  description: string;
  category: 'couleur' | 'diapositive' | 'noir et blanc' | 'personnel';
  /** Poids R, V, B du passage en noir et blanc ; absent = couleur. */
  monochrome?: [number, number, number];
  /** Matrice de mélange des canaux (lignes), appliquée en linéaire. */
  mixer?: Mat3Like;
  temperature: number;
  tint: number;
  contrast: number;
  saturation: number;
  /** Relèvement des noirs, 0..0,3. */
  fade: number;
  curves: { rgb?: Curve; r?: Curve; g?: Curve; b?: Curve };
  split?: SplitTone;
  grain: GrainParams;
  halation: HalationParams;
  vignette: VignetteParams;
  sharpen: SharpenParams;
  builtin?: boolean;
}

const num = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

export class PresetError extends Error {}

/** Valide un préset JSON ; lève une PresetError lisible si les champs obligatoires manquent. */
export function parseFilmLook(raw: unknown): FilmLook {
  const r = obj(raw);
  if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) throw new PresetError('Préset : « id » doit être en minuscules, chiffres et tirets.');
  if (typeof r.name !== 'string' || !r.name.trim()) throw new PresetError(`Préset ${r.id} : « name » est obligatoire.`);
  const cats = ['couleur', 'diapositive', 'noir et blanc', 'personnel'];
  const category = cats.includes(r.category as string) ? (r.category as FilmLook['category']) : 'personnel';
  let monochrome: FilmLook['monochrome'];
  if (Array.isArray(r.monochrome) && r.monochrome.length === 3) {
    const m = r.monochrome.map((v) => num(v, -1, 2, 0));
    const s = m[0] + m[1] + m[2] || 1;
    monochrome = [m[0] / s, m[1] / s, m[2] / s];
  }
  let mixer: Mat3Like | undefined;
  if (Array.isArray(r.mixer) && r.mixer.length === 9) mixer = r.mixer.map((v) => num(v, -2, 2, 0)) as Mat3Like;
  const curvesRaw = obj(r.curves);
  const curves: FilmLook['curves'] = {};
  for (const k of ['rgb', 'r', 'g', 'b'] as const) {
    if (Array.isArray(curvesRaw[k])) curves[k] = normalizeCurve(curvesRaw[k] as Curve);
  }
  const sp = obj(r.split);
  const split: SplitTone | undefined = r.split
    ? {
        shadowsHue: num(sp.shadowsHue, 0, 360, 0),
        shadowsAmount: num(sp.shadowsAmount, 0, 1, 0),
        highlightsHue: num(sp.highlightsHue, 0, 360, 0),
        highlightsAmount: num(sp.highlightsAmount, 0, 1, 0),
      }
    : undefined;
  return {
    id: r.id,
    name: r.name.trim(),
    description: typeof r.description === 'string' ? r.description : '',
    category,
    monochrome,
    mixer,
    temperature: num(r.temperature, -100, 100, 0),
    tint: num(r.tint, -100, 100, 0),
    contrast: num(r.contrast, -100, 100, 0),
    saturation: num(r.saturation, -100, 100, 0),
    fade: num(r.fade, 0, 0.3, 0),
    curves,
    split,
    grain: sanitizeGrain(obj(r.grain)),
    halation: sanitizeHalation(obj(r.halation)),
    vignette: sanitizeVignette(obj(r.vignette)),
    sharpen: { amount: num(obj(r.sharpen).amount, 0, 2, 0) },
  };
}

const modules = import.meta.glob('../presets/*.json', { eager: true, import: 'default' });

export const BUILTIN_PRESETS: FilmLook[] = Object.values(modules)
  .map((m) => ({ ...parseFilmLook(m), builtin: true }))
  .sort((a, b) => order(a.category) - order(b.category) || a.name.localeCompare(b.name, 'fr'));

function order(c: FilmLook['category']) {
  return ['couleur', 'diapositive', 'noir et blanc', 'personnel'].indexOf(c);
}

export function findPreset(id: string | null, extra: FilmLook[] = []): FilmLook | undefined {
  if (!id) return undefined;
  return BUILTIN_PRESETS.find((p) => p.id === id) ?? extra.find((p) => p.id === id);
}

/** Crée un préset personnel à partir des réglages créatifs courants. */
export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'preset'
  );
}
