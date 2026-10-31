import { create } from 'zustand';
import { findPreset } from '../core/presets.ts';
import { applyTemplate, stripExtension, uniqueNames } from '../core/naming.ts';
import { db } from '../state/db.ts';
import { fileRef, itemById, notify, useStore } from '../state/store.ts';
import { CancelledError, createWorker, estimateWeightMB, MEMORY_BUDGET_MB, WorkerPool } from '../workers/pool.ts';
import type { ExportFormat } from '../workers/protocol.ts';
import { downloadBlob, MemorySink, pickZipSink, ZipStream, type Sink } from './zip.ts';

export interface ExportOptions {
  format: ExportFormat;
  /** Qualité JPEG 0..1. */
  quality: number;
  template: string;
  /** 2 à 4 travaux en parallèle. */
  concurrency: number;
  zip: boolean;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface Job { itemId: string; name: string; fileName: string; status: JobStatus; progress: number; error?: string }

export interface Batch {
  id: string;
  createdAt: number;
  options: ExportOptions;
  jobs: Job[];
  state: 'running' | 'interrupted' | 'finishing' | 'done' | 'cancelled';
  zipName: string;
}

interface QueueState { batch: Batch | null }

export const useQueue = create<QueueState>(() => ({ batch: null }));

export const EXT: Record<ExportFormat, string> = { jpeg: 'jpg', png: 'png', tiff16: 'tif' };

let pool: WorkerPool | null = null;
let poolSize = 0;
let aborts = new Map<string, AbortController>();
let zip: ZipStream | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function setBatch(fn: (b: Batch) => Batch) {
  const b = useQueue.getState().batch;
  if (!b) return;
  const next = fn(b);
  useQueue.setState({ batch: next });
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void db.saveQueue(stripRuntime(useQueue.getState().batch)), 250);
}

function stripRuntime(b: Batch | null): Batch | undefined {
  if (!b || b.state === 'done' || b.state === 'cancelled') return undefined;
  return { ...b, jobs: b.jobs.map((j) => ({ ...j, status: j.status === 'running' ? 'pending' : j.status, progress: j.status === 'done' ? 1 : 0 })) };
}

function patchJob(itemId: string, patch: Partial<Job>) {
  setBatch((b) => ({ ...b, jobs: b.jobs.map((j) => (j.itemId === itemId ? { ...j, ...patch } : j)) }));
}

export function planNames(ids: string[], opts: ExportOptions): Job[] {
  const items = ids.map(itemById).filter((x) => !!x);
  const presets = useStore.getState().userPresets;
  const base = items.map((it, i) =>
    applyTemplate(opts.template, { name: stripExtension(it!.name), film: findPreset(it!.settings.presetId, presets)?.id ?? 'sans-preset', index: i + 1 }),
  );
  const names = uniqueNames(base, EXT[opts.format]);
  return items.map((it, i) => ({ itemId: it!.id, name: it!.name, fileName: names[i], status: 'pending', progress: 0 }));
}

/**
 * Lance un export. Doit être appelé depuis un geste utilisateur (choix de l'emplacement
 * du ZIP). Une seule image sans ZIP = téléchargement direct.
 */
export async function startExport(ids: string[], opts: ExportOptions) {
  if (useQueue.getState().batch?.state === 'running') {
    notify('Un export est déjà en cours.', 'error');
    return;
  }
  const jobs = planNames(ids, opts);
  if (!jobs.length) return;
  const id = `b${Date.now().toString(36)}`;
  const zipName = `export_${new Date().toISOString().slice(0, 10)}.zip`;
  let sink: Sink | undefined;
  if (opts.zip) {
    try { sink = await pickZipSink(zipName); } catch { return; }
  }
  const batch: Batch = { id, createdAt: Date.now(), options: opts, jobs, state: 'running', zipName };
  useQueue.setState({ batch });
  await db.saveQueue(stripRuntime(batch));
  await runBatch(sink);
}

/** Reprend un export interrompu (rechargement de page). */
export async function resumeExport() {
  const b = useQueue.getState().batch;
  if (!b || b.state !== 'interrupted') return;
  let sink: Sink | undefined;
  if (b.options.zip) {
    try { sink = await pickZipSink(b.zipName); } catch { return; }
  }
  setBatch((x) => ({ ...x, state: 'running', jobs: x.jobs.map((j) => (j.status === 'error' || j.status === 'cancelled' ? { ...j, status: 'pending', error: undefined } : j)) }));
  await runBatch(sink);
}

async function runBatch(sink?: Sink) {
  const b = useQueue.getState().batch!;
  const size = Math.min(4, Math.max(2, b.options.concurrency));
  if (!pool || poolSize !== size) {
    pool?.terminate();
    pool = new WorkerPool(size, createWorker, MEMORY_BUDGET_MB);
    poolSize = size;
  }
  aborts = new Map();
  zip = sink ? new ZipStream(sink) : null;

  // Sorties déjà calculées avant le rechargement : écrites en premier.
  if (zip) {
    for (const j of b.jobs.filter((x) => x.status === 'done')) {
      const blob = await db.loadOutput(b.id, j.itemId);
      if (blob) await zip.add(j.fileName, blob);
      else patchJob(j.itemId, { status: 'pending', progress: 0 });
    }
  }

  const pending = useQueue.getState().batch!.jobs.filter((j) => j.status === 'pending');
  await Promise.all(pending.map((j) => runJob(b.id, j)));

  const final = useQueue.getState().batch;
  if (!final || final.id !== b.id) return;
  if (final.state === 'cancelled') return;
  const ok = final.jobs.filter((j) => j.status === 'done').length;
  const failed = final.jobs.filter((j) => j.status === 'error').length;
  if (zip) {
    setBatch((x) => ({ ...x, state: 'finishing' }));
    try {
      const blob = await zip.finish();
      if (blob) downloadBlob(blob, final.zipName);
    } catch (e) {
      notify(`Écriture du ZIP impossible : ${e instanceof Error ? e.message : e}`, 'error', 0);
    }
    zip = null;
  }
  setBatch((x) => ({ ...x, state: 'done' }));
  await db.saveQueue(undefined);
  await db.clearOutputs(final.id);
  notify(failed ? `Export terminé : ${ok} réussie(s), ${failed} en erreur.` : `Export terminé : ${ok} image(s).`, failed ? 'error' : 'success', 8000);
}

async function runJob(batchId: string, job: Job) {
  const b = useQueue.getState().batch;
  const item = itemById(job.itemId);
  if (!b || !item) { patchJob(job.itemId, { status: 'error', error: 'Image retirée' }); return; }
  const ac = new AbortController();
  aborts.set(job.itemId, ac);
  patchJob(job.itemId, { status: 'running', progress: 0 });
  try {
    const presets = useStore.getState().userPresets;
    const res = await pool!.run(
      'export',
      {
        ref: fileRef(item),
        settings: item.settings,
        look: findPreset(item.settings.presetId, presets),
        analysis: item.analysis,
        format: b.options.format,
        quality: b.options.quality,
      },
      {
        signal: ac.signal,
        weight: estimateWeightMB(item.info ? item.info.width * item.info.height : undefined, item.size),
        onProgress: (p) => patchJob(job.itemId, { progress: p }),
      },
    );
    if (useQueue.getState().batch?.id !== batchId) return;
    // Conservée jusqu'à la fin du lot : permet la reprise après rechargement.
    if (b.options.zip) await db.saveOutput(batchId, job.itemId, res.blob).catch(() => undefined);
    if (zip) await zip.add(job.fileName, res.blob);
    else downloadBlob(res.blob, job.fileName);
    patchJob(job.itemId, { status: 'done', progress: 1 });
  } catch (e) {
    if (e instanceof CancelledError) patchJob(job.itemId, { status: 'cancelled' });
    else patchJob(job.itemId, { status: 'error', error: e instanceof Error ? e.message : String(e) });
  } finally {
    aborts.delete(job.itemId);
  }
}

export function cancelJob(itemId: string) {
  aborts.get(itemId)?.abort();
  const j = useQueue.getState().batch?.jobs.find((x) => x.itemId === itemId);
  if (j && j.status === 'pending') patchJob(itemId, { status: 'cancelled' });
}

export async function cancelBatch() {
  const b = useQueue.getState().batch;
  if (!b) return;
  setBatch((x) => ({ ...x, state: 'cancelled', jobs: x.jobs.map((j) => (j.status === 'pending' || j.status === 'running' ? { ...j, status: 'cancelled' } : j)) }));
  for (const ac of aborts.values()) ac.abort();
  await zip?.abort();
  zip = null;
  await db.saveQueue(undefined);
  await db.clearOutputs(b.id);
  notify('Export annulé.', 'info');
}

export function dismissBatch() {
  const b = useQueue.getState().batch;
  if (b && (b.state === 'running' || b.state === 'finishing')) return;
  if (b?.state === 'interrupted') { void db.saveQueue(undefined); void db.clearOutputs(b.id); }
  useQueue.setState({ batch: null });
}

/** Au démarrage : retrouve un export interrompu. */
export async function restoreQueue() {
  const saved = await db.loadQueue<Batch>();
  if (saved && saved.jobs.some((j) => j.status !== 'done')) useQueue.setState({ batch: { ...saved, state: 'interrupted' } });
  else if (saved) await db.saveQueue(undefined);
}

export function overallProgress(b: Batch): number {
  const active = b.jobs.filter((j) => j.status !== 'cancelled');
  if (!active.length) return 0;
  return active.reduce((s, j) => s + (j.status === 'done' ? 1 : j.status === 'error' ? 1 : j.progress), 0) / active.length;
}

export { MemorySink };
