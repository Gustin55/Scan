import type { Method, Methods, WorkerIn, WorkerOut } from './protocol.ts';

type Arg<M extends Method> = Parameters<Methods[M]>[0];
type Ret<M extends Method> = ReturnType<Methods[M]>;

export class CancelledError extends Error {
  constructor() { super('Annulé'); }
}

interface Task {
  id: number;
  method: Method;
  arg: unknown;
  priority: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
  weight: number;
}

interface Slot { worker: Worker; busy: Task | null }

let nextId = 1;

/** Petit pool de workers avec file prioritaire, progression et annulation. */
export class WorkerPool {
  private slots: Slot[] = [];
  private queue: Task[] = [];
  /**
   * @param budget poids maximal en cours (ex. mégaoctets de fichiers en mémoire) ;
   *   une tâche plus lourde que le budget s'exécute seule.
   */
  constructor(size: number, private factory: () => Worker, private budget = Infinity) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const worker = this.factory();
    const slot: Slot = { worker, busy: null };
    worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data;
      const t = slot.busy;
      if (!t || t.id !== m.id) return;
      if (m.type === 'progress') { t.onProgress?.(m.value); return; }
      slot.busy = null;
      if (m.type === 'result') t.resolve(m.value);
      else t.reject(m.cancelled ? new CancelledError() : new Error(m.message));
      this.pump();
    };
    worker.onerror = (ev) => {
      const t = slot.busy;
      slot.busy = null;
      t?.reject(new Error(ev.message || 'Erreur du worker (mémoire insuffisante ?)'));
      // Un worker planté est remplacé.
      worker.terminate();
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots[i] = this.spawn();
      this.pump();
    };
    return slot;
  }

  get size() { return this.slots.length; }
  get pending() { return this.queue.length + this.slots.filter((s) => s.busy).length; }

  run<M extends Method>(
    method: M, arg: Arg<M>,
    opts: { priority?: number; onProgress?: (p: number) => void; signal?: AbortSignal; weight?: number } = {},
  ): Promise<Ret<M>> {
    return new Promise<Ret<M>>((resolve, reject) => {
      if (opts.signal?.aborted) { reject(new CancelledError()); return; }
      const task: Task = {
        id: nextId++, method, arg, priority: opts.priority ?? 0,
        resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress, signal: opts.signal, weight: opts.weight ?? 1,
      };
      opts.signal?.addEventListener('abort', () => this.cancel(task), { once: true });
      this.queue.push(task);
      this.queue.sort((a, b) => b.priority - a.priority);
      this.pump();
    });
  }

  private cancel(task: Task) {
    const qi = this.queue.indexOf(task);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      task.reject(new CancelledError());
      return;
    }
    const slot = this.slots.find((s) => s.busy === task);
    if (!slot) return;
    // Arrêt immédiat : le worker est remplacé, sa mémoire (image décodée) est libérée.
    slot.worker.postMessage({ type: 'cancel', id: task.id } satisfies WorkerIn);
    slot.worker.terminate();
    slot.busy = null;
    const i = this.slots.indexOf(slot);
    if (i >= 0) this.slots[i] = this.spawn();
    task.reject(new CancelledError());
    this.pump();
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy || !this.queue.length) continue;
      const inflight = this.slots.reduce((s, x) => s + (x.busy ? x.busy.weight : 0), 0);
      const busy = this.slots.some((x) => x.busy);
      if (busy && inflight + this.queue[0].weight > this.budget) return;
      const task = this.queue.shift()!;
      slot.busy = task;
      slot.worker.postMessage({ type: 'call', id: task.id, method: task.method, arg: task.arg } satisfies WorkerIn);
    }
  }

  /** Retire de la file les tâches non démarrées qui satisfont le prédicat. */
  drop(pred: (method: Method, arg: unknown) => boolean) {
    this.queue = this.queue.filter((t) => {
      if (pred(t.method, t.arg)) { t.reject(new CancelledError()); return false; }
      return true;
    });
  }

  terminate() {
    for (const s of this.slots) s.worker.terminate();
    this.slots = [];
  }
}

export const createWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'scan-worker' });

/**
 * Budget mémoire des tâches simultanées, en Mo de pixels décodés (≈ 6 octets par pixel
 * pour un raster RVB 16 bits, plus le tampon de sortie).
 */
export const MEMORY_BUDGET_MB = 900;

/** Estimation de la mémoire d'une tâche à partir des dimensions ou de la taille du fichier. */
export function estimateWeightMB(px: number | undefined, fileBytes: number): number {
  if (px) return (px * 10) / 1e6;
  return Math.max(1, (fileBytes * 2) / 1e6);
}

const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
/** Miniatures et analyse en arrière-plan. */
export const backgroundPool = new WorkerPool(Math.min(3, Math.max(1, cores - 1)), createWorker, MEMORY_BUDGET_MB);
/** Aperçu de l'image ouverte : jamais bloqué derrière les miniatures. */
export const interactivePool = new WorkerPool(1, createWorker);
