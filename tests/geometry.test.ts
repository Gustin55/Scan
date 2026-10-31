import { describe, expect, it } from 'vitest';
import {
  cropFromMargins, defaultGeometry, geometryFromOrientation, localFromOutput, marginsFromCrop, outputFromLocal, outputSize,
  rotateBy, sanitizeGeometry, sourceMatrix, transformRaster, type Geometry,
} from '../src/core/geometry.ts';
import { createRaster } from '../src/core/raster.ts';

function numbered(w: number, h: number) {
  const r = createRaster(w, h, 1);
  for (let i = 0; i < w * h; i++) r.data[i] = i;
  return r;
}
const at = (r: ReturnType<typeof numbered>, x: number, y: number) => r.data[y * r.width + x];

describe('cadrage', () => {
  const all: Geometry[] = [];
  for (const rotate of [0, 90, 180, 270] as const) for (const flipH of [false, true]) all.push({ rotate, flipH, crop: { x0: 0.1, y0: 0.2, x1: 0.7, y1: 0.9 } });

  it('localFromOutput et outputFromLocal sont inverses', () => {
    for (const g of all) for (const [u, v] of [[0.1, 0.3], [0.9, 0.2], [0.5, 0.5]]) {
      const [a, b] = localFromOutput(u, v, g);
      const [u2, v2] = outputFromLocal(a, b, g);
      expect(u2).toBeCloseTo(u); expect(v2).toBeCloseTo(v);
    }
  });

  it('la matrice source correspond à la fonction de référence', () => {
    for (const g of all) {
      const [a, b, c, d, e, f] = sourceMatrix(g);
      const [la, lb] = localFromOutput(0.3, 0.8, g);
      const cr = g.crop!;
      expect(a * 0.3 + b * 0.8 + c).toBeCloseTo(cr.x0 + la * (cr.x1 - cr.x0));
      expect(d * 0.3 + e * 0.8 + f).toBeCloseTo(cr.y0 + lb * (cr.y1 - cr.y0));
    }
  });

  it('rotation horaire de 90° : le coin haut gauche vient du bas gauche', () => {
    const src = numbered(4, 3);
    const out = transformRaster(src, { rotate: 90, flipH: false, crop: null });
    expect([out.width, out.height]).toEqual([3, 4]);
    expect(at(out, 0, 0)).toBe(at(src, 0, 2));
    expect(at(out, 2, 0)).toBe(at(src, 0, 0));
    expect(at(out, 0, 3)).toBe(at(src, 3, 2));
  });

  it('miroir et recadrage', () => {
    const src = numbered(10, 10);
    const out = transformRaster(src, { rotate: 0, flipH: true, crop: { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.5 } });
    expect([out.width, out.height]).toEqual([4, 2]);
    expect(at(out, 0, 0)).toBe(at(src, 5, 3));
    expect(at(out, 3, 1)).toBe(at(src, 2, 4));
    expect(outputSize(10, 10, { rotate: 270, flipH: false, crop: { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.5 } })).toEqual({ w: 2, h: 4 });
  });

  it('identité : aucun copie', () => {
    const src = numbered(3, 3);
    expect(transformRaster(src, defaultGeometry())).toBe(src);
  });

  it('marges affichées ↔ recadrage source, quelle que soit l’orientation', () => {
    for (const g of all) {
      const m = marginsFromCrop(g);
      const back = cropFromMargins(m, g)!;
      expect(back.x0).toBeCloseTo(g.crop!.x0); expect(back.y1).toBeCloseTo(g.crop!.y1);
    }
    // Rotation de 90° : la marge du haut affichée rogne la gauche de la source.
    const g: Geometry = { rotate: 90, flipH: false, crop: null };
    expect(cropFromMargins({ left: 0, right: 0, top: 0.25, bottom: 0 }, g)).toEqual({ x0: 0.25, y0: 0, x1: 1, y1: 1 });
  });

  it('orientation TIFF/EXIF et rotation pas à pas', () => {
    expect(geometryFromOrientation(6)).toEqual({ rotate: 90, flipH: false, crop: null });
    expect(rotateBy(rotateBy(defaultGeometry(), 1), 1).rotate).toBe(180);
    expect(rotateBy(defaultGeometry(), -1).rotate).toBe(270);
  });

  it('validation', () => {
    expect(sanitizeGeometry({ rotate: 45, flipH: 'oui', crop: { x0: 0.5, x1: 0.52 } })).toEqual(defaultGeometry());
    expect(sanitizeGeometry({ rotate: 180, crop: { x0: -1, y0: 0, x1: 0.5, y1: 2 } }).crop).toEqual({ x0: 0, y0: 0, x1: 0.5, y1: 1 });
  });
});
