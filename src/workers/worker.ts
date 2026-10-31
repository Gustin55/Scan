/// <reference lib="webworker" />
import { get, set } from 'idb-keyval';
import { compile } from '../core/compile.ts';
import { buildHalationMap, renderRaster, RenderAborted } from '../core/pipeline.ts';
import { downscale, type Raster } from '../core/raster.ts';
import { transformRaster } from '../core/geometry.ts';
import { encodeTiff } from '../core/tiff/encode.ts';
import { buildSrgbIcc, type InputColor } from '../core/icc.ts';
import type { Analysis } from '../core/compile.ts';
import type { FilmLook } from '../core/presets.ts';
import type { Settings } from '../core/settings.ts';
import {
  analyzeProxy, decodeFull, fromStoredProxy, inputColorFor, makeProxy, PREVIEW_EDGE, previewOf, PROXY_EDGE, THUMB_EDGE, toHalfRGBA, toStoredProxy,
} from './imaging.ts';
import type {
  AnalyzeRequest, ExportRequest, ExportResult, PreviewRequest, PreviewResult, StoredProxy, ThumbRequest, ThumbResult, WorkerIn, WorkerOut, ImageInfo,
} from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

const cancelled = new Set<number>();

const post = (m: WorkerOut, transfer: Transferable[] = []) => self.postMessage(m, transfer);

async function rgbaToBlob(rgba: Uint8ClampedArray, w: number, h: number, type: string, quality?: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' } as CanvasRenderingContext2DSettings)!;
  ctx.putImageData(new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return canvas.convertToBlob({ type, quality });
}

const proxyKey = (id: string) => `proxy:${id}`;
const infoKey = (id: string) => `info:${id}`;

async function thumb(r: ThumbRequest, id: number): Promise<ThumbResult> {
  let proxy: Raster | undefined;
  let info: ImageInfo | undefined;
  let icc: Uint8Array | undefined;
  if (r.useCache) {
    const stored = await get<StoredProxy>(proxyKey(r.ref.id));
    info = await get<ImageInfo>(infoKey(r.ref.id));
    if (stored && info) { proxy = fromStoredProxy(stored); icc = stored.icc; }
  }
  if (!proxy || !info) {
    const full = await decodeFull(r.ref, 'profile', (p) => post({ type: 'progress', id, value: p * 0.8 }));
    proxy = await makeProxy(r.ref, full.raster);
    info = full.info;
    icc = full.raster.icc;
    await set(proxyKey(r.ref.id), toStoredProxy(proxy, r.ref.kind, icc));
    await set(infoKey(r.ref.id), info);
  }
  const color = inputColorFor(icc, r.ref.kind, r.settings.input.transfer);
  const analysis = analyzeProxy(proxy, color);
  return { info, analysis, thumb: await renderThumb(proxy, r.settings, r.look, analysis, color) };
}

async function renderThumb(rawProxy: Raster, settings: Settings, look: FilmLook | undefined, analysis: Analysis, color: InputColor): Promise<Blob> {
  const proxy = transformRaster(rawProxy, settings.geometry);
  const small = downscale(proxy, THUMB_EDGE);
  const c = compile({ settings, look, analysis, color });
  // Le halo de la miniature vient du proxy : même rendu que l'aperçu.
  const rgba = renderRaster(small, c, { output: 'rgba8', halation: buildHalationMap(proxy, c) }) as Uint8ClampedArray;
  return rgbaToBlob(rgba, small.width, small.height, 'image/jpeg', 0.85);
}

async function preview(r: PreviewRequest, id: number): Promise<{ value: PreviewResult; transfer: Transferable[] }> {
  const full = await decodeFull(r.ref, r.transfer, (p) => post({ type: 'progress', id, value: p * 0.7 }));
  const prev = r.maxEdge >= PREVIEW_EDGE ? previewOf(full.raster) : downscale(full.raster, r.maxEdge);
  // Même calcul que makeProxy (TIFF) : réduction de l'aperçu 2560 px.
  const proxy = r.ref.kind === 'tiff' && r.maxEdge >= PREVIEW_EDGE ? downscale(prev, PROXY_EDGE) : await makeProxy(r.ref, full.raster);
  const analysis = analyzeProxy(proxy, full.color);
  const thumbBlob = r.settings ? await renderThumb(proxy, r.settings, r.look, analysis, full.color) : undefined;
  const pv = toHalfRGBA(prev);
  const px = toHalfRGBA(proxy);
  const icc = full.raster.icc;
  await set(proxyKey(r.ref.id), toStoredProxy(proxy, r.ref.kind, icc));
  await set(infoKey(r.ref.id), full.info);
  return {
    value: {
      info: full.info,
      analysis,
      icc,
      preview: { width: prev.width, height: prev.height, data: pv },
      proxy: { width: proxy.width, height: proxy.height, data: px },
      thumb: thumbBlob,
    },
    transfer: [pv.buffer, px.buffer],
  };
}

let srgbIcc: Uint8Array | undefined;

async function exportImage(r: ExportRequest, id: number): Promise<ExportResult> {
  const t0 = performance.now();
  const progress = (p: number) => post({ type: 'progress', id, value: p });
  let full: Raster | undefined;
  const decoded = await decodeFull(r.ref, r.settings.input.transfer, (p) => progress(p * 0.25));
  full = decoded.raster;
  const rawProxy = await makeProxy(r.ref, full);
  const analysis = r.analysis ?? analyzeProxy(rawProxy, decoded.color);
  const c = compile({ settings: r.settings, look: r.look, analysis, color: decoded.color });
  // Cadrage appliqué avant le rendu (grain, vignettage et halo suivent l'image cadrée).
  const halation = buildHalationMap(transformRaster(rawProxy, r.settings.geometry), c);
  full = transformRaster(full, r.settings.geometry);
  const { width, height } = full;
  const shouldAbort = () => cancelled.has(id);
  if (r.format === 'tiff16') {
    const out = renderRaster(full, c, { output: 'rgb16', halation, onProgress: (p) => progress(0.25 + p * 0.6), shouldAbort }) as Uint16Array;
    full = undefined;
    srgbIcc ??= buildSrgbIcc();
    const bytes = encodeTiff({ width, height, channels: 3, data: out, sourceBits: 16 }, { bits: 16, compression: 'deflate', icc: srgbIcc });
    progress(1);
    return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/tiff' }), width, height, ms: performance.now() - t0 };
  }
  const rgba = renderRaster(full, c, { output: 'rgba8', halation, onProgress: (p) => progress(0.25 + p * 0.6), shouldAbort }) as Uint8ClampedArray;
  full = undefined;
  const blob = await rgbaToBlob(rgba, width, height, r.format === 'png' ? 'image/png' : 'image/jpeg', r.quality);
  progress(1);
  return { blob, width, height, ms: performance.now() - t0 };
}

async function analyzeOnly(r: AnalyzeRequest) {
  const stored = await get<StoredProxy>(proxyKey(r.ref.id));
  let proxy: Raster;
  let icc: Uint8Array | undefined;
  if (stored) { proxy = fromStoredProxy(stored); icc = stored.icc; }
  else {
    const full = await decodeFull(r.ref, r.transfer);
    proxy = await makeProxy(r.ref, full.raster);
    icc = full.raster.icc;
  }
  return analyzeProxy(proxy, inputColorFor(icc, r.ref.kind, r.transfer));
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') { cancelled.add(msg.id); return; }
  const { id, method, arg } = msg;
  try {
    let value: unknown;
    let transfer: Transferable[] = [];
    switch (method) {
      case 'thumb': value = await thumb(arg as ThumbRequest, id); break;
      case 'preview': ({ value, transfer } = await preview(arg as PreviewRequest, id)); break;
      case 'export': value = await exportImage(arg as ExportRequest, id); break;
      case 'analyze': value = await analyzeOnly(arg as AnalyzeRequest); break;
    }
    if (cancelled.has(id)) post({ type: 'error', id, message: 'Annulé', cancelled: true });
    else post({ type: 'result', id, value }, transfer);
  } catch (e) {
    const aborted = e instanceof RenderAborted || cancelled.has(id);
    post({ type: 'error', id, message: aborted ? 'Annulé' : e instanceof Error ? e.message : String(e), cancelled: aborted });
  } finally {
    cancelled.delete(id);
  }
};

export { PROXY_EDGE };
