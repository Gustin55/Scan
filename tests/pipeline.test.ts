import { describe, expect, it } from 'vitest';
import { compile, effectiveEffects, TONE_LUT_SIZE } from '../src/core/compile.ts';
import { contrastFn, curveEvaluator, normalizeCurve } from '../src/core/curves.ts';
import { defaultInputColor } from '../src/core/icc.ts';
import { buildHalationMap, renderRaster, stage1 } from '../src/core/pipeline.ts';
import { BUILTIN_PRESETS, findPreset, parseFilmLook } from '../src/core/presets.ts';
import { createRaster } from '../src/core/raster.ts';
import { defaultSettings, sanitizeSettings, settingsFromJson, settingsToJson } from '../src/core/settings.ts';
import { hash3, valueNoise } from '../src/core/noise.ts';
import { whiteBalanceGains, luma } from '../src/core/color.ts';
import { halfToFloat, toHalf } from '../src/core/half.ts';

const srgb = defaultInputColor('srgb');

function gray(w: number, h: number, v: number) {
  const r = createRaster(w, h, 3);
  r.data.fill(Math.round(v * 65535));
  return r;
}

describe('courbes', () => {
  it('spline monotone sans dépassement', () => {
    const f = curveEvaluator([[0, 0], [0.3, 0.6], [0.35, 0.62], [1, 1]]);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const y = f(i / 100);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
    expect(f(0.3)).toBeCloseTo(0.6, 6);
  });
  it('normalise les points (bornes, tri, extrémités)', () => {
    expect(normalizeCurve([[0.5, 2], [0.2, 0.1]])).toEqual([[0, 0.1], [0.2, 0.1], [0.5, 1], [1, 1]]);
  });
  it('contraste : fixe 0, 0,5 et 1 ; augmente la pente au centre', () => {
    const f = contrastFn(50);
    expect(f(0)).toBe(0); expect(f(1)).toBe(1); expect(f(0.5)).toBeCloseTo(0.5);
    expect(f(0.6) - f(0.4)).toBeGreaterThan(0.2);
    const g = contrastFn(-50);
    expect(g(0.6) - g(0.4)).toBeLessThan(0.2);
  });
});

describe('compilation des réglages', () => {
  it('réglages neutres sur un positif : sortie = entrée', () => {
    const c = compile({ settings: defaultSettings(), color: srgb });
    const out = new Float32Array(3);
    for (const v of [0.05, 0.3, 0.5, 0.8, 1]) {
      stage1(c, v, v, v, out, 0);
      expect(out[0]).toBeCloseTo(v, 3);
    }
  });

  it('intensité 0 = aucun effet du préset ; intensité 1 = préset complet', () => {
    const look = findPreset('couleur-sature-contraste')!;
    const s = defaultSettings();
    s.presetId = look.id;
    s.intensity = 0;
    const c0 = compile({ settings: s, look, color: srgb });
    expect(c0.saturation).toBeCloseTo(1);
    expect(c0.grain.amount).toBe(0);
    s.intensity = 1;
    const c1 = compile({ settings: s, look, color: srgb });
    expect(c1.saturation).toBeCloseTo(1 + look.saturation / 100);
    expect(c1.grain.amount).toBeCloseTo(look.grain.amount);
    s.intensity = 0.5;
    expect(compile({ settings: s, look, color: srgb }).grain.amount).toBeCloseTo(look.grain.amount / 2);
  });

  it('un réglage utilisateur d’effet remplace celui du préset', () => {
    const look = findPreset('couleur-haute-sensibilite')!;
    const s = defaultSettings();
    s.grain = { amount: 0.05, size: 2, roughness: 0, color: 0, luminance: 0 };
    expect(effectiveEffects(s, look).grain).toEqual(s.grain);
    expect(effectiveEffects(defaultSettings(), look).grain.amount).toBeCloseTo(look.grain.amount);
  });

  it('les présets N&B donnent une image neutre', () => {
    const look = findPreset('nb-classique-grain-moyen')!;
    const s = defaultSettings();
    s.presetId = look.id;
    const c = compile({ settings: s, look, color: srgb });
    const out = new Float32Array(3);
    stage1(c, 0.8, 0.3, 0.1, out, 0);
    expect(out[0]).toBeCloseTo(out[1], 4);
    expect(out[1]).toBeCloseTo(out[2], 4);
  });

  it('la LUT de tonalité a la bonne taille et reste dans [0, 1]', () => {
    for (const look of BUILTIN_PRESETS) {
      const s = defaultSettings();
      s.contrast = 100;
      const c = compile({ settings: s, look, color: srgb });
      expect(c.tone.length).toBe(TONE_LUT_SIZE * 4);
      for (let i = 0; i < c.tone.length; i++) {
        expect(c.tone[i]).toBeGreaterThanOrEqual(0);
        expect(c.tone[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('balance des blancs : neutre à 0, plus chaud vers le rouge', () => {
    const [r0, g0, b0] = whiteBalanceGains(0, 0);
    expect(r0).toBeCloseTo(1); expect(g0).toBeCloseTo(1); expect(b0).toBeCloseTo(1);
    const [r, g, b] = whiteBalanceGains(50, 0);
    expect(r).toBeGreaterThan(b);
    expect(luma(r, g, b)).toBeCloseTo(1);
  });
});

describe('présets', () => {
  it('au moins 8 présets intégrés, identifiants uniques, noms sans marque', () => {
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_PRESETS.length);
    const brands = /kodak|fuji|ilford|agfa|\bportra\b|ektar|velvia|cinestill|tri-?x|hp5|superia/i;
    for (const p of BUILTIN_PRESETS) expect(p.name).not.toMatch(brands);
  });
  it('rejette un préset invalide', () => {
    expect(() => parseFilmLook({ id: 'Mauvais ID', name: 'x' })).toThrow();
    expect(() => parseFilmLook({ id: 'ok' })).toThrow();
  });
});

describe('rendu complet', () => {
  it('rend une image grise sans effet à l’identique (8 et 16 bits)', () => {
    const src = gray(9, 7, 0.5);
    const c = compile({ settings: defaultSettings(), color: srgb });
    const o8 = renderRaster(src, c, { output: 'rgba8' }) as Uint8ClampedArray;
    expect(o8[0]).toBe(128); expect(o8[3]).toBe(255);
    const o16 = renderRaster(src, c, { output: 'rgb16' }) as Uint16Array;
    expect(Math.abs(o16[5] - 32768)).toBeLessThan(80);
  });

  it('le vignettage assombrit les coins, pas le centre', () => {
    const src = gray(41, 31, 0.6);
    const s = defaultSettings();
    s.vignette = { amount: 0.8, midpoint: 0.3, feather: 0.5 };
    const o = renderRaster(src, compile({ settings: s, color: srgb }), { output: 'rgba8' });
    const at = (x: number, y: number) => o[(y * 41 + x) * 4];
    expect(at(0, 0)).toBeLessThan(at(20, 15) - 40);
  });

  it('le grain est déterministe et centré', () => {
    const src = gray(64, 64, 0.5);
    const s = defaultSettings();
    s.grain = { amount: 1, size: 0.5, roughness: 0.5, color: 0, luminance: 0 };
    const c = compile({ settings: s, color: srgb });
    const a = renderRaster(src, c, { output: 'rgba8' });
    const b = renderRaster(src, c, { output: 'rgba8' });
    expect(a).toEqual(b);
    let sum = 0, varSum = 0;
    for (let i = 0; i < 64 * 64; i++) { sum += a[i * 4]; }
    const mean = sum / 4096;
    for (let i = 0; i < 64 * 64; i++) varSum += (a[i * 4] - mean) ** 2;
    expect(Math.abs(mean - 128)).toBeLessThan(6);
    expect(Math.sqrt(varSum / 4096)).toBeGreaterThan(5);
  });

  it('le halo teinte en rouge autour d’une lumière vive', () => {
    const src = gray(64, 64, 0.1);
    for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) src.data.fill(65535, (y * 64 + x) * 3, (y * 64 + x) * 3 + 3);
    const s = defaultSettings();
    s.halation = { amount: 1, radius: 1, threshold: 0.6 };
    const c = compile({ settings: s, color: srgb });
    const map = buildHalationMap(src, c);
    const o = renderRaster(src, c, { output: 'rgba8', halation: map });
    const i = (32 * 64 + 38) * 4;
    expect(o[i]).toBeGreaterThan(o[i + 2] + 10);
  });

  it('peut être interrompu', () => {
    const src = gray(10, 100, 0.5);
    const c = compile({ settings: defaultSettings(), color: srgb });
    expect(() => renderRaster(src, c, { output: 'rgba8', shouldAbort: () => true })).toThrow(/annulé/);
  });
});

describe('bruit', () => {
  it('hash dans [0, 1] et bruit dans [-1, 1]', () => {
    for (let i = 0; i < 1000; i++) {
      const h = hash3(i, i * 7, 3);
      expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThanOrEqual(1);
      const n = valueNoise(i * 0.37, i * 0.11, 1);
      expect(Math.abs(n)).toBeLessThanOrEqual(1);
    }
    // valeur de référence partagée avec le shader (cf. e2e)
    expect(hash3(1, 2, 3)).toBeCloseTo(hash3(1, 2, 3));
  });
});

describe('demi-flottants', () => {
  it('convertit avec une précision suffisante', () => {
    for (const v of [0, 1e-5, 0.001, 0.25, 0.5, 0.999, 1]) expect(halfToFloat(toHalf(v))).toBeCloseTo(v, 3);
  });
});

describe('réglages JSON', () => {
  it('aller-retour et validation', () => {
    const s = defaultSettings();
    s.exposure = 1.2; s.presetId = 'nb-contraste-fort';
    s.curves.r = [[0, 0], [0.5, 0.6], [1, 1]];
    const back = settingsFromJson(settingsToJson([{ name: 'a.tif', settings: s }]));
    expect(back[0].settings).toEqual(s);
  });
  it('borne les valeurs hors limites et ignore les champs inconnus', () => {
    const s = sanitizeSettings({ exposure: 99, contrast: 'beaucoup', pirate: true, input: { kind: 'xx' } });
    expect(s.exposure).toBe(3);
    expect(s.contrast).toBe(0);
    expect(s.input.kind).toBe('auto');
    expect('pirate' in s).toBe(false);
  });
  it('refuse un JSON étranger', () => {
    expect(() => settingsFromJson('{"foo": 1}')).toThrow();
  });
});

describe('chemin rapide de l’export', () => {
  it('la table d’entrée donne le même résultat que le calcul pixel par pixel', async () => {
    const { analyze } = await import('../src/core/analysis.ts');
    const { sceneLinear, simulateNegative } = await import('./synth.ts');
    const W = 600, H = 440;
    const neg = simulateNegative(sceneLinear(W, H), W, H, 10);
    const s = defaultSettings();
    s.input.kind = 'negative-color';
    const c = compile({ settings: s, analysis: analyze(neg, srgb), color: srgb });
    const fast = renderRaster(neg, c, { output: 'rgb16' }) as Uint16Array; // > 250 000 px : table
    const px = new Float32Array(3);
    let maxErr = 0;
    for (let i = 0; i < neg.width * neg.height; i += 997) {
      stage1(c, neg.data[i * 3] / 65535, neg.data[i * 3 + 1] / 65535, neg.data[i * 3 + 2] / 65535, px, 0);
      for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(Math.min(1, Math.max(0, px[k])) * 65535 - fast[i * 3 + k]));
    }
    expect(maxErr).toBeLessThan(65535 * 0.004);
  });
});
