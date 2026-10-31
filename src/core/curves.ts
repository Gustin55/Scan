/** Courbes de tonalité : points de contrôle → spline monotone → table. */

export type CurvePoint = [number, number];
export type Curve = CurvePoint[];

export const IDENTITY_CURVE: Curve = [[0, 0], [1, 1]];

export function isIdentityCurve(c: Curve | undefined): boolean {
  if (!c || c.length === 0) return true;
  return c.every(([x, y]) => Math.abs(x - y) < 1e-6);
}

/** Trie, borne et dédoublonne les points ; garantit les extrémités x = 0 et x = 1. */
export function normalizeCurve(c: Curve | undefined): Curve {
  if (!c || c.length === 0) return IDENTITY_CURVE.map((p) => [...p] as CurvePoint);
  const pts = c
    .map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))] as CurvePoint)
    .sort((a, b) => a[0] - b[0]);
  const out: Curve = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-4) out[out.length - 1] = p;
    else out.push(p);
  }
  if (out[0][0] > 0) out.unshift([0, out[0][1]]);
  if (out[out.length - 1][0] < 1) out.push([1, out[out.length - 1][1]]);
  return out;
}

/** Évaluateur par spline cubique monotone (Fritsch–Carlson) : pas de dépassement. */
export function curveEvaluator(curve: Curve | undefined): (x: number) => number {
  const pts = normalizeCurve(curve);
  const n = pts.length;
  if (n === 2) {
    const [[x0, y0], [x1, y1]] = pts;
    return (x) => {
      const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0 || 1)));
      return y0 + (y1 - y0) * t;
    };
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    return Math.min(1, Math.max(0, y));
  };
}

/** Courbe de contraste en S autour de 0,5 ; c ∈ [-100, 100]. */
export function contrastFn(c: number): (x: number) => number {
  if (Math.abs(c) < 1e-6) return (x) => x;
  const a = Math.pow(2, (c / 100) * 1.3);
  return (x) => {
    const v = Math.min(1, Math.max(0, x));
    return v < 0.5 ? 0.5 * Math.pow(2 * v, a) : 1 - 0.5 * Math.pow(2 * (1 - v), a);
  };
}
