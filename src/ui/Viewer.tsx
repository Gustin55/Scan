import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { compile, packTrc, resolveKind } from '../core/compile.ts';
import type { InputColor } from '../core/icc.ts';
import { Renderer, RendererError } from '../gl/renderer.ts';
import { cancelThumb, edit, fileRef, itemById, lookFor, markError, scheduleThumb, setAnalysis, thumbFromPreview, useStore } from '../state/store.ts';
import { inputColorFor } from '../workers/imaging.ts';
import { CancelledError, interactivePool } from '../workers/pool.ts';
import type { PreviewResult } from '../workers/protocol.ts';
import { useUi } from './uiStore.ts';

const KIND_LABEL = { positive: 'positif', 'negative-color': 'négatif couleur', 'negative-bw': 'négatif N&B' } as const;

interface Cached { res: PreviewResult; colors: Map<string, { color: InputColor; trc: Float32Array }> }
const cache = new Map<string, Cached>();
const CACHE_MAX = 3;

function remember(id: string, c: Cached) {
  cache.delete(id);
  cache.set(id, c);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

declare global {
  interface Window { __scan?: { renderer?: Renderer; lastRenderMs: number; previewReady: string | null; measure(): number } }
}
window.__scan = { lastRenderMs: 0, previewReady: null, measure: () => 0 };

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

  // Chargement de l'aperçu de l'image courante.
  const offline = item?.status === 'offline';
  const hasFile = !!(item?.file || item?.handle);
  useEffect(() => {
    if (!currentId || !renderer.current || !hasFile || offline) return;
    const hit = cache.get(currentId);
    if (hit) {
      remember(currentId, hit);
      renderer.current.setImage(hit.res.preview, hit.res.proxy, hit.res.info.width, hit.res.info.height);
      setLoaded(currentId);
      return;
    }
    const ac = new AbortController();
    const it = itemById(currentId)!;
    setLoading(true);
    const maxTex = renderer.current.gl.getParameter(renderer.current.gl.MAX_TEXTURE_SIZE) as number;
    const needThumb = it.status !== 'ready';
    if (needThumb) cancelThumb(currentId);
    let settled = false;
    interactivePool
      .run(
        'preview',
        {
          ref: fileRef(it), maxEdge: Math.min(2560, maxTex), transfer: it.settings.input.transfer,
          settings: needThumb ? it.settings : undefined, look: needThumb ? lookFor(it.settings) : undefined,
        },
        { signal: ac.signal, priority: 10 },
      )
      .then((res) => {
        const entry: Cached = { res, colors: new Map() };
        remember(currentId, entry);
        if (res.thumb) void thumbFromPreview(currentId, res.thumb, res.info, res.analysis);
        else setAnalysis(currentId, res.analysis, res.info);
        renderer.current?.setImage(res.preview, res.proxy, res.info.width, res.info.height);
        setLoaded(currentId);
      })
      .catch((e) => { if (!(e instanceof CancelledError)) markError(currentId, e instanceof Error ? e.message : String(e)); })
      .finally(() => { settled = true; setLoading(false); });
    return () => {
      ac.abort();
      // Aperçu abandonné (autre image ouverte) : la miniature repasse en arrière-plan.
      if (needThumb && !settled) scheduleThumb(currentId, false);
    };
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
  const pw = entry?.res.preview.width ?? 1, ph = entry?.res.preview.height ?? 1;
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
    });
  }, [compiled, dragging, before, backW, backH, loaded]);

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
          style={{ width: cssW, height: cssH, display: item && loaded === item.id ? 'block' : 'none' }}
        />
      </div>
      {before && loaded && <div className="before-tag">Avant</div>}
      {loading && <div className="loading-overlay" aria-live="polite"><div className="spinner" /><span className="sr-only">Chargement de l’aperçu…</span></div>}
      {info && (
        <div className="viewer-bar" style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
          <span className="info" style={{ marginLeft: 0 }}>
            {info.width} × {info.height} px · {info.bits} bits · {info.profile} · {KIND_LABEL[kind]}{autoKind ? ' (détecté)' : ''}
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
  const { before, zoom } = useUi();
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
      <button type="button" className="btn" aria-pressed={zoom} onClick={() => useUi.setState({ zoom: !zoom })} title="Afficher l’aperçu pixel pour pixel (touche Z)">
        {zoom ? 'Ajuster' : '100 %'}
      </button>
    </div>
  );
}
