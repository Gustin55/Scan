import { fileKind } from '../core/fingerprint.ts';

export interface Collected {
  file: File;
  /** Chemin relatif dans le dossier déposé (« pellicule1/scan01.tif »). */
  path: string;
  handle?: FileSystemFileHandle;
}

export interface CollectResult { files: Collected[]; ignored: number }

type Entry = FileSystemEntry;

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const all: Entry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries renvoie les entrées par paquets (100 dans Chromium) : on boucle.
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else { all.push(...batch); next(); }
      }, reject);
    next();
  });
}

async function walkEntry(entry: Entry, out: Collected[], counter: { ignored: number }) {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    const path = entry.fullPath.replace(/^\//, '');
    if (fileKind(file.name, file.type)) out.push({ file, path });
    else counter.ignored++;
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) await walkEntry(child, out, counter);
  }
}

async function walkHandle(dir: FileSystemDirectoryHandle, prefix: string, out: Collected[], counter: { ignored: number }) {
  for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (h.kind === 'file') {
      const fh = h as FileSystemFileHandle;
      if (!fileKind(name)) { counter.ignored++; continue; }
      out.push({ file: await fh.getFile(), path: prefix + name, handle: fh });
    } else {
      await walkHandle(h as FileSystemDirectoryHandle, `${prefix}${name}/`, out, counter);
    }
  }
}

/**
 * Collecte les fichiers d'un glisser-déposer, y compris les sous-dossiers.
 * Les handles File System Access sont récupérés quand le navigateur les fournit
 * (ils permettent de relire les fichiers après un rechargement).
 */
export async function collectFromDataTransfer(dt: DataTransfer): Promise<CollectResult> {
  const out: Collected[] = [];
  const counter = { ignored: 0 };
  const items = Array.from(dt.items).filter((i) => i.kind === 'file');
  // Il faut tout demander de façon synchrone, avant le premier await.
  const handlePromises = items.map((i) =>
    'getAsFileSystemHandle' in i ? (i as DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle().catch(() => null) : Promise.resolve(null),
  );
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const plainFiles = items.map((i) => i.getAsFile());
  const handles = await Promise.all(handlePromises);
  for (let k = 0; k < items.length; k++) {
    const h = handles[k];
    if (h && h.kind === 'directory') { await walkHandle(h as FileSystemDirectoryHandle, `${h.name}/`, out, counter); continue; }
    if (h && h.kind === 'file') {
      const f = await (h as FileSystemFileHandle).getFile();
      if (fileKind(f.name, f.type)) out.push({ file: f, path: f.name, handle: h as FileSystemFileHandle });
      else counter.ignored++;
      continue;
    }
    const e = entries[k];
    if (e) { await walkEntry(e, out, counter); continue; }
    const f = plainFiles[k];
    if (f && fileKind(f.name, f.type)) out.push({ file: f, path: f.name });
    else if (f) counter.ignored++;
  }
  return { files: sortCollected(out), ignored: counter.ignored };
}

export function collectFromFileList(list: FileList | File[]): CollectResult {
  const out: Collected[] = [];
  let ignored = 0;
  for (const f of Array.from(list)) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (fileKind(f.name, f.type)) out.push({ file: f, path });
    else ignored++;
  }
  return { files: sortCollected(out), ignored };
}

export const supportsDirectoryPicker = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function collectFromDirectoryPicker(): Promise<CollectResult> {
  const dir = await (window as unknown as { showDirectoryPicker(o?: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'read' });
  const out: Collected[] = [];
  const counter = { ignored: 0 };
  await walkHandle(dir, `${dir.name}/`, out, counter);
  return { files: sortCollected(out), ignored: counter.ignored };
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
function sortCollected(a: Collected[]) {
  return a.sort((x, y) => collator.compare(x.path, y.path));
}
