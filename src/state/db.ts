import { del, delMany, get, getMany, keys, set, setMany } from 'idb-keyval';
import type { FilmLook } from '../core/presets.ts';
import type { Settings } from '../core/settings.ts';

/**
 * Persistance IndexedDB. Le magasin par défaut d'idb-keyval est partagé avec les workers
 * (proxies `proxy:<id>`, informations `info:<id>`).
 */
export interface SessionEntry {
  id: string;
  name: string;
  path: string;
  size: number;
  lastModified: number;
  kind: 'tiff' | 'jpeg';
}

const k = {
  session: 'session',
  settings: (id: string) => `settings:${id}`,
  handle: (id: string) => `handle:${id}`,
  thumb: (id: string) => `thumb:${id}`,
  proxy: (id: string) => `proxy:${id}`,
  info: (id: string) => `info:${id}`,
  presets: 'user-presets',
  prefs: 'prefs',
  queue: 'export-queue',
  output: (batch: string, item: string) => `out:${batch}:${item}`,
};

export const db = {
  async loadSession(): Promise<SessionEntry[]> { return (await get<SessionEntry[]>(k.session)) ?? []; },
  saveSession(s: SessionEntry[]) { return set(k.session, s); },
  loadSettings(id: string) { return get<Settings>(k.settings(id)); },
  async loadManySettings(ids: string[]) { return getMany<Settings | undefined>(ids.map(k.settings)); },
  saveSettings(id: string, s: Settings) { return set(k.settings(id), s); },
  saveHandle(id: string, h: FileSystemFileHandle) { return set(k.handle(id), h).catch(() => undefined); },
  async loadHandles(ids: string[]) { return getMany<FileSystemFileHandle | undefined>(ids.map(k.handle)); },
  loadThumb(id: string) { return get<Blob>(k.thumb(id)); },
  saveThumb(id: string, b: Blob) { return set(k.thumb(id), b); },
  async forgetImages(ids: string[]) {
    await delMany(ids.flatMap((id) => [k.settings(id), k.handle(id), k.thumb(id), k.proxy(id), k.info(id)]));
  },
  async loadPresets(): Promise<FilmLook[]> { return (await get<FilmLook[]>(k.presets)) ?? []; },
  savePresets(p: FilmLook[]) { return set(k.presets, p); },
  loadPrefs<T>() { return get<T>(k.prefs); },
  savePrefs<T>(p: T) { return set(k.prefs, p); },
  loadQueue<T>() { return get<T>(k.queue); },
  saveQueue<T>(q: T | undefined) { return q === undefined ? del(k.queue) : set(k.queue, q); },
  saveOutput(batch: string, item: string, b: Blob) { return set(k.output(batch, item), b); },
  loadOutput(batch: string, item: string) { return get<Blob>(k.output(batch, item)); },
  async clearOutputs(batch: string) {
    const all = (await keys()).filter((x) => typeof x === 'string' && x.startsWith(`out:${batch}:`));
    await delMany(all);
  },
  setMany,
};

