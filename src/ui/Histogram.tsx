import { useEffect, useRef } from 'react';
import { useUi } from './uiStore.ts';

/** Histogramme RVB de l'aperçu, avec indication des tons écrêtés. */
export function Histogram() {
  const hist = useUi((s) => s.hist);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !hist) return;
    const ctx = c.getContext('2d')!;
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    const n = hist.r.length;
    // Échelle racine : les pics n'écrasent pas le reste.
    let max = 1;
    for (const a of [hist.r, hist.g, hist.b]) for (let i = 1; i < n - 1; i++) max = Math.max(max, a[i]);
    const sq = Math.sqrt(max);
    ctx.globalCompositeOperation = 'lighter';
    const draw = (a: Uint32Array, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < n; i++) ctx.lineTo((i / (n - 1)) * W, H - Math.min(1, Math.sqrt(a[i]) / sq) * H);
      ctx.lineTo(W, H);
      ctx.fill();
    };
    draw(hist.r, 'rgba(230,70,70,0.75)');
    draw(hist.g, 'rgba(70,200,90,0.75)');
    draw(hist.b, 'rgba(80,130,255,0.75)');
    ctx.globalCompositeOperation = 'source-over';
  }, [hist]);
  if (!hist) return null;
  const pct = (v: number) => `${((v / hist.total) * 100).toFixed(1)} %`;
  const lo = hist.l[0], hi = hist.l[hist.l.length - 1];
  return (
    <figure style={{ margin: 0 }}>
      <canvas ref={ref} width={300} height={70} style={{ width: '100%', height: 70, background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}
        role="img" aria-label={`Histogramme : ${pct(lo)} de noirs bouchés, ${pct(hi)} de blancs brûlés`} data-testid="histogram" />
      <figcaption className="hint" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Noirs bouchés : {pct(lo)}</span>
        <span>Blancs brûlés : {pct(hi)}</span>
      </figcaption>
    </figure>
  );
}
