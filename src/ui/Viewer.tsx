import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { compile, packTrc, resolveKind } from '../core/compile.ts';
import type { InputColor } from '../core/icc.ts';
import { defaultGeometry, outputSize } from '../core/geometry.ts';
import { Renderer, RendererError } from '../gl/renderer.ts';
import { cancelThumb, edit, fileRef, itemById, lookFor, markError, scheduleThumb, setAnalysis, thumbFromPreview, useStore, type Item } from '../state/store.ts';
import { inputColorFor } from '../workers/imaging.ts';
import { CancelledError, interactivePool } from '../workers/pool.ts';
import type { PreviewResult } from '../workers/protocol.ts';
import { useUi } from './uiStore.ts';
import { neutralizeDelta } from '../core/whitebalance.ts';

const KIND_LABEL = { positive: 'positif', 'negative-color': 'négatif couleur', 'negative-bw': 'négatif N&B' } as const;

interface Cached { res: PreviewResult; colors: Map<string, { color: InputColor; trc: Float32Array }> }
const cache = new Map<string, Cached>();
const CACHE_MAX = 3;

function remember(id: string, c: Cached) {
  cache.delete(id);
  cache.set(id, c);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

const inflight = new Map<string, { p: Promise<PreviewResult>; ac: AbortController }>();

/** Demande l'aperçu d'une image (partagé si déjà en cours). Produit aussi sa miniature si besoin. */
function requestPreview(it: Item, maxEdge: number, priority: number) {
  const existing = inflight.get(it.id);
  if (existing) return existing;
  const ac = new AbortController();
  const needThumb = it.status !== 'ready';
  if (needThumb) cancelThumb(it.id);
  const p = interactivePool
    .run(
      'preview',
      {
        ref: fileRef(it), maxEdge, transfer: it.settings.input.transfer,
        settings: needThumb ? it.settings : undefined, look: needThumb ? lookFor(it.settings) : undefined,
      },
      { signal: ac.signal, priority },
    )
    .then((res) => {
      remember(it.id, { res, colors: new Map() });
      // Analyse posée avant l'affichage : pas d'image non inversée, même un instant.
      setAnalysis(it.id, res.analysis, res.info);
      if (res.thumb) void thumbFromPreview(it.id, res.thumb, res.info, res.analysis);
      return res;
    })
    .catch((e) => {
      // Aperçu abandonné : la miniature repasse en arrière-plan.
      if (e instanceof CancelledError && needThumb) scheduleThumb(it.id, false);
      throw e;
    })
    .finally(() => inflight.delete(it.id));
  const entry = { p, ac };
  inflight.set(it.id, entry);
  return entry;
}

function prefetchNext(id: string, maxEdge: number) {
  const items = useStore.getState().items;
  const next = items[items.findIndex((i) => i.id === id) + 1];
  if (!next || cache.has(next.id) || inflight.has(next.id) || next.status === 'offline' || next.status === 'error' || !(next.file || next.handle)) return;
  requestPreview(next, maxEdge, 0).p.catch(() => undefined);
}

declare global {
  interface Window { __scan?: { renderer?: Renderer; lastRenderMs: number; previewReady: string | null; measure(): number; cached(): string[] } }
}
window.__scan = { lastRenderMs: 0, previewReady: null, measure: () => 0, cached: () => [...cache.keys()] };

export function Viewer() {
  const currentId = useStore((s) => s.currentId);
  const item = useStore((s) => s.items.find((i) => i.id === s.currentId));
  const userPresets = useStore((s) => s.userPresets);
  const { dragging, before, zoom } = useUi();
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const frame = useRef(0);
  const histTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const picking = useUi((s) => s.picking);

  useEffect(() => {
    try {
      renderer.current = new Renderer(canvas.current!);
      window.__scan!.renderer = renderer.current;
    } catch (e) {
      setGlError(e instanceof RendererError ? e.message : `WebGL2 indisponible : ${e}`);
    }
    // Pas de loseContext() : en mode strict, React remonte le composant sur le même canvas.
    return () => { renderer.current = null; };
  }, []);

  useLayoutEffect(() => {
    const el = stage.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth - 24, h: el.clientHeight - 24 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Chargement de l'aperçu de l'image courante, puis préchargement de la suivante.
  const offline = item?.status === 'offline';
  const hasFile = !!(item?.file || item?.handle);
  useEffect(() => {
    const r = renderer.current;
    if (!currentId || !r || !hasFile || offline) return;
    // Les préchargements devenus inutiles libèrent le worker d'aperçu.
    for (const [id, f] of inflight) if (id !== currentId) f.ac.abort();
    const maxEdge = Math.min(2560, r.gl.getParameter(r.gl.MAX_TEXTURE_SIZE) as number);
    const show = (res: PreviewResult) => {
      r.setImage(res.preview, res.proxy, res.info.width, res.info.height);
      setLoaded(currentId);
      prefetchNext(currentId, maxEdge);
    };
    const hit = cache.get(currentId);
    if (hit) {
      remember(currentId, hit);
      show(hit.res);
      return;
    }
    let alive = true;
    setLoading(true);
    requestPreview(itemById(currentId)!, maxEdge, 10).p
      .then((res) => { if (alive) show(res); })
      .catch((e) => { if (!(e instanceof CancelledError)) markError(currentId, e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [currentId, hasFile, offline]);

  // Réanalyse quand la courbe d'entrée change (même image).
  const transfer = item?.settings.input.transfer;
  const lastKey = useRef<{ id: string | null; transfer?: string } | null>(null);
  useEffect(() => {
    const prev = lastKey.current;
    lastKey.current = { id: currentId, transfer };
    if (!prev || !currentId || !transfer || prev.id !== currentId || prev.transfer === transfer) return;
    const it = itemById(currentId);
    if (!it) return;
    void interactivePool.run('analyze', { ref: fileRef(it), transfer }, { priority: 10 }).then((a) => setAnalysis(currentId, a)).catch(() => undefined);
  }, [currentId, transfer]);

  const compiled = useMemo(() => {
    if (!item || loaded !== item.id) return null;
    const entry = cache.get(item.id);
    if (!entry) return null;
    const t = item.settings.input.transfer;
    let col = entry.colors.get(t);
    if (!col) {
      const color = inputColorFor(entry.res.icc, item.kind, t);
      col = { color, trc: packTrc(color) };
      entry.colors.set(t, col);
    }
    return compile({ settings: item.settings, look: lookFor(item.settings), analysis: item.analysis, color: col.color, packedTrc: col.trc });
    // userPresets : un préset personnel modifié doit relancer la compilation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.settings, item?.analysis, loaded, item?.id, userPresets]);

  // Taille d'affichage : ajustée à la zone, ou 1:1 avec l'aperçu en mode zoom.
  const entry = item ? cache.get(item.id) : undefined;
  const geo = item?.settings.geometry ?? defaultGeometry();
  const out = entry ? outputSize(entry.res.preview.width, entry.res.preview.height, geo) : { w: 1, h: 1 };
  const pw = out.w, ph = out.h;
  const dpr = window.devicePixelRatio || 1;
  const fit = Math.min(box.w / pw, box.h / ph);
  const cssW = zoom ? pw / dpr : Math.max(1, Math.floor(pw * fit));
  const cssH = zoom ? ph / dpr : Math.max(1, Math.floor(ph * fit));
  const backW = Math.min(pw, Math.round(cssW * dpr));
  const backH = Math.min(ph, Math.round(cssH * dpr));

  useEffect(() => {
    const r = renderer.current;
    if (!r || !compiled) return;
    r.setParams(compiled);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      r.render({ draft: dragging, before }, backW, backH);
      window.__scan!.lastRenderMs = r.lastFrameMs;
      window.__scan!.previewReady = loaded;
      // Histogramme : seulement sur l'image définitive, et pas à chaque image d'un glissement.
      clearTimeout(histTimer.current);
      if (!dragging && !before) {
        histTimer.current = setTimeout(() => void r.histogramAsync().then((hist) => { if (hist) useUi.setState({ hist }); }), 150);
      }
    });
  }, [compiled, dragging, before, backW, backH, loaded]);

  /** Pipette : rend neutre la zone cliquée (3 itérations, la courbe de tonalité n'étant pas linéaire). */
  const pickNeutral = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = renderer.current;
    const it = item;
    if (!r || !it || !compiled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width, v = (e.clientY - rect.top) / rect.height;
    const entry = cache.get(it.id)!;
    const col = entry.colors.get(it.settings.input.transfer)!;
    let { temperature, tint } = it.settings;
    for (let k = 0; k < 3; k++) {
      const s = { ...it.settings, temperature, tint };
      r.setParams(compile({ settings: s, look: lookFor(s), analysis: it.analysis, color: col.color, packedTrc: col.trc }));
      r.render({ draft: false, before: false }, backW, backH);
      const d = neutralizeDelta(r.readAverage(u, v, 9));
      temperature = Math.max(-100, Math.min(100, temperature + d.temperature));
      tint = Math.max(-100, Math.min(100, tint + d.tint));
    }
    edit(it.id, (x) => { x.temperature = Math.round(temperature); x.tint = Math.round(tint); });
    useUi.setState({ picking: false });
  };

  useEffect(() => {
    window.__scan!.measure = () => {
      const r = renderer.current;
      if (!r || !compiled) return -1;
      const t0 = performance.now();
      r.setParams(compiled);
      r.render({ draft: false, before: false }, backW, backH);
      r.finish();
      return performance.now() - t0;
    };
  }, [compiled, backW, backH]);

  const info = item?.info;
  const kind = item ? resolveKind(item.settings, item.analysis) : 'positive';
  const autoKind = item?.settings.input.kind === 'auto';
  return (
    <main className="viewer" aria-label="Aperçu">
      <ViewerBar />
      {info && (
        <div className="sr-only" aria-live="polite">{item?.name} ouverte</div>
      )}
      <div ref={stage} className={`stage${zoom ? ' zoomed' : ''}`}>
        {glError && <p className="placeholder" role="alert">{glError}</p>}
        {!item && !glError && <p className="placeholder">Ouvrez une image pour l’afficher ici.</p>}
        {item?.status === 'offline' && (
          <p className="placeholder">Le fichier « {item.name} » n’est plus accessible. Rétablissez l’accès ou réimportez-le : ses réglages seront conservés.</p>
        )}
        {item?.status === 'error' && !loading && loaded !== item.id && <p className="placeholder" role="alert">{item.error}</p>}
        <canvas
          ref={canvas}
          data-testid="preview"
          role="img"
          aria-label={item ? `Aperçu de ${item.name}${before ? ' (original)' : ''}` : 'Aperçu'}
          style={{ width: cssW, height: cssH, display: item && loaded === item.id ? 'block' : 'none', cursor: picking ? 'crosshair' : undefined }}
          onClick={picking ? pickNeutral : undefined}
        />
      </div>
      {before && loaded && <div className="before-tag">Avant</div>}
      {loading && <div className="loading-overlay" aria-live="polite"><div className="spinner" /><span className="sr-only">Chargement de l’aperçu…</span></div>}
      {info && (
        <div className="viewer-bar" style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
          <span className="info" style={{ marginLeft: 0 }}>
            {info.width} × {info.height} px{(() => { const o = outputSize(info.width, info.height, geo); return o.w !== info.width || o.h !== info.height ? ` → ${o.w} × ${o.h} px` : ''; })()} · {info.bits} bits · {info.profile} · {KIND_LABEL[kind]}{autoKind ? ' (détecté)' : ''}
            {info.warning ? ` · ⚠ ${info.warning}` : ''}
          </span>
          {autoKind && item && kind === 'positive' && (
            <button type="button" className="btn small" onClick={() => edit(item.id, (s) => { s.input.kind = 'negative-color'; })}>C’est un négatif</button>
          )}
        </div>
      )}
    </main>
  );
}

function ViewerBar() {
  const { before, zoom, picking } = useUi();
  const hold = (v: boolean) => () => useUi.setState({ before: v });
  return (
    <div className="viewer-bar">
      <button
        type="button"
        className="btn"
        aria-pressed={before}
        data-testid="before-after"
        onPointerDown={hold(true)}
        onPointerUp={hold(false)}
        onPointerLeave={hold(false)}
        onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); useUi.setState({ before: true }); } }}
        onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') useUi.setState({ before: false }); }}
        title="Maintenir pour voir l’original (touche B)"
      >
        Avant / après
      </button>
      <button
        type="button"
        className="btn"
        aria-pressed={picking}
        data-testid="picker"
        onClick={() => useUi.setState({ picking: !picking })}
        title="Cliquez ensuite sur une zone qui devrait être grise ou blanche (Échap pour annuler)"
      >
        Pipette gris neutre
      </button>
      <button type="button" className="btn" aria-pressed={zoom} onClick={() => useUi.setState({ zoom: !zoom })} title="Afficher l’aperçu pixel pour pixel (touche Z)">
        {zoom ? 'Ajuster' : '100 %'}
      </button>
    </div>
  );
}
