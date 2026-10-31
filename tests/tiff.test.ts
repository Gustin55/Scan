import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { decodeTiff, readTiffInfo } from '../src/core/tiff/decode.ts';
import { encodeTiff } from '../src/core/tiff/encode.ts';
import { lzwDecode, lzwEncode, packBitsDecode } from '../src/core/tiff/lzw.ts';
import { createRaster } from '../src/core/raster.ts';
import { buildSrgbIcc, parseIcc } from '../src/core/icc.ts';

function randomRaster(w: number, h: number, ch: 1 | 3) {
  const r = createRaster(w, h, ch);
  let s = 12345;
  for (let i = 0; i < r.data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    // données semi-régulières pour exercer le dictionnaire LZW
    r.data[i] = (i % 7 === 0 ? s >>> 16 : (i * 37) & 0xffff);
  }
  return r;
}

describe('LZW', () => {
  it('fait l’aller-retour sur des données variées', () => {
    for (const len of [0, 1, 2, 300, 5000, 70000]) {
      const src = new Uint8Array(len);
      for (let i = 0; i < len; i++) src[i] = (i * 31 + (i >> 5)) & 0xff;
      const enc = lzwEncode(src);
      const out = new Uint8Array(len);
      expect(lzwDecode(enc, out)).toBe(len);
      expect(out).toEqual(src);
    }
  });
  it('gère les données aléatoires (dictionnaire plein, codes de remise à zéro)', () => {
    const src = new Uint8Array(200000);
    let s = 7;
    for (let i = 0; i < src.length; i++) { s = (s * 69069 + 1) >>> 0; src[i] = s >>> 24; }
    const out = new Uint8Array(src.length);
    lzwDecode(lzwEncode(src), out);
    expect(out).toEqual(src);
  });
});

describe('PackBits', () => {
  it('décode l’exemple de la spécification TIFF', () => {
    const enc = Uint8Array.from([0xfe, 0xaa, 0x02, 0x80, 0x00, 0x2a, 0xfd, 0xaa, 0x03, 0x80, 0x00, 0x2a, 0x22, 0xf7, 0xaa]);
    const out = new Uint8Array(24);
    packBitsDecode(enc, out);
    expect(Array.from(out)).toEqual([0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0x22, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  });
});

describe('TIFF', () => {
  for (const compression of ['none', 'deflate', 'lzw'] as const)
    for (const ch of [1, 3] as const)
      it(`aller-retour 16 bits ${ch === 3 ? 'RVB' : 'gris'} ${compression}`, () => {
        const src = randomRaster(37, 23, ch);
        const file = encodeTiff(src, { compression, rowsPerStrip: 5 });
        const info = readTiffInfo(file);
        expect(info).toMatchObject({ width: 37, height: 23, bitsPerSample: 16, samplesPerPixel: ch });
        const out = decodeTiff(file);
        expect(out.channels).toBe(ch);
        expect(out.data).toEqual(src.data);
      });

  it('aller-retour 8 bits avec prédicteur', () => {
    const src = randomRaster(16, 9, 3);
    for (let i = 0; i < src.data.length; i++) src.data[i] = (src.data[i] >> 8) * 257;
    const out = decodeTiff(encodeTiff(src, { bits: 8, compression: 'deflate', predictor: true }));
    expect(out.data).toEqual(src.data);
    expect(out.sourceBits).toBe(8);
  });

  it('conserve le profil ICC', () => {
    const icc = buildSrgbIcc();
    const out = decodeTiff(encodeTiff(randomRaster(4, 4, 3), { icc }));
    expect(out.icc).toEqual(icc);
    const color = parseIcc(out.icc);
    expect(color.isSrgb).toBe(true);
    expect(color.warning).toBeUndefined();
  });

  it('lit un TIFF gros-boutiste tuilé écrit à la main', () => {
    // 4×2 RVB 16 bits, une tuile 16×16 compressée en Deflate.
    const W = 4, H = 2, T = 16;
    const tile = new Uint8Array(T * T * 6);
    const dvT = new DataView(tile.buffer);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) dvT.setUint16(((y * T + x) * 3 + c) * 2, 1000 * (y * W + x) + c, false);
    const comp = zlibSync(tile);
    const entries: [number, number, number[]][] = [
      [256, 3, [W]], [257, 3, [H]], [258, 3, [16, 16, 16]], [259, 3, [8]], [262, 3, [2]], [277, 3, [3]],
      [322, 3, [T]], [323, 3, [T]], [324, 4, [0]], [325, 4, [comp.length]],
    ];
    const ifdOff = 8;
    const extraOff = ifdOff + 2 + entries.length * 12 + 4;
    const dataOff = extraOff + 6;
    const buf = new Uint8Array(dataOff + comp.length);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, 0x4d4d); dv.setUint16(2, 42); dv.setUint32(4, ifdOff);
    dv.setUint16(ifdOff, entries.length);
    entries.forEach(([tag, type, vals], i) => {
      const p = ifdOff + 2 + i * 12;
      dv.setUint16(p, tag); dv.setUint16(p + 2, type); dv.setUint32(p + 4, vals.length);
      if (tag === 258) { dv.setUint32(p + 8, extraOff); vals.forEach((v, k) => dv.setUint16(extraOff + k * 2, v)); }
      else if (tag === 324) dv.setUint32(p + 8, dataOff);
      else if (type === 3) dv.setUint16(p + 8, vals[0]);
      else dv.setUint32(p + 8, vals[0]);
    });
    buf.set(comp, dataOff);
    const out = decodeTiff(buf);
    expect(out.width).toBe(W);
    expect(Array.from(out.data.subarray(0, 6))).toEqual([0, 1, 2, 1000, 1001, 1002]);
    expect(out.data[(1 * W + 3) * 3 + 2]).toBe(7002);
  });

  it('refuse un fichier qui n’est pas un TIFF', () => {
    expect(() => decodeTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/TIFF/);
  });
});

describe('orientation TIFF', () => {
  it('applique l’étiquette Orientation (6 = rotation horaire de 90°)', () => {
    const src = createRaster(3, 2, 1);
    src.data.set([1, 2, 3, 4, 5, 6]);
    const out = decodeTiff(encodeTiff(src, { orientation: 6, compression: 'none' }));
    expect([out.width, out.height]).toEqual([2, 3]);
    expect(Array.from(out.data)).toEqual([4, 1, 5, 2, 6, 3]);
  });
});
