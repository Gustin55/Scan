import { zlibSync } from 'fflate';
import type { Raster } from '../raster.ts';
import { TAG } from './decode.ts';
import { lzwEncode } from './lzw.ts';

export interface TiffEncodeOptions {
  /** 8 ou 16 bits par échantillon. */
  bits?: 8 | 16;
  compression?: 'none' | 'deflate' | 'lzw';
  /** Prédicteur horizontal (améliore la compression Deflate/LZW). */
  predictor?: boolean;
  icc?: Uint8Array;
  rowsPerStrip?: number;
  software?: string;
  /** Étiquette Orientation (1 = normale). */
  orientation?: number;
}

interface Entry { tag: number; type: number; values: number[] | Uint8Array }

/** Encode un raster en TIFF petit-boutiste (une image, bandes). */
export function encodeTiff(raster: Raster, opts: TiffEncodeOptions = {}): Uint8Array {
  const bits = opts.bits ?? 16;
  const compression = opts.compression ?? 'deflate';
  const predictor = opts.predictor ?? compression !== 'none';
  const { width, height, channels } = raster;
  const bytesPer = bits / 8;
  const rowBytes = width * channels * bytesPer;
  const rps = opts.rowsPerStrip ?? Math.max(1, Math.floor((256 * 1024) / rowBytes));
  const strips: Uint8Array[] = [];
  for (let y0 = 0; y0 < height; y0 += rps) {
    const rows = Math.min(rps, height - y0);
    const buf = new Uint8Array(rows * rowBytes);
    const dv = new DataView(buf.buffer);
    for (let y = 0; y < rows; y++) {
      const src = (y0 + y) * width * channels;
      const dst = y * rowBytes;
      if (bits === 16) {
        if (predictor) {
          for (let i = 0; i < width * channels; i++) {
            const prev = i >= channels ? raster.data[src + i - channels] : 0;
            dv.setUint16(dst + i * 2, (raster.data[src + i] - prev) & 0xffff, true);
          }
        } else {
          for (let i = 0; i < width * channels; i++) dv.setUint16(dst + i * 2, raster.data[src + i], true);
        }
      } else {
        for (let i = 0; i < width * channels; i++) {
          const v = raster.data[src + i] >> 8;
          const prev = predictor && i >= channels ? raster.data[src + i - channels] >> 8 : 0;
          buf[dst + i] = (v - prev) & 0xff;
        }
      }
    }
    strips.push(
      compression === 'deflate' ? zlibSync(buf, { level: 6 }) : compression === 'lzw' ? lzwEncode(buf) : buf,
    );
  }

  const comp = compression === 'deflate' ? 8 : compression === 'lzw' ? 5 : 1;
  const software = new TextEncoder().encode((opts.software ?? 'Scan pellicule') + '\0');
  const entries: Entry[] = [
    { tag: TAG.ImageWidth, type: 4, values: [width] },
    { tag: TAG.ImageLength, type: 4, values: [height] },
    { tag: TAG.BitsPerSample, type: 3, values: new Array(channels).fill(bits) },
    { tag: TAG.Compression, type: 3, values: [comp] },
    { tag: TAG.Photometric, type: 3, values: [channels === 3 ? 2 : 1] },
    { tag: TAG.StripOffsets, type: 4, values: strips.map(() => 0) },
    { tag: TAG.SamplesPerPixel, type: 3, values: [channels] },
    { tag: TAG.RowsPerStrip, type: 4, values: [rps] },
    { tag: TAG.StripByteCounts, type: 4, values: strips.map((s) => s.length) },
    { tag: TAG.XResolution, type: 5, values: [300, 1] },
    { tag: TAG.YResolution, type: 5, values: [300, 1] },
    { tag: TAG.PlanarConfiguration, type: 3, values: [1] },
    { tag: TAG.ResolutionUnit, type: 3, values: [2] },
    { tag: TAG.Software, type: 2, values: software },
  ];
  if (opts.orientation && opts.orientation !== 1) entries.push({ tag: TAG.Orientation, type: 3, values: [opts.orientation] });
  if (predictor && comp !== 1) entries.push({ tag: TAG.Predictor, type: 3, values: [2] });
  entries.push({ tag: TAG.SampleFormat, type: 3, values: new Array(channels).fill(1) });
  if (opts.icc) entries.push({ tag: TAG.ICCProfile, type: 7, values: opts.icc });
  entries.sort((a, b) => a.tag - b.tag);

  const typeSize: Record<number, number> = { 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 0;
  const extraOffsets = new Map<Entry, number>();
  const ifdOffset = 8;
  let cursor = ifdOffset + ifdSize;
  for (const e of entries) {
    const count = e.type === 5 ? e.values.length / 2 : e.values.length;
    const size = count * typeSize[e.type];
    if (size > 4) {
      extraOffsets.set(e, cursor);
      cursor += size + (size & 1);
      extra += size + (size & 1);
    }
  }
  let dataOffset = cursor;
  const stripOffsets = strips.map((s) => {
    const o = dataOffset;
    dataOffset += s.length + (s.length & 1);
    return o;
  });
  const so = entries.find((e) => e.tag === TAG.StripOffsets)!;
  so.values = stripOffsets;

  const total = dataOffset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0x4949, false);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOffset, true);
  dv.setUint16(ifdOffset, entries.length, true);
  entries.forEach((e, i) => {
    const p = ifdOffset + 2 + i * 12;
    const count = e.type === 5 ? e.values.length / 2 : e.values.length;
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, count, true);
    const target = extraOffsets.get(e) ?? p + 8;
    if (extraOffsets.has(e)) dv.setUint32(p + 8, target, true);
    writeValues(dv, out, target, e);
  });
  dv.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);
  strips.forEach((s, i) => out.set(s, stripOffsets[i]));
  void extra;
  return out;
}

function writeValues(dv: DataView, out: Uint8Array, at: number, e: Entry) {
  const v = e.values;
  switch (e.type) {
    case 2: case 7: out.set(v as Uint8Array, at); break;
    case 3: for (let i = 0; i < v.length; i++) dv.setUint16(at + i * 2, v[i], true); break;
    case 4: for (let i = 0; i < v.length; i++) dv.setUint32(at + i * 4, v[i], true); break;
    case 5: for (let i = 0; i < v.length; i++) dv.setUint32(at + i * 4, v[i], true); break;
  }
}
