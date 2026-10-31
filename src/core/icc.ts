import { IDENTITY3, XYZD50_TO_SRGB, mulMat3, srgbToLinear, linearToSrgb, type Mat3, SRGB_TO_XYZD50 } from './color.ts';

/** Description d'un profil d'entrée exploitable par le pipeline. */
export interface InputColor {
  /** Nom lisible (description du profil ou « sRGB (supposé) »). */
  name: string;
  /** Matrice source linéaire → sRGB linéaire (ligne par ligne). */
  toSrgb: Mat3;
  /** Courbe de transfert : valeur encodée → linéaire, échantillonnée (N points sur [0,1]). */
  trc: [Float32Array, Float32Array, Float32Array];
  /** Avertissement éventuel (profil non géré, etc.). */
  warning?: string;
  /** true si le profil est reconnu comme sRGB (aucune conversion de primaires). */
  isSrgb: boolean;
}

export const TRC_SIZE = 4096;

export function sampleCurve(fn: (v: number) => number, n = TRC_SIZE): Float32Array {
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = fn(i / (n - 1));
  return t;
}

let srgbTrcCache: Float32Array | undefined;
export function srgbTrc(): Float32Array {
  return (srgbTrcCache ??= sampleCurve(srgbToLinear));
}

export function defaultInputColor(kind: 'srgb' | 'linear' | 'gamma22' = 'srgb'): InputColor {
  const t = kind === 'linear' ? sampleCurve((v) => v) : kind === 'gamma22' ? sampleCurve((v) => Math.pow(v, 2.2)) : srgbTrc();
  return {
    name: kind === 'linear' ? 'Linéaire' : kind === 'gamma22' ? 'Gamma 2,2' : 'sRGB',
    toSrgb: [...IDENTITY3] as Mat3,
    trc: [t, t, t],
    isSrgb: kind === 'srgb',
  };
}

function s15(dv: DataView, o: number) { return dv.getInt32(o, false) / 65536; }

function readCurve(dv: DataView, off: number, len: number): ((v: number) => number) | null {
  const sig = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  if (sig === 'curv') {
    const n = dv.getUint32(off + 8, false);
    if (n === 0) return (v) => v;
    if (n === 1) {
      const g = dv.getUint16(off + 12, false) / 256;
      return (v) => Math.pow(v, g);
    }
    if (12 + n * 2 > len) return null;
    const table = new Float32Array(n);
    for (let i = 0; i < n; i++) table[i] = dv.getUint16(off + 12 + i * 2, false) / 65535;
    return (v) => {
      const x = Math.min(1, Math.max(0, v)) * (n - 1);
      const i = Math.floor(x);
      const f = x - i;
      return i >= n - 1 ? table[n - 1] : table[i] * (1 - f) + table[i + 1] * f;
    };
  }
  if (sig === 'para') {
    const type = dv.getUint16(off + 8, false);
    const p = (k: number) => s15(dv, off + 12 + k * 4);
    const g = p(0);
    switch (type) {
      case 0: return (v) => Math.pow(v, g);
      case 1: { const a = p(1), b = p(2); return (v) => (v >= -b / a ? Math.pow(a * v + b, g) : 0); }
      case 2: { const a = p(1), b = p(2), c = p(3); return (v) => (v >= -b / a ? Math.pow(a * v + b, g) + c : c); }
      case 3: { const a = p(1), b = p(2), c = p(3), d = p(4); return (v) => (v >= d ? Math.pow(a * v + b, g) : c * v); }
      case 4: { const a = p(1), b = p(2), c = p(3), d = p(4), e = p(5), f = p(6); return (v) => (v >= d ? Math.pow(a * v + b, g) + e : c * v + f); }
    }
  }
  return null;
}

/** Lit un profil ICC matrice/TRC (RVB) ou gris/TRC. Les profils à LUT renvoient sRGB avec un avertissement. */
export function parseIcc(bytes: Uint8Array | undefined): InputColor {
  if (!bytes || bytes.length < 132) return { ...defaultInputColor('srgb'), name: 'sRGB (supposé)' };
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const space = String.fromCharCode(...bytes.subarray(16, 20));
    const count = dv.getUint32(128, false);
    const tags = new Map<string, { off: number; len: number }>();
    for (let i = 0; i < count; i++) {
      const p = 132 + i * 12;
      if (p + 12 > bytes.length) break;
      const sig = String.fromCharCode(...bytes.subarray(p, p + 4));
      tags.set(sig, { off: dv.getUint32(p + 4, false), len: dv.getUint32(p + 8, false) });
    }
    const name = readDesc(dv, bytes, tags.get('desc')) ?? 'Profil ICC';
    if (space === 'GRAY') {
      const k = tags.get('kTRC');
      const fn = k ? readCurve(dv, k.off, k.len) : null;
      if (!fn) return { ...defaultInputColor('srgb'), name, warning: 'Profil gris non lu, sRGB supposé.' };
      const t = sampleCurve(fn);
      return { name, toSrgb: [...IDENTITY3] as Mat3, trc: [t, t, t], isSrgb: false };
    }
    const need = ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'];
    if (space !== 'RGB ' || !need.every((n) => tags.has(n))) {
      return { ...defaultInputColor('srgb'), name, warning: `Profil « ${name} » non géré (LUT), sRGB supposé.` };
    }
    const xyz = (n: string) => {
      const t = tags.get(n)!;
      return [s15(dv, t.off + 8), s15(dv, t.off + 12), s15(dv, t.off + 16)];
    };
    const r = xyz('rXYZ'), g = xyz('gXYZ'), b = xyz('bXYZ');
    const toXyz: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
    const toSrgb = mulMat3(XYZD50_TO_SRGB, toXyz);
    const curves = ['rTRC', 'gTRC', 'bTRC'].map((n) => {
      const t = tags.get(n)!;
      return readCurve(dv, t.off, t.len);
    });
    if (curves.some((c) => !c)) return { ...defaultInputColor('srgb'), name, warning: 'Courbes du profil illisibles, sRGB supposé.' };
    const isSrgb = toSrgb.every((v, i) => Math.abs(v - IDENTITY3[i]) < 0.01) &&
      [0.02, 0.2, 0.5, 0.9].every((v) => Math.abs(curves[0]!(v) - srgbToLinear(v)) < 0.01);
    return {
      name,
      toSrgb,
      trc: isSrgb ? [srgbTrc(), srgbTrc(), srgbTrc()] : (curves.map((c) => sampleCurve(c!)) as [Float32Array, Float32Array, Float32Array]),
      isSrgb,
    };
  } catch {
    return { ...defaultInputColor('srgb'), name: 'sRGB (supposé)', warning: 'Profil ICC illisible, sRGB supposé.' };
  }
}

function readDesc(dv: DataView, bytes: Uint8Array, t?: { off: number; len: number }): string | null {
  if (!t) return null;
  const sig = String.fromCharCode(...bytes.subarray(t.off, t.off + 4));
  if (sig === 'desc') {
    const n = dv.getUint32(t.off + 8, false);
    return new TextDecoder('latin1').decode(bytes.subarray(t.off + 12, t.off + 12 + Math.max(0, n - 1)));
  }
  if (sig === 'mluc') {
    const recs = dv.getUint32(t.off + 8, false);
    if (!recs) return null;
    const len = dv.getUint32(t.off + 20, false);
    const off = dv.getUint32(t.off + 24, false);
    const s = bytes.subarray(t.off + off, t.off + off + len);
    let out = '';
    for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s[i] << 8) | s[i + 1]);
    return out;
  }
  return null;
}

/** Construit un profil ICC v2 sRGB minimal (matrice + TRC tabulée) pour l'export TIFF. */
export function buildSrgbIcc(): Uint8Array {
  const curvN = 1024;
  const tagsDef: { sig: string; data: Uint8Array }[] = [];
  const enc = (s: string) => new TextEncoder().encode(s);
  const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const s15f = (v: number) => be32(Math.round(v * 65536) >>> 0);
  const desc = (() => {
    const text = 'sRGB IEC61966-2.1 (Scan pellicule)';
    const a = [...enc('desc'), 0, 0, 0, 0, ...be32(text.length + 1), ...enc(text), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    a.push(...new Array(67).fill(0));
    return Uint8Array.from(a);
  })();
  const xyzTag = (x: number, y: number, z: number) => Uint8Array.from([...enc('XYZ '), 0, 0, 0, 0, ...s15f(x), ...s15f(y), ...s15f(z)]);
  const curv = (() => {
    const a = [...enc('curv'), 0, 0, 0, 0, ...be32(curvN)];
    for (let i = 0; i < curvN; i++) {
      const v = Math.round(srgbToLinear(i / (curvN - 1)) * 65535);
      a.push((v >> 8) & 255, v & 255);
    }
    return Uint8Array.from(a);
  })();
  const text = (s: string) => Uint8Array.from([...enc('text'), 0, 0, 0, 0, ...enc(s), 0]);
  const M = SRGB_TO_XYZD50;
  tagsDef.push({ sig: 'desc', data: desc });
  tagsDef.push({ sig: 'cprt', data: text('Domaine public') });
  tagsDef.push({ sig: 'wtpt', data: xyzTag(0.9642, 1.0, 0.8249) });
  tagsDef.push({ sig: 'rXYZ', data: xyzTag(M[0], M[3], M[6]) });
  tagsDef.push({ sig: 'gXYZ', data: xyzTag(M[1], M[4], M[7]) });
  tagsDef.push({ sig: 'bXYZ', data: xyzTag(M[2], M[5], M[8]) });
  tagsDef.push({ sig: 'rTRC', data: curv });
  tagsDef.push({ sig: 'gTRC', data: curv });
  tagsDef.push({ sig: 'bTRC', data: curv });

  const headerSize = 128 + 4 + tagsDef.length * 12;
  const offsets: number[] = [];
  let cursor = headerSize;
  const blobs = new Map<Uint8Array, number>();
  for (const t of tagsDef) {
    if (blobs.has(t.data)) { offsets.push(blobs.get(t.data)!); continue; }
    cursor = (cursor + 3) & ~3;
    offsets.push(cursor);
    blobs.set(t.data, cursor);
    cursor += t.data.length;
  }
  const size = (cursor + 3) & ~3;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size, false);
  out.set(enc('none'), 4);
  dv.setUint32(8, 0x02100000, false);
  out.set(enc('mntr'), 12);
  out.set(enc('RGB '), 16);
  out.set(enc('XYZ '), 20);
  dv.setUint16(24, 2026); dv.setUint16(26, 1); dv.setUint16(28, 1);
  out.set(enc('acsp'), 36);
  // illuminant D50
  dv.setInt32(68, Math.round(0.9642 * 65536)); dv.setInt32(72, 65536); dv.setInt32(76, Math.round(0.8249 * 65536));
  dv.setUint32(128, tagsDef.length, false);
  tagsDef.forEach((t, i) => {
    const p = 132 + i * 12;
    out.set(enc(t.sig), p);
    dv.setUint32(p + 4, offsets[i], false);
    dv.setUint32(p + 8, t.data.length, false);
  });
  for (const [data, off] of blobs) out.set(data, off);
  return out;
}

export { linearToSrgb };
