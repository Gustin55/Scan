import { unzlibSync, inflateSync } from 'fflate';
import { createRaster, type Raster } from '../raster.ts';
import { lzwDecode, packBitsDecode } from './lzw.ts';

export const TAG = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  Photometric: 262,
  StripOffsets: 273,
  Orientation: 274,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  XResolution: 282,
  YResolution: 283,
  PlanarConfiguration: 284,
  ResolutionUnit: 296,
  Software: 305,
  Predictor: 317,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  ExtraSamples: 338,
  SampleFormat: 339,
  ICCProfile: 34675,
} as const;

export class TiffError extends Error {}

interface Ifd {
  tags: Map<number, number[] | Uint8Array>;
}

class Reader {
  view: DataView;
  le: boolean;
  bytes: Uint8Array;
  constructor(buf: ArrayBuffer | Uint8Array) {
    this.bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const bo = this.view.getUint16(0, false);
    if (bo === 0x4949) this.le = true;
    else if (bo === 0x4d4d) this.le = false;
    else throw new TiffError('Ce fichier n’est pas un TIFF (en-tête invalide).');
    const magic = this.view.getUint16(2, this.le);
    if (magic === 43) throw new TiffError('BigTIFF n’est pas pris en charge.');
    if (magic !== 42) throw new TiffError('Signature TIFF invalide.');
  }
  u16(o: number) { return this.view.getUint16(o, this.le); }
  u32(o: number) { return this.view.getUint32(o, this.le); }
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

function readIfd(r: Reader, offset: number): { ifd: Ifd; next: number } {
  const count = r.u16(offset);
  const tags = new Map<number, number[] | Uint8Array>();
  for (let i = 0; i < count; i++) {
    const e = offset + 2 + i * 12;
    const tag = r.u16(e);
    const type = r.u16(e + 2);
    const n = r.u32(e + 4);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    const dataOff = size <= 4 ? e + 8 : r.u32(e + 8);
    if (dataOff + size > r.bytes.length) continue;
    if (type === 7 || type === 1 || type === 2 || type === 6) {
      if (tag === TAG.ICCProfile || type === 7) {
        tags.set(tag, r.bytes.slice(dataOff, dataOff + size));
        continue;
      }
    }
    const vals: number[] = [];
    for (let k = 0; k < n; k++) {
      switch (type) {
        case 1: case 2: case 6: case 7: vals.push(r.bytes[dataOff + k]); break;
        case 3: case 8: vals.push(r.u16(dataOff + k * 2)); break;
        case 4: case 9: case 13: vals.push(r.u32(dataOff + k * 4)); break;
        case 5: case 10: vals.push(r.u32(dataOff + k * 8) / (r.u32(dataOff + k * 8 + 4) || 1)); break;
        case 11: vals.push(r.view.getFloat32(dataOff + k * 4, r.le)); break;
        case 12: vals.push(r.view.getFloat64(dataOff + k * 8, r.le)); break;
        default: vals.push(0);
      }
    }
    tags.set(tag, vals);
  }
  return { ifd: { tags }, next: r.u32(offset + 2 + count * 12) };
}

function num(ifd: Ifd, tag: number, def?: number): number {
  const v = ifd.tags.get(tag);
  if (!v || v.length === 0) {
    if (def === undefined) throw new TiffError(`Étiquette TIFF ${tag} manquante.`);
    return def;
  }
  return v[0];
}
function arr(ifd: Ifd, tag: number): number[] {
  const v = ifd.tags.get(tag);
  if (!v) throw new TiffError(`Étiquette TIFF ${tag} manquante.`);
  return Array.from(v);
}

export interface TiffInfo {
  width: number;
  height: number;
  bitsPerSample: number;
  samplesPerPixel: number;
  photometric: number;
  compression: number;
  icc?: Uint8Array;
}

function listIfds(r: Reader): Ifd[] {
  const ifds: Ifd[] = [];
  let off = r.u32(4);
  const seen = new Set<number>();
  while (off && off < r.bytes.length && !seen.has(off) && ifds.length < 64) {
    seen.add(off);
    const { ifd, next } = readIfd(r, off);
    ifds.push(ifd);
    off = next;
  }
  if (!ifds.length) throw new TiffError('Aucune image dans ce TIFF.');
  return ifds;
}

/** Choisit l'image principale : la plus grande (les scanners ajoutent parfois une vignette). */
function mainIfd(ifds: Ifd[]): Ifd {
  let best = ifds[0];
  let bestArea = 0;
  for (const ifd of ifds) {
    const a = num(ifd, TAG.ImageWidth, 0) * num(ifd, TAG.ImageLength, 0);
    if (a > bestArea) { best = ifd; bestArea = a; }
  }
  return best;
}

export function readTiffInfo(buf: ArrayBuffer | Uint8Array): TiffInfo {
  const r = new Reader(buf);
  const ifd = mainIfd(listIfds(r));
  const icc = ifd.tags.get(TAG.ICCProfile);
  return {
    width: num(ifd, TAG.ImageWidth),
    height: num(ifd, TAG.ImageLength),
    bitsPerSample: num(ifd, TAG.BitsPerSample, 1),
    samplesPerPixel: num(ifd, TAG.SamplesPerPixel, 1),
    photometric: num(ifd, TAG.Photometric, 1),
    compression: num(ifd, TAG.Compression, 1),
    icc: icc instanceof Uint8Array ? icc : undefined,
  };
}

function decompress(compression: number, src: Uint8Array, expected: number): Uint8Array {
  switch (compression) {
    case 1:
      return src;
    case 5: {
      const out = new Uint8Array(expected);
      lzwDecode(src, out);
      return out;
    }
    case 8:
    case 32946: {
      let out: Uint8Array;
      try { out = unzlibSync(src); } catch { out = inflateSync(src); }
      return out;
    }
    case 32773: {
      const out = new Uint8Array(expected);
      packBitsDecode(src, out);
      return out;
    }
    case 7:
      throw new TiffError('TIFF compressé en JPEG : non pris en charge, enregistrez sans compression, LZW ou ZIP.');
    default:
      throw new TiffError(`Compression TIFF ${compression} non prise en charge.`);
  }
}

export interface DecodeOptions {
  /** Appelée régulièrement pour signaler l'avancement (0..1). */
  onProgress?: (p: number) => void;
}

/** Décode l'image principale d'un TIFF en raster 16 bits (gris ou RVB, alpha ignoré). */
export function decodeTiff(buf: ArrayBuffer | Uint8Array, opts: DecodeOptions = {}): Raster {
  const r = new Reader(buf);
  const ifd = mainIfd(listIfds(r));
  const width = num(ifd, TAG.ImageWidth);
  const height = num(ifd, TAG.ImageLength);
  const spp = num(ifd, TAG.SamplesPerPixel, 1);
  const bpsArr = ifd.tags.get(TAG.BitsPerSample) ?? [1];
  const bps = bpsArr[0];
  const compression = num(ifd, TAG.Compression, 1);
  const photometric = num(ifd, TAG.Photometric, spp >= 3 ? 2 : 1);
  const planar = num(ifd, TAG.PlanarConfiguration, 1);
  const predictor = num(ifd, TAG.Predictor, 1);
  const sampleFormat = num(ifd, TAG.SampleFormat, 1);

  if (![8, 16, 32].includes(bps)) throw new TiffError(`Profondeur ${bps} bits non prise en charge (8, 16 ou 32 bits).`);
  if (bps === 32 && sampleFormat !== 3) throw new TiffError('TIFF 32 bits entier non pris en charge (32 bits flottant uniquement).');
  if (photometric === 3) throw new TiffError('TIFF à palette non pris en charge.');
  if (photometric > 2) throw new TiffError(`Espace couleur TIFF ${photometric} non pris en charge (RVB ou niveaux de gris).`);
  if (photometric === 2 && spp < 3) throw new TiffError('TIFF RVB incomplet.');

  const outCh: 1 | 3 = photometric === 2 ? 3 : 1;
  const raster = createRaster(width, height, outCh, bps);
  const icc = ifd.tags.get(TAG.ICCProfile);
  if (icc instanceof Uint8Array) raster.icc = icc;
  const out = raster.data;
  const bytesPer = bps / 8;
  const invert = photometric === 0;

  const tiled = ifd.tags.has(TAG.TileOffsets);
  const blockW = tiled ? num(ifd, TAG.TileWidth) : width;
  const blockH = tiled ? num(ifd, TAG.TileLength) : Math.min(height, num(ifd, TAG.RowsPerStrip, height));
  const offsets = arr(ifd, tiled ? TAG.TileOffsets : TAG.StripOffsets);
  const counts = ifd.tags.has(tiled ? TAG.TileByteCounts : TAG.StripByteCounts)
    ? arr(ifd, tiled ? TAG.TileByteCounts : TAG.StripByteCounts)
    : offsets.map(() => width * blockH * spp * bytesPer);
  const across = tiled ? Math.ceil(width / blockW) : 1;
  const down = Math.ceil(height / blockH);
  const planes = planar === 2 ? spp : 1;
  const sampPerBlockPixel = planar === 2 ? 1 : spp;
  const rowBytes = blockW * sampPerBlockPixel * bytesPer;
  const view = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
  void view;

  const total = offsets.length;
  let doneBlocks = 0;
  for (let plane = 0; plane < planes; plane++) {
    for (let by = 0; by < down; by++) {
      for (let bx = 0; bx < across; bx++) {
        const idx = plane * across * down + by * across + bx;
        if (idx >= offsets.length) continue;
        const off = offsets[idx];
        const cnt = Math.min(counts[idx], r.bytes.length - off);
        const rowsInBlock = tiled ? blockH : Math.min(blockH, height - by * blockH);
        const expected = rowBytes * rowsInBlock;
        let data = decompress(compression, r.bytes.subarray(off, off + cnt), expected);
        if (predictor === 2) {
          if (data === r.bytes.subarray(off, off + cnt) || compression === 1) data = data.slice();
          undoHorizontalPredictor(data, rowBytes, rowsInBlock, sampPerBlockPixel, bps, r.le);
        } else if (predictor === 3) {
          throw new TiffError('Prédicteur flottant TIFF non pris en charge.');
        }
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const x0 = bx * blockW;
        const y0 = by * blockH;
        const wIn = Math.min(blockW, width - x0);
        const hIn = Math.min(rowsInBlock, height - y0);
        for (let yy = 0; yy < hIn; yy++) {
          const rowOff = yy * rowBytes;
          if (rowOff >= data.length) break;
          const dstRow = (y0 + yy) * width;
          for (let xx = 0; xx < wIn; xx++) {
            const px = rowOff + xx * sampPerBlockPixel * bytesPer;
            const dst = (dstRow + x0 + xx) * outCh;
            if (planar === 2) {
              if (plane >= outCh) continue;
              out[dst + plane] = readSample(dv, px, bps, r.le, invert);
            } else {
              for (let c = 0; c < outCh; c++) {
                out[dst + c] = readSample(dv, px + c * bytesPer, bps, r.le, invert);
              }
            }
          }
        }
        doneBlocks++;
        if (opts.onProgress && (doneBlocks & 7) === 0) opts.onProgress(doneBlocks / total);
      }
    }
  }
  return raster;
}

function readSample(dv: DataView, o: number, bps: number, le: boolean, invert: boolean): number {
  if (o + bps / 8 > dv.byteLength) return 0;
  let v: number;
  if (bps === 8) v = dv.getUint8(o) * 257;
  else if (bps === 16) v = dv.getUint16(o, le);
  else v = Math.round(Math.min(1, Math.max(0, dv.getFloat32(o, le))) * 65535);
  return invert ? 65535 - v : v;
}

function undoHorizontalPredictor(data: Uint8Array, rowBytes: number, rows: number, spp: number, bps: number, le: boolean) {
  if (bps === 8) {
    for (let y = 0; y < rows; y++) {
      const base = y * rowBytes;
      for (let i = spp; i < rowBytes && base + i < data.length; i++) {
        data[base + i] = (data[base + i] + data[base + i - spp]) & 0xff;
      }
    }
  } else if (bps === 16) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const n = rowBytes / 2;
    for (let y = 0; y < rows; y++) {
      const base = y * rowBytes;
      for (let i = spp; i < n; i++) {
        const o = base + i * 2;
        if (o + 2 > data.length) break;
        const v = (dv.getUint16(o, le) + dv.getUint16(o - spp * 2, le)) & 0xffff;
        dv.setUint16(o, v, le);
      }
    }
  }
}
