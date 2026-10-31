/** Décodage et rendu côté worker (aucun accès au DOM). */
import { analyze } from '../core/analysis.ts';
import { compile, packTrc, type Analysis } from '../core/compile.ts';
import { defaultInputColor, parseIcc, type InputColor } from '../core/icc.ts';
import { buildHalationMap, renderRaster } from '../core/pipeline.ts';
import { downscale, rasterFromRGBA8, type Raster } from '../core/raster.ts';
import type { TransferOverride } from '../core/settings.ts';
import { decodeTiff, readTiffInfo } from '../core/tiff/decode.ts';
import { u16ToHalfTable } from '../core/half.ts';
import type { FileRef, ImageInfo, StoredProxy } from './protocol.ts';

export const PROXY_EDGE = 640;
/** Côté long de l'aperçu ; le proxy en est dérivé (calcul identique à l'export). */
export const PREVIEW_EDGE = 2560;
export const THUMB_EDGE = 320;

export async function getFile(ref: FileRef): Promise<File> {
  if (ref.file) return ref.file;
  if (ref.handle) {
    try {
      return await ref.handle.getFile();
    } catch {
      throw new Error(`Accès au fichier « ${ref.name} » perdu : rétablissez l’accès ou réimportez-le.`);
    }
  }
  throw new Error(`Fichier « ${ref.name} » indisponible : réimportez-le.`);
}

export interface Decoded { raster: Raster; info: ImageInfo; color: InputColor }

export function inputColorFor(icc: Uint8Array | undefined, kind: 'tiff' | 'jpeg', transfer: TransferOverride): InputColor {
  if (transfer === 'srgb' || transfer === 'linear' || transfer === 'gamma22') return defaultInputColor(transfer);
  // Les JPEG sont convertis en sRGB par le navigateur au décodage.
  if (kind === 'jpeg') return defaultInputColor('srgb');
  return parseIcc(icc);
}

async function decodeJpeg(file: Blob, resize?: number): Promise<Raster> {
  let opts: ImageBitmapOptions = { colorSpaceConversion: 'default', imageOrientation: 'from-image', premultiplyAlpha: 'none' };
  let bmp = await createImageBitmap(file, opts);
  if (resize && Math.max(bmp.width, bmp.height) > resize) {
    const s = resize / Math.max(bmp.width, bmp.height);
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    bmp.close();
    opts = { ...opts, resizeWidth: w, resizeHeight: h, resizeQuality: 'high' };
    bmp = await createImageBitmap(file, opts);
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' } as CanvasRenderingContext2DSettings)!;
  ctx.drawImage(bmp, 0, 0);
  const { width, height } = bmp;
  bmp.close();
  const img = ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' } as ImageDataSettings);
  return rasterFromRGBA8(img.data, width, height);
}

export async function decodeFull(ref: FileRef, transfer: TransferOverride, onProgress?: (p: number) => void): Promise<Decoded> {
  const file = await getFile(ref);
  if (ref.kind === 'tiff') {
    const buf = new Uint8Array(await file.arrayBuffer());
    const raster = decodeTiff(buf, { onProgress });
    const color = inputColorFor(raster.icc, 'tiff', transfer);
    return { raster, color, info: infoOf(raster, color) };
  }
  const raster = await decodeJpeg(file);
  const color = inputColorFor(undefined, 'jpeg', transfer);
  return { raster, color, info: infoOf(raster, color) };
}

function infoOf(r: Raster, color: InputColor): ImageInfo {
  return { width: r.width, height: r.height, bits: r.sourceBits, channels: r.channels, profile: color.name, warning: color.warning };
}

/** Proxy de référence : même calcul à l'aperçu et à l'export (carte de halo identique). */
export async function makeProxy(ref: FileRef, full?: Raster): Promise<Raster> {
  if (ref.kind === 'jpeg') return decodeJpeg(await getFile(ref), PROXY_EDGE);
  if (!full) throw new Error('proxy TIFF sans image décodée');
  return downscale(previewOf(full), PROXY_EDGE);
}

/** Réduction à la taille d'aperçu (identité si l'image est déjà plus petite). */
export function previewOf(full: Raster): Raster {
  return Math.max(full.width, full.height) > PREVIEW_EDGE ? downscale(full, PREVIEW_EDGE) : full;
}

export function toStoredProxy(r: Raster, kind: 'tiff' | 'jpeg', icc?: Uint8Array): StoredProxy {
  return { width: r.width, height: r.height, data: r.data, icc, kind };
}
export function fromStoredProxy(p: StoredProxy): Raster {
  return { width: p.width, height: p.height, channels: 3, data: p.data, sourceBits: 16, icc: p.icc };
}

/** Convertit un raster en texture RGBA demi-flottant. */
export function toHalfRGBA(r: Raster): Uint16Array {
  const t = u16ToHalfTable();
  const n = r.width * r.height;
  const out = new Uint16Array(n * 4);
  const one = 0x3c00;
  const ch = r.channels;
  for (let i = 0; i < n; i++) {
    const s = i * ch;
    const v = r.data[s];
    out[i * 4] = t[v];
    out[i * 4 + 1] = ch === 3 ? t[r.data[s + 1]] : t[v];
    out[i * 4 + 2] = ch === 3 ? t[r.data[s + 2]] : t[v];
    out[i * 4 + 3] = one;
  }
  return out;
}

export function analyzeProxy(proxy: Raster, color: InputColor): Analysis {
  return analyze(proxy, color);
}

export { compile, packTrc, buildHalationMap, renderRaster, downscale, readTiffInfo };
