import { create } from 'zustand';
import type { Analysis } from '../core/compile.ts';
import { fingerprint, fileKind } from '../core/fingerprint.ts';
import { History } from '../core/history.ts';
import { curveEvaluator, isIdentityCurve, type Curve } from '../core/curves.ts';
import { BUILTIN_PRESETS, findPreset, slugify, type FilmLook } from '../core/presets.ts';
import {
  cloneSettings, defaultSettings, NEUTRAL_GRAIN, NEUTRAL_HALATION, NEUTRAL_VIGNETTE, sanitizeSettings, settingsEqual, settingsFromJson, settingsToJson, transferableSettings,
  type Settings,
} from '../core/settings.ts';
import type { Collected } from '../import/collect.ts';
import { backgroundPool, CancelledError, estimateWeightMB } from '../workers/pool.ts';
import type { FileRef, ImageInfo } from '../workers/protocol.ts';
import { db, type SessionEntry } from './db.ts';

export type ItemStatus = 'queued' | 'loading' | 'ready' | 'error' | 'offline';

export interface Item extends SessionEntry {
  file?: File;
  handle?: FileSystemFileHandle;
  status: ItemStatus;
  error?: string;
  info?: ImageInfo;
  analysis?: Analysis;
  /** Incrémenté quand une nouvelle miniature est disponible dans IndexedDB. */
  thumbRev: number;
  settings: Settings;
}

export interface Notice { id: number; kind: 'info' | 'error' | 'success'; text: string }

export interface State {
  items: Item[];
  currentId: string | null;
  selection: string[];
  clipboard: Settings | null;
  userPresets: FilmLook[];
  theme: 'dark' | 'light';
  notices: Notice[];
  needsPermission: boolean;
  historyRev: number;
  restored: boolean;
}

export const useStore = create<State>(() => ({
  items: [],
  currentId: null,
  selection: [],
  clipboard: null,
  userPresets: [],
  theme: 'dark',
  notices: [],
  needsPermission: false,
  historyRev: 0,
  restored: false,
}));

const get = useStore.getState;
const setState = useStore.setState;

export function itemById(id: string | null | undefined): Item | undefined {
  if (!id) return undefined;
  return get().items.find((i) => i.id === id);
}

export function allPresets(): FilmLook[] {
  return [...BUILTIN_PRESETS, ...get().userPresets];
}

export function lookFor(s: Settings): FilmLook | undefined {
  return findPreset(s.presetId, get().userPresets);
}

export function fileRef(item: Item): FileRef {
  return { id: item.id, name: item.name, kind: item.kind, file: item.file, handle: item.handle };
}

function patchItem(id: string, patch: Partial<Item> | ((it: Item) => Partial<Item>)) {
  setState((s) => ({
    items: s.items.map((it) => (it.id === id ? { ...it, ...(typeof patch === 'function' ? patch(it) : patch) } : it)),
  }));
}

let noticeId = 1;
export function notify(text: string, kind: Notice['kind'] = 'info', ms = 5000) {
  const n: Notice = { id: noticeId++, kind, text };
  setState((s) => ({ notices: [...s.notices.slice(-3), n] }));
  if (ms > 0) setTimeout(() => dismissNotice(n.id), ms);
}
export function dismissNotice(id: number) {
  setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

// ---------------------------------------------------------------- miniatures

const thumbTimers = new Map<string, ReturnType<typeof setTimeout>>();
const thumbAborts = new Map<string, AbortController>();

/** Programme le (re)calcul d'une miniature ; `useCache` réutilise le proxy stocké. */
export function scheduleThumb(id: string, useCache: boolean, delay = 0) {
  clearTimeout(thumbTimers.get(id));
  thumbTimers.set(id, setTimeout(() => void runThumb(id, useCache), delay));
}

/** L'aperçu de l'image ouverte produit aussi sa miniature : inutile de décoder deux fois. */
export function cancelThumb(id: string) {
  clearTimeout(thumbTimers.get(id));
  thumbTimers.delete(id);
  thumbAborts.get(id)?.abort();
  thumbAborts.delete(id);
}

export async function thumbFromPreview(id: string, blob: Blob, info: ImageInfo, analysis: Analysis) {
  await db.saveThumb(id, blob);
  patchItem(id, (it) => ({ status: 'ready', info, analysis, thumbRev: it.thumbRev + 1, error: undefined }));
}

async function runThumb(id: string, useCache: boolean) {
  thumbTimers.delete(id);
  const item = itemById(id);
  if (!item || item.status === 'offline') return;
  thumbAborts.get(id)?.abort();
  const ac = new AbortController();
  thumbAborts.set(id, ac);
  if (item.status !== 'ready') patchItem(id, { status: 'loading' });
  try {
    const res = await backgroundPool.run(
      'thumb',
      { ref: fileRef(item), settings: item.settings, look: lookFor(item.settings), useCache },
      {
        signal: ac.signal,
        priority: useCache ? 1 : 0,
        weight: useCache ? 1 : estimateWeightMB(item.info ? item.info.width * item.info.height : undefined, item.size),
      },
    );
    await db.saveThumb(id, res.thumb);
    patchItem(id, (it) => ({ status: 'ready', info: res.info, analysis: res.analysis, thumbRev: it.thumbRev + 1, error: undefined }));
  } catch (e) {
    if (e instanceof CancelledError) return;
    const msg = e instanceof Error ? e.message : String(e);
    patchItem(id, { status: msg.includes('indisponible') || msg.includes('perdu') ? 'offline' : 'error', error: msg });
  } finally {
    if (thumbAborts.get(id) === ac) thumbAborts.delete(id);
  }
}

// ---------------------------------------------------------------- session

let sessionTimer: ReturnType<typeof setTimeout> | undefined;
function persistSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const entries: SessionEntry[] = get().items.map(({ id, name, path, size, lastModified, kind }) => ({ id, name, path, size, lastModified, kind }));
    void db.saveSession(entries);
  }, 200);
}

const settingsTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Écrit tout de suite les réglages en attente (fermeture ou masquage de l'onglet). */
export function flushPending() {
  for (const [id, t] of settingsTimers) {
    clearTimeout(t);
    const it = itemById(id);
    if (it) void db.saveSettings(id, it.settings);
  }
  settingsTimers.clear();
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPending);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPending(); });
}
function persistSettings(id: string) {
  clearTimeout(settingsTimers.get(id));
  settingsTimers.set(id, setTimeout(() => {
    const it = itemById(id);
    if (it) void db.saveSettings(id, it.settings);
  }, 300));
}

/** Ajoute des fichiers ; les doublons (même empreinte) récupèrent leur fichier et leurs réglages. */
export async function addFiles(collected: Collected[]): Promise<number> {
  const existing = new Map(get().items.map((i) => [i.id, i]));
  const fresh: Item[] = [];
  const revived: string[] = [];
  for (const c of collected) {
    const kind = fileKind(c.file.name, c.file.type);
    if (!kind) continue;
    // L'empreinte n'utilise pas le chemin : un fichier réimporté depuis un autre dossier est retrouvé.
    const id = fingerprint(c.file);
    const old = existing.get(id);
    if (old) {
      if (!old.file) {
        patchItem(id, { file: c.file, handle: c.handle ?? old.handle, status: 'queued', error: undefined });
        revived.push(id);
      }
      continue;
    }
    if (fresh.some((f) => f.id === id)) continue;
    fresh.push({
      id, name: c.file.name, path: c.path, size: c.file.size, lastModified: c.file.lastModified, kind,
      file: c.file, handle: c.handle, status: 'queued', thumbRev: 0, settings: defaultSettings(),
    });
  }
  if (fresh.length) {
    const saved = await db.loadManySettings(fresh.map((f) => f.id));
    fresh.forEach((f, i) => { if (saved[i]) f.settings = sanitizeSettings(saved[i]); });
    setState((s) => ({ items: [...s.items, ...fresh], currentId: s.currentId ?? fresh[0].id }));
    for (const f of fresh) if (f.handle) void db.saveHandle(f.id, f.handle);
    persistSession();
  }
  for (const f of fresh) scheduleThumb(f.id, false);
  for (const id of revived) scheduleThumb(id, true);
  return fresh.length + revived.length;
}

/** Recharge la session précédente (liste, réglages, handles). */
export async function restoreSession() {
  const [entries, presets, prefs] = await Promise.all([
    db.loadSession(),
    db.loadPresets(),
    db.loadPrefs<{ theme?: 'dark' | 'light' }>(),
  ]);
  const theme = prefs?.theme ?? 'dark';
  if (!entries.length) {
    setState({ userPresets: presets, theme, restored: true });
    return;
  }
  const [settings, handles] = await Promise.all([db.loadManySettings(entries.map((e) => e.id)), db.loadHandles(entries.map((e) => e.id))]);
  let needsPermission = false;
  const items: Item[] = await Promise.all(entries.map(async (e, i) => {
    const handle = handles[i];
    let status: ItemStatus = 'offline';
    if (handle) {
      const perm = await (handle as unknown as { queryPermission?(o: object): Promise<string> }).queryPermission?.({ mode: 'read' }).catch(() => 'denied');
      if (perm === 'granted') status = 'queued';
      else needsPermission = true;
    }
    return { ...e, handle, status, thumbRev: 1, settings: settings[i] ? sanitizeSettings(settings[i]) : defaultSettings() };
  }));
  setState({ items, userPresets: presets, theme, needsPermission, currentId: items[0]?.id ?? null, restored: true });
  for (const it of items) if (it.status === 'queued') scheduleThumb(it.id, true);
}

/** Redemande l'accès aux fichiers (geste utilisateur requis). */
export async function restoreAccess() {
  let granted = 0;
  for (const it of get().items) {
    if (!it.handle || it.file || it.status !== 'offline') continue;
    try {
      const h = it.handle as unknown as { requestPermission(o: object): Promise<string> };
      if ((await h.requestPermission({ mode: 'read' })) === 'granted') {
        patchItem(it.id, { status: 'queued' });
        scheduleThumb(it.id, true);
        granted++;
      }
    } catch { /* refusé */ }
  }
  setState({ needsPermission: get().items.some((i) => i.status === 'offline' && i.handle) });
  notify(granted ? `Accès rétabli à ${granted} fichier(s).` : 'Aucun accès accordé.', granted ? 'success' : 'info');
}

export async function removeImages(ids: string[]) {
  const set = new Set(ids);
  setState((s) => {
    const items = s.items.filter((i) => !set.has(i.id));
    const currentId = s.currentId && set.has(s.currentId) ? items[0]?.id ?? null : s.currentId;
    return { items, currentId, selection: s.selection.filter((x) => !set.has(x)) };
  });
  for (const id of ids) histories.delete(id);
  persistSession();
  await db.forgetImages(ids);
}

// ---------------------------------------------------------------- sélection

export function openImage(id: string) {
  setState((s) => ({ currentId: id, selection: [id], historyRev: s.historyRev + 1 }));
}

export function selectImage(id: string, mode: 'single' | 'toggle' | 'range') {
  setState((s) => {
    if (mode === 'single') return { selection: [id], currentId: id };
    if (mode === 'toggle') {
      const has = s.selection.includes(id);
      return { selection: has ? s.selection.filter((x) => x !== id) : [...s.selection, id], currentId: id };
    }
    const ids = s.items.map((i) => i.id);
    const a = ids.indexOf(s.currentId ?? id), b = ids.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return { selection: ids.slice(lo, hi + 1), currentId: id };
  });
}

export function selectAll() {
  setState((s) => ({ selection: s.items.map((i) => i.id) }));
}

// ---------------------------------------------------------------- réglages et historique

const histories = new Map<string, History<Settings>>();
const editStart = new Map<string, Settings>();

function historyOf(id: string) {
  let h = histories.get(id);
  if (!h) { h = new History<Settings>(200); histories.set(id, h); }
  return h;
}

export function canUndo(id: string | null) { return !!id && !!histories.get(id)?.canUndo; }
export function canRedo(id: string | null) { return !!id && !!histories.get(id)?.canRedo; }

function applySettings(id: string, s: Settings) {
  patchItem(id, { settings: s });
  persistSettings(id);
  scheduleThumb(id, true, 400);
}

/** Début d'un réglage continu (glissement de curseur) : l'historique ne retiendra qu'une étape. */
export function beginEdit(id: string) {
  const it = itemById(id);
  if (it && !editStart.has(id)) editStart.set(id, cloneSettings(it.settings));
}

export function updateSettings(id: string, fn: (s: Settings) => void) {
  const it = itemById(id);
  if (!it) return;
  const next = cloneSettings(it.settings);
  fn(next);
  applySettings(id, next);
}

export function endEdit(id: string) {
  const start = editStart.get(id);
  editStart.delete(id);
  const it = itemById(id);
  if (start && it && !settingsEqual(start, it.settings)) {
    historyOf(id).push(start);
    setState((s) => ({ historyRev: s.historyRev + 1 }));
  }
}

/** Modification ponctuelle, annulable. */
export function edit(id: string, fn: (s: Settings) => void) {
  beginEdit(id);
  updateSettings(id, fn);
  endEdit(id);
}

export function undo(id: string | null) {
  if (!id) return;
  const it = itemById(id);
  const prev = it && historyOf(id).undo(it.settings);
  if (prev) { applySettings(id, prev); setState((s) => ({ historyRev: s.historyRev + 1 })); }
}
export function redo(id: string | null) {
  if (!id) return;
  const it = itemById(id);
  const next = it && historyOf(id).redo(it.settings);
  if (next) { applySettings(id, next); setState((s) => ({ historyRev: s.historyRev + 1 })); }
}

export function copySettings(id: string | null) {
  const it = itemById(id);
  if (!it) return;
  setState({ clipboard: transferableSettings(it.settings) });
  notify(`Réglages de « ${it.name} » copiés.`, 'success', 2500);
}

export function pasteSettings(ids: string[]) {
  const clip = get().clipboard;
  if (!clip || !ids.length) return;
  for (const id of ids) {
    edit(id, (s) => {
      const { inversion, geometry } = s;
      Object.assign(s, cloneSettings(clip));
      s.inversion = inversion;
      s.geometry = geometry;
    });
  }
  notify(`Réglages collés sur ${ids.length} image(s).`, 'success', 2500);
}

export function applyPreset(ids: string[], presetId: string | null) {
  for (const id of ids) edit(id, (s) => { s.presetId = presetId; });
  const p = findPreset(presetId, get().userPresets);
  if (ids.length > 1) notify(`${p ? `« ${p.name} »` : 'Aucun préset'} appliqué à ${ids.length} images.`, 'success', 2500);
}

export function resetSettings(ids: string[]) {
  for (const id of ids) edit(id, (s) => { Object.assign(s, defaultSettings()); });
}

// ---------------------------------------------------------------- présets personnels

/** Enregistre les réglages créatifs courants (préset + ajustements) comme nouveau préset. */
export async function saveUserPreset(name: string, from: Settings): Promise<FilmLook> {
  const base = lookFor(from);
  const k = base ? from.intensity : 0;
  const scaled = <T extends Record<string, number>>(user: T | null, preset: T | undefined, keys: (keyof T)[], neutral: T): T => {
    if (user) return { ...user };
    const p = { ...(preset ?? neutral) };
    for (const key of keys) (p[key] as number) = (neutral[key] as number) + ((p[key] as number) - (neutral[key] as number)) * k;
    return p;
  };
  const look: FilmLook = {
    id: `perso-${slugify(name)}-${Date.now().toString(36)}`,
    name: name.trim() || 'Préset personnel',
    description: base ? `D’après « ${base.name} »` : 'Préset personnel',
    category: 'personnel',
    monochrome: base?.monochrome,
    mixer: base?.mixer,
    temperature: from.temperature + (base?.temperature ?? 0) * k,
    tint: from.tint + (base?.tint ?? 0) * k,
    contrast: from.contrast + (base?.contrast ?? 0) * k,
    saturation: ((1 + from.saturation / 100) * (1 + ((base?.saturation ?? 0) / 100) * k) - 1) * 100,
    fade: (base?.fade ?? 0) * k,
    curves: { ...(base?.curves ?? {}) },
    split: base?.split ? { ...base.split, shadowsAmount: base.split.shadowsAmount * k, highlightsAmount: base.split.highlightsAmount * k } : undefined,
    grain: scaled(from.grain as never, base?.grain as never, ['amount', 'color'], NEUTRAL_GRAIN as never),
    halation: scaled(from.halation as never, base?.halation as never, ['amount'], NEUTRAL_HALATION as never),
    vignette: scaled(from.vignette as never, base?.vignette as never, ['amount'], NEUTRAL_VIGNETTE as never),
    sharpen: { amount: from.sharpen?.amount ?? (base?.sharpen.amount ?? 0) * k },
  };
  // Courbes : celles du préset à l'intensité courante, suivies de celles de l'utilisateur,
  // échantillonnées en 17 points par canal.
  look.curves = composeCurves(base, k, from);
  const presets = [...get().userPresets, look];
  setState({ userPresets: presets });
  await db.savePresets(presets);
  notify(`Préset « ${look.name} » enregistré.`, 'success');
  return look;
}

function composeCurves(base: FilmLook | undefined, k: number, s: Settings): FilmLook['curves'] {
  const blend = (c: Curve | undefined) => {
    if (!c || isIdentityCurve(c) || k <= 0) return (x: number) => x;
    const f = curveEvaluator(c);
    return (x: number) => x + (f(x) - x) * k;
  };
  const user = (c: Curve) => (isIdentityCurve(c) ? (x: number) => x : curveEvaluator(c));
  const pMaster = blend(base?.curves.rgb), uMaster = user(s.curves.rgb);
  const out: FilmLook['curves'] = {};
  const sample = (f: (x: number) => number): Curve => Array.from({ length: 17 }, (_, i) => [i / 16, f(i / 16)] as [number, number]);
  if (!isIdentityCurve(base?.curves.rgb) && k > 0) out.rgb = sample(pMaster);
  for (const ch of ['r', 'g', 'b'] as const) {
    const p = blend(base?.curves[ch]), u = user(s.curves[ch]);
    // Ordre du pipeline : canal du préset, puis maître utilisateur, puis canal utilisateur.
    if (!isIdentityCurve(base?.curves[ch]) || !isIdentityCurve(s.curves.rgb) || !isIdentityCurve(s.curves[ch])) {
      out[ch] = sample((x) => u(uMaster(p(x))));
    }
  }
  return out;
}

export async function deleteUserPreset(id: string) {
  const presets = get().userPresets.filter((p) => p.id !== id);
  setState({ userPresets: presets });
  await db.savePresets(presets);
}

export async function importUserPresets(list: FilmLook[]) {
  const ids = new Set(get().userPresets.map((p) => p.id));
  const presets = [...get().userPresets, ...list.filter((p) => !ids.has(p.id)).map((p) => ({ ...p, category: 'personnel' as const, builtin: false }))];
  setState({ userPresets: presets });
  await db.savePresets(presets);
}

// ---------------------------------------------------------------- JSON

export function exportSettingsJson(ids: string[]): string {
  const items = ids.map(itemById).filter((x): x is Item => !!x);
  return settingsToJson(items.map((i) => ({ name: i.name, fingerprint: i.id, settings: i.settings })));
}

/**
 * Importe un fichier de réglages : correspondance par empreinte, puis par nom ; un
 * réglage unique sans nom s'applique à la sélection.
 */
export function importSettingsJson(text: string, targetIds: string[]): number {
  const entries = settingsFromJson(text);
  const items = get().items;
  let applied = 0;
  if (entries.length === 1 && !entries[0].fingerprint) {
    for (const id of targetIds) { edit(id, (s) => Object.assign(s, entries[0].settings)); applied++; }
    return applied;
  }
  for (const e of entries) {
    const it = items.find((i) => i.id === e.fingerprint) ?? items.find((i) => i.name === e.name);
    if (!it) continue;
    edit(it.id, (s) => Object.assign(s, e.settings));
    applied++;
  }
  // Fichier d'une seule image qui ne correspond à rien : appliqué à la sélection, sans le cadrage.
  if (!applied && entries.length === 1) {
    for (const id of targetIds) {
      edit(id, (s) => { const { geometry, inversion } = s; Object.assign(s, entries[0].settings); s.geometry = geometry; s.inversion = inversion; });
      applied++;
    }
  }
  return applied;
}

// ---------------------------------------------------------------- préférences

export function setTheme(theme: 'dark' | 'light') {
  setState({ theme });
  void db.savePrefs({ theme });
}

export function setAnalysis(id: string, analysis: Analysis, info?: ImageInfo) {
  patchItem(id, (it) => ({ analysis, info: info ?? it.info }));
}

export function markLoaded(id: string, info: ImageInfo) {
  patchItem(id, (it) => ({ info, status: it.status === 'error' ? 'error' : it.status }));
}

export function markError(id: string, message: string) {
  patchItem(id, { status: message.includes('indisponible') || message.includes('perdu') ? 'offline' : 'error', error: message });
}
