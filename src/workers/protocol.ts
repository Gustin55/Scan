import type { Analysis } from '../core/compile.ts';
import type { FilmLook } from '../core/presets.ts';
import type { Settings, TransferOverride } from '../core/settings.ts';

/** Référence à un fichier source, transmissible à un worker. */
export interface FileRef {
  id: string;
  name: string;
  kind: 'tiff' | 'jpeg';
  file?: File;
  handle?: FileSystemFileHandle;
}

export interface ImageInfo {
  width: number;
  height: number;
  bits: number;
  channels: number;
  profile: string;
  warning?: string;
}

/** Proxy basse résolution conservé dans IndexedDB (rendu des miniatures, carte de halo). */
export interface StoredProxy {
  width: number;
  height: number;
  data: Uint16Array; // RVB 16 bits
  icc?: Uint8Array;
  kind: 'tiff' | 'jpeg';
}

export interface ThumbRequest {
  ref: FileRef;
  settings: Settings;
  look?: FilmLook;
  /** Si vrai, réutilise le proxy en cache au lieu de redécoder le fichier. */
  useCache: boolean;
}
export interface ThumbResult {
  info: ImageInfo;
  analysis: Analysis;
  thumb: Blob;
}

export interface PreviewRequest {
  ref: FileRef;
  maxEdge: number;
  transfer: TransferOverride;
  /** Si fournis, une miniature est aussi produite (évite un second décodage). */
  settings?: Settings;
  look?: FilmLook;
}
export interface PreviewResult {
  info: ImageInfo;
  analysis: Analysis;
  icc?: Uint8Array;
  preview: { width: number; height: number; data: Uint16Array };
  proxy: { width: number; height: number; data: Uint16Array };
  thumb?: Blob;
}

export type ExportFormat = 'jpeg' | 'png' | 'tiff16';
export interface ExportRequest {
  ref: FileRef;
  settings: Settings;
  look?: FilmLook;
  analysis?: Analysis;
  format: ExportFormat;
  quality: number;
}
export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  ms: number;
}

export interface AnalyzeRequest { ref: FileRef; transfer: TransferOverride }

export interface Methods {
  thumb: (r: ThumbRequest) => ThumbResult;
  preview: (r: PreviewRequest) => PreviewResult;
  export: (r: ExportRequest) => ExportResult;
  analyze: (r: AnalyzeRequest) => Analysis;
}

export type Method = keyof Methods;

export type WorkerIn =
  | { type: 'call'; id: number; method: Method; arg: unknown }
  | { type: 'cancel'; id: number };

export type WorkerOut =
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string; cancelled?: boolean }
  | { type: 'progress'; id: number; value: number };
