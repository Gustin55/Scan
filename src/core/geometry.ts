/**
 * Cadrage : recadrage (en coordonnées de l'image source), puis rotation par quarts de
 * tour et miroir horizontal. Les mêmes formules servent au shader (matrice affine des
 * coordonnées), à l'export CPU et à l'interface.
 */
import { createRaster, type Raster } from './raster.ts';

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export type Rotation = 0 | 90 | 180 | 270;
export interface Geometry { rotate: Rotation; flipH: boolean; crop: Rect | null }

export const FULL: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };
export const defaultGeometry = (): Geometry => ({ rotate: 0, flipH: false, crop: null });

export function isIdentityGeometry(g: Geometry | undefined): boolean {
  if (!g) return true;
  const c = g.crop ?? FULL;
  return g.rotate === 0 && !g.flipH && c.x0 <= 0 && c.y0 <= 0 && c.x1 >= 1 && c.y1 >= 1;
}

/** Sortie (u, v) → repère local du recadrage (a, b), avant application du recadrage. */
export function localFromOutput(u: number, v: number, g: Geometry): [number, number] {
  if (g.flipH) u = 1 - u;
  switch (g.rotate) {
    case 90: return [v, 1 - u];
    case 180: return [1 - u, 1 - v];
    case 270: return [1 - v, u];
    default: return [u, v];
  }
}

/** Inverse de localFromOutput. */
export function outputFromLocal(a: number, b: number, g: Geometry): [number, number] {
  let u: number, v: number;
  switch (g.rotate) {
    case 90: [u, v] = [1 - b, a]; break;
    case 180: [u, v] = [1 - a, 1 - b]; break;
    case 270: [u, v] = [b, 1 - a]; break;
    default: [u, v] = [a, b];
  }
  return [g.flipH ? 1 - u : u, v];
}

/**
 * Matrice affine 2×3 : source = M · (u, v, 1), coordonnées normalisées de la texture
 * (origine en haut à gauche). Lignes : [a, b, c], [d, e, f].
 */
export function sourceMatrix(g: Geometry): [number, number, number, number, number, number] {
  const c = g.crop ?? FULL;
  const p0 = localFromOutput(0, 0, g), pu = localFromOutput(1, 0, g), pv = localFromOutput(0, 1, g);
  const sx = c.x1 - c.x0, sy = c.y1 - c.y0;
  const ox = c.x0 + p0[0] * sx, oy = c.y0 + p0[1] * sy;
  return [(pu[0] - p0[0]) * sx, (pv[0] - p0[0]) * sx, ox, (pu[1] - p0[1]) * sy, (pv[1] - p0[1]) * sy, oy];
}

/** Dimensions en pixels de la sortie pour une source w × h. */
export function outputSize(w: number, h: number, g: Geometry): { w: number; h: number } {
  const c = g.crop ?? FULL;
  const cw = Math.max(1, Math.round(w * (c.x1 - c.x0)));
  const ch = Math.max(1, Math.round(h * (c.y1 - c.y0)));
  return g.rotate === 90 || g.rotate === 270 ? { w: ch, h: cw } : { w: cw, h: ch };
}

/** Applique le cadrage à un raster (échantillonnage au plus proche : quarts de tour exacts). */
export function transformRaster(src: Raster, g: Geometry): Raster {
  if (isIdentityGeometry(g)) return src;
  const { w, h } = outputSize(src.width, src.height, g);
  const out = createRaster(w, h, src.channels, src.sourceBits);
  out.icc = src.icc;
  const [a, b, c, d, e, f] = sourceMatrix(g);
  const ch = src.channels;
  const W = src.width, H = src.height;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const sx = Math.min(W - 1, Math.max(0, Math.floor((a * u + b * v + c) * W)));
      const sy = Math.min(H - 1, Math.max(0, Math.floor((d * u + e * v + f) * H)));
      const si = (sy * W + sx) * ch, oi = (y * w + x) * ch;
      out.data[oi] = src.data[si];
      if (ch === 3) { out.data[oi + 1] = src.data[si + 1]; out.data[oi + 2] = src.data[si + 2]; }
    }
  }
  return out;
}

/** Marges affichées (gauche, droite, haut, bas ; fractions de l'image affichée) ↔ recadrage source. */
export interface Margins { left: number; right: number; top: number; bottom: number }

export function marginsFromCrop(g: Geometry): Margins {
  const c = g.crop ?? FULL;
  const p = outputFromLocal(c.x0, c.y0, g), q = outputFromLocal(c.x1, c.y1, g);
  const r = { x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) };
  return { left: r.x0, top: r.y0, right: 1 - r.x1, bottom: 1 - r.y1 };
}

export function cropFromMargins(m: Margins, g: Geometry): Rect | null {
  const p = localFromOutput(m.left, m.top, g), q = localFromOutput(1 - m.right, 1 - m.bottom, g);
  const r = { x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) };
  if (r.x0 <= 1e-4 && r.y0 <= 1e-4 && r.x1 >= 1 - 1e-4 && r.y1 >= 1 - 1e-4) return null;
  return r;
}

/** Applique une orientation EXIF/TIFF (1–8) : renvoie la géométrie équivalente. */
export function geometryFromOrientation(o: number): Geometry {
  const map: Record<number, [Rotation, boolean]> = {
    1: [0, false], 2: [0, true], 3: [180, false], 4: [180, true], 5: [90, true], 6: [90, false], 7: [270, true], 8: [270, false],
  };
  const [rotate, flipH] = map[o] ?? [0, false];
  return { rotate, flipH, crop: null };
}

export function sanitizeGeometry(raw: unknown): Geometry {
  const g = defaultGeometry();
  if (typeof raw !== 'object' || raw === null) return g;
  const r = raw as Record<string, unknown>;
  if ([0, 90, 180, 270].includes(r.rotate as number)) g.rotate = r.rotate as Rotation;
  g.flipH = r.flipH === true;
  const c = r.crop as Record<string, unknown> | null;
  if (c && typeof c === 'object') {
    const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
    const x0 = n(c.x0, 0), y0 = n(c.y0, 0), x1 = n(c.x1, 1), y1 = n(c.y1, 1);
    if (x1 - x0 >= 0.05 && y1 - y0 >= 0.05) g.crop = { x0, y0, x1, y1 };
  }
  return g;
}

/** Rotation de 90° dans un sens (+1 horaire, −1 antihoraire), recadrage conservé. */
export function rotateBy(g: Geometry, dir: 1 | -1): Geometry {
  // Avec un miroir, le sens visuel de rotation s'inverse dans le repère source.
  const step = g.flipH ? -dir : dir;
  return { ...g, rotate: (((g.rotate + step * 90) % 360) + 360) % 360 as Rotation };
}
