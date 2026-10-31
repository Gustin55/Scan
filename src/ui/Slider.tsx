import { useId } from 'react';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  onBegin?: () => void;
  onChange: (v: number) => void;
  onEnd?: () => void;
  format?: (v: number) => string;
  /** Texte d'aide lu par les lecteurs d'écran. */
  description?: string;
  testId?: string;
}

/** Curseur accessible : libellé, valeur affichée, réinitialisation, double-clic = défaut. */
export function Slider(p: SliderProps) {
  const id = useId();
  const changed = Math.abs(p.value - p.defaultValue) > p.step / 2;
  const fmt = p.format ?? ((v: number) => (p.step < 1 ? v.toFixed(2) : String(Math.round(v))));
  const reset = () => { p.onBegin?.(); p.onChange(p.defaultValue); p.onEnd?.(); };
  return (
    <div className={`slider${changed ? ' changed' : ''}`}>
      <label htmlFor={id}>{p.label}</label>
      <output htmlFor={id} aria-hidden="true">{fmt(p.value)}</output>
      <button type="button" className="btn small reset" onClick={reset} aria-label={`Réinitialiser ${p.label}`} title="Réinitialiser">
        ↺
      </button>
      <input
        id={id}
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={p.value}
        data-testid={p.testId}
        aria-valuetext={fmt(p.value)}
        aria-description={p.description}
        onPointerDown={() => p.onBegin?.()}
        onKeyDown={(e) => { if (e.key !== 'Tab' && e.key !== 'Shift') p.onBegin?.(); }}
        onKeyUp={() => p.onEnd?.()}
        onPointerUp={() => p.onEnd?.()}
        onPointerCancel={() => p.onEnd?.()}
        onBlur={() => p.onEnd?.()}
        onDoubleClick={reset}
        onChange={(e) => p.onChange(Number(e.target.value))}
      />
    </div>
  );
}
