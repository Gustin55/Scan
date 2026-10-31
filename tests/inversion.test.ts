import { describe, expect, it } from 'vitest';
import { analyze, estimateBase, toLinear } from '../src/core/analysis.ts';
import { compile } from '../src/core/compile.ts';
import { defaultInputColor } from '../src/core/icc.ts';
import { stage1 } from '../src/core/pipeline.ts';
import { defaultSettings } from '../src/core/settings.ts';
import { COLOR_FILM, sceneLinear, sceneToRaster, simulateNegative } from './synth.ts';

const W = 120, H = 80, B = 8;
const scene = sceneLinear(W, H);
const neg = simulateNegative(scene, W, H, B);
const srgb = defaultInputColor('srgb');

function invertPixel(x: number, y: number, kind: 'negative-color' | 'negative-bw' = 'negative-color') {
  const a = analyze(neg, srgb);
  const s = defaultSettings();
  s.input.kind = kind;
  const c = compile({ settings: s, analysis: a, color: srgb });
  const i = ((y + B) * neg.width + (x + B)) * 3;
  const out = new Float32Array(3);
  stage1(c, neg.data[i] / 65535, neg.data[i + 1] / 65535, neg.data[i + 2] / 65535, out, 0);
  return out;
}

describe('estimation du masque orange', () => {
  it('mesure la transmission du support sur le bord non exposé', () => {
    const lin = toLinear(neg, srgb);
    const { base, fromBorder } = estimateBase(lin, neg.width, neg.height, false);
    expect(fromBorder).toBe(true);
    COLOR_FILM.baseDensity.forEach((d, c) => expect(base[c]).toBeCloseTo(Math.pow(10, -d), 2));
  });

  it('reste plausible sur un négatif recadré sans bord', () => {
    const cropped = simulateNegative(scene, W, H, 0);
    const lin = toLinear(cropped, srgb);
    const { base } = estimateBase(lin, W, H, false);
    // teinte orangée, un peu plus dense que le vrai support
    expect(base[0]).toBeGreaterThan(base[1]);
    expect(base[1]).toBeGreaterThan(base[2]);
    expect(base[1]).toBeLessThanOrEqual(Math.pow(10, -COLOR_FILM.baseDensity[1]) + 0.01);
  });

  it('ignore la lumière directe autour du négatif', () => {
    const lit = simulateNegative(scene, W, H, B);
    for (let x = 0; x < lit.width; x++) lit.data.fill(65535, x * 3, x * 3 + 3);
    const lin = toLinear(lit, srgb);
    const { base } = estimateBase(lin, lit.width, lit.height, false);
    expect(base[2]).toBeCloseTo(Math.pow(10, -COLOR_FILM.baseDensity[2]), 2);
  });
});

describe('détection', () => {
  it('reconnaît un négatif couleur et un positif', () => {
    expect(analyze(neg, srgb).detectedKind).toBe('negative-color');
    expect(analyze(sceneToRaster(scene, W, H), srgb).detectedKind).toBe('positive');
    expect(analyze(simulateNegative(scene, W, H, B, COLOR_FILM, true), srgb).detectedKind).toBe('negative-bw');
  });
});

describe('inversion couleur', () => {
  it('rend les gris neutres (masque supprimé)', () => {
    for (const x of [15, 50, 95]) {
      const [r, g, b] = invertPixel(x, 10);
      const m = (r + g + b) / 3;
      expect(Math.abs(r - m)).toBeLessThan(0.05);
      expect(Math.abs(b - m)).toBeLessThan(0.05);
    }
  });

  it('préserve l’ordre des luminosités', () => {
    const lum = [5, 25, 45, 65, 85, 105].map((x) => invertPixel(x, 10)[1]);
    for (let i = 1; i < lum.length; i++) expect(lum[i]).toBeGreaterThan(lum[i - 1]);
    expect(lum[0]).toBeLessThan(0.15);
    expect(lum[lum.length - 1]).toBeGreaterThan(0.8);
  });

  it('retrouve la teinte des aplats colorés', () => {
    const red = invertPixel(8, 45);
    expect(red[0]).toBeGreaterThan(red[1] + 0.15);
    const blue = invertPixel(45, 45);
    expect(blue[2]).toBeGreaterThan(blue[0] + 0.1);
    const green = invertPixel(28, 45);
    expect(green[1]).toBeGreaterThan(green[0]);
  });

  it('le noir et blanc produit des valeurs neutres', () => {
    const [r, g, b] = invertPixel(8, 45, 'negative-bw');
    expect(r).toBeCloseTo(g, 5);
    expect(g).toBeCloseTo(b, 5);
  });
});

describe('réglages fins', () => {
  it('le point noir assombrit les ombres', () => {
    const a = analyze(neg, srgb);
    const s = defaultSettings();
    s.input.kind = 'negative-color';
    const base = compile({ settings: s, analysis: a, color: srgb });
    s.inversionAdjust.blackPoint = 30;
    const darker = compile({ settings: s, analysis: a, color: srgb });
    expect(darker.dmin[1]).toBeGreaterThan(base.dmin[1]);
  });
});
