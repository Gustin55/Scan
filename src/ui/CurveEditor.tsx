import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { curveEvaluator, normalizeCurve, type Curve, type CurvePoint } from '../core/curves.ts';
import type { CurveSet } from '../core/settings.ts';

const CH: { key: keyof CurveSet; label: string; color: string }[] = [
  { key: 'rgb', label: 'RVB', color: 'currentColor' },
  { key: 'r', label: 'Rouge', color: '#ff6b6b' },
  { key: 'g', label: 'Vert', color: '#5fd36a' },
  { key: 'b', label: 'Bleu', color: '#6aa8ff' },
];

const SIZE = 256;

interface Props {
  curves: CurveSet;
  onBegin: () => void;
  onChange: (key: keyof CurveSet, c: Curve) => void;
  onEnd: () => void;
}

/**
 * Éditeur de courbes : clic pour ajouter un point, glisser pour déplacer, double-clic
 * pour supprimer. Au clavier : Tab pour choisir un point, flèches pour le déplacer
 * (Maj = pas fin), Suppr pour le retirer, Insertion pour en ajouter un.
 */
export function CurveEditor({ curves, onBegin, onChange, onEnd }: Props) {
  const [channel, setChannel] = useState<keyof CurveSet>('rgb');
  const [active, setActive] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const pts = normalizeCurve(curves[channel]);
  const path = useMemo(() => {
    const f = curveEvaluator(pts);
    let d = '';
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      d += `${i ? 'L' : 'M'}${x * SIZE},${(1 - f(x)) * SIZE}`;
    }
    return d;
  }, [pts]);

  const toLocal = (e: PointerEvent): CurvePoint => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };

  const update = (next: Curve) => onChange(channel, next);

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    const p = toLocal(e);
    let idx = pts.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) < 0.05);
    onBegin();
    if (idx < 0) {
      const next = normalizeCurve([...pts, p]);
      idx = next.findIndex(([x]) => Math.abs(x - p[0]) < 1e-6);
      update(next);
    }
    drag.current = idx;
    setActive(idx);
    svg.current!.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current === null) return;
    const i = drag.current;
    const [x, y] = toLocal(e);
    const next = pts.map((q) => [...q] as CurvePoint);
    const lo = i === 0 ? 0 : next[i - 1][0] + 0.01;
    const hi = i === next.length - 1 ? 1 : next[i + 1][0] - 0.01;
    next[i] = [i === 0 ? 0 : i === next.length - 1 ? 1 : Math.min(hi, Math.max(lo, x)), y];
    update(next);
  };
  const onUp = () => { if (drag.current !== null) { drag.current = null; onEnd(); } };

  const removePoint = (i: number) => {
    if (i <= 0 || i >= pts.length - 1) return;
    onBegin();
    update(pts.filter((_, k) => k !== i));
    onEnd();
    setActive(null);
  };

  const onKey = (e: KeyboardEvent<SVGCircleElement>, i: number) => {
    const step = e.shiftKey ? 0.005 : 0.02;
    const next = pts.map((q) => [...q] as CurvePoint);
    let [x, y] = next[i];
    if (e.key === 'ArrowUp') y += step;
    else if (e.key === 'ArrowDown') y -= step;
    else if (e.key === 'ArrowLeft' && i > 0 && i < pts.length - 1) x = Math.max(next[i - 1][0] + 0.01, x - step);
    else if (e.key === 'ArrowRight' && i > 0 && i < pts.length - 1) x = Math.min(next[i + 1][0] - 0.01, x + step);
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removePoint(i); return; }
    else if (e.key === 'Insert' || e.key === '+') {
      e.preventDefault();
      const j = i < pts.length - 1 ? i : i - 1;
      const mx = (pts[j][0] + pts[j + 1][0]) / 2, my = (pts[j][1] + pts[j + 1][1]) / 2;
      onBegin(); update(normalizeCurve([...pts, [mx, my]])); onEnd();
      return;
    } else return;
    e.preventDefault();
    next[i] = [x, Math.min(1, Math.max(0, y))];
    onBegin(); update(next); onEnd();
  };

  const color = CH.find((c) => c.key === channel)!.color;
  const isIdentity = pts.length === 2 && pts[0][1] === 0 && pts[1][1] === 1;

  return (
    <div className="curve-editor">
      <div className="tabs" role="radiogroup" aria-label="Canal de la courbe">
        {CH.map((c) => (
          <button key={c.key} type="button" role="radio" aria-checked={channel === c.key} className="btn small" aria-pressed={channel === c.key} onClick={() => { setChannel(c.key); setActive(null); }}>
            {c.label}
          </button>
        ))}
        <button type="button" className="btn small" disabled={isIdentity} onClick={() => { onBegin(); update([[0, 0], [1, 1]]); onEnd(); }} aria-label={`Réinitialiser la courbe ${channel}`}>
          ↺
        </button>
      </div>
      <svg
        ref={svg}
        viewBox={`-6 -6 ${SIZE + 12} ${SIZE + 12}`}
        role="group"
        aria-label={`Courbe ${CH.find((c) => c.key === channel)!.label} : ${pts.length} points`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="var(--border)" strokeWidth={1}>
            <line x1={g * SIZE} y1={0} x2={g * SIZE} y2={SIZE} />
            <line x1={0} y1={g * SIZE} x2={SIZE} y2={g * SIZE} />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="var(--border)" strokeDasharray="4 4" />
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * SIZE}
            cy={(1 - y) * SIZE}
            r={active === i ? 7 : 5}
            fill={active === i ? 'var(--accent)' : 'var(--bg-2)'}
            stroke={color}
            strokeWidth={2}
            tabIndex={0}
            role="slider"
            aria-label={`Point ${i + 1}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(y * 100)}
            aria-valuetext={`entrée ${Math.round(x * 100)} %, sortie ${Math.round(y * 100)} %`}
            onFocus={() => setActive(i)}
            onKeyDown={(e) => onKey(e, i)}
            onDoubleClick={(e) => { e.stopPropagation(); removePoint(i); }}
            onPointerDown={(e) => { if (e.detail > 1) e.stopPropagation(); }}
          />
        ))}
      </svg>
      <p className="hint">Clic : ajouter · glisser : déplacer · double-clic ou Suppr : retirer.</p>
    </div>
  );
}
