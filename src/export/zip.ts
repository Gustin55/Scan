import { Zip, ZipPassThrough } from 'fflate';

/** Destination d'un flux : fichier sur disque (File System Access) ou Blob en mémoire. */
export interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<Blob | null>;
  abort(): Promise<void>;
}

export class MemorySink implements Sink {
  private parts: Uint8Array[] = [];
  constructor(private type = 'application/zip') {}
  async write(c: Uint8Array) { this.parts.push(c); }
  async close() { const b = new Blob(this.parts as Uint8Array<ArrayBuffer>[], { type: this.type }); this.parts = []; return b; }
  async abort() { this.parts = []; }
}

export class FileSink implements Sink {
  constructor(private w: FileSystemWritableFileStream) {}
  async write(c: Uint8Array) { await this.w.write(c as Uint8Array<ArrayBuffer>); }
  async close() { await this.w.close(); return null; }
  async abort() { await this.w.abort().catch(() => undefined); }
}

/** `window.__scanMemoryZip = true` force l'assemblage en mémoire (tests automatisés). */
export const supportsSavePicker = () =>
  typeof window !== 'undefined' && 'showSaveFilePicker' in window && !(window as { __scanMemoryZip?: boolean }).__scanMemoryZip;

/** Demande où enregistrer le ZIP (doit être appelé pendant un geste utilisateur). */
export async function pickZipSink(suggestedName: string): Promise<Sink> {
  if (!supportsSavePicker()) return new MemorySink();
  try {
    const h = await (window as unknown as { showSaveFilePicker(o: object): Promise<FileSystemFileHandle> }).showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Archive ZIP', accept: { 'application/zip': ['.zip'] } }],
    });
    return new FileSink(await h.createWritable());
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return new MemorySink();
  }
}

/**
 * ZIP généré en flux : chaque fichier est écrit dès qu'il est prêt, sans recompression
 * (JPEG, PNG et TIFF Deflate sont déjà compressés). Les écritures sont sérialisées.
 */
export class ZipStream {
  private zip: Zip;
  private chain: Promise<void> = Promise.resolve();
  private error: unknown;
  private done!: () => void;
  private finished = new Promise<void>((r) => (this.done = r));
  count = 0;

  constructor(private sink: Sink) {
    this.zip = new Zip((err, chunk, final) => {
      if (err) { this.error = err; return; }
      this.chain = this.chain.then(() => this.sink.write(chunk)).catch((e) => { this.error = e; });
      if (final) void this.chain.then(() => this.done());
    });
  }

  private lock: Promise<void> = Promise.resolve();

  /** Ajoute un fichier ; les ajouts simultanés sont mis en file (un fichier à la fois). */
  add(name: string, blob: Blob, date = new Date()): Promise<void> {
    const run = this.lock.then(() => this.addNow(name, blob, date));
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Le blob est lu par morceaux pour limiter la mémoire. */
  private async addNow(name: string, blob: Blob, date: Date) {
    if (this.error) throw this.error;
    const entry = new ZipPassThrough(name);
    entry.mtime = date;
    this.zip.add(entry);
    const reader = blob.stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      entry.push(value);
      // Laisse le temps à l'écriture de suivre.
      await this.chain;
    }
    entry.push(new Uint8Array(0), true);
    await this.chain;
    this.count++;
  }

  async finish(): Promise<Blob | null> {
    await this.lock;
    this.zip.end();
    await this.finished;
    await this.chain;
    if (this.error) throw this.error;
    return this.sink.close();
  }

  async abort() {
    this.zip.terminate();
    await this.sink.abort();
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
