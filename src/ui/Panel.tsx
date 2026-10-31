import { useRef, useState } from 'react';
import { effectiveEffects, resolveKind } from '../core/compile.ts';
import type { FilmLook } from '../core/presets.ts';
import {
  defaultSettings, RANGES,
  type InputKind, type Settings, type TransferOverride,
} from '../core/settings.ts';
import {
  allPresets, applyPreset, beginEdit, canRedo, canUndo, copySettings, deleteUserPreset, edit, endEdit, exportSettingsJson,
  importSettingsJson, lookFor, notify, pasteSettings, redo, resetSettings, saveUserPreset, undo, updateSettings, useStore,
} from '../state/store.ts';
import { downloadBlob } from '../export/zip.ts';
import { CurveEditor } from './CurveEditor.tsx';
import { Slider } from './Slider.tsx';
import { setDragging } from './uiStore.ts';

const KINDS: { value: InputKind; label: string }[] = [
  { value: 'auto', label: 'Détection automatique' },
  { value: 'positive', label: 'Positif (photo, diapositive)' },
  { value: 'negative-color', label: 'Négatif couleur' },
  { value: 'negative-bw', label: 'Négatif noir et blanc' },
];
const TRANSFERS: { value: TransferOverride; label: string }[] = [
  { value: 'profile', label: 'Selon le profil du fichier' },
  { value: 'srgb', label: 'sRGB' },
  { value: 'gamma22', label: 'Gamma 2,2' },
  { value: 'linear', label: 'Linéaire (scan brut)' },
];

const signed = (v: number) => (v > 0 ? `+${Math.round(v)}` : String(Math.round(v)));
const pct = (v: number) => `${Math.round(v * 100)} %`;

export function Panel() {
  const item = useStore((s) => s.items.find((i) => i.id === s.currentId));
  const selection = useStore((s) => s.selection);
  const clipboard = useStore((s) => s.clipboard);
  useStore((s) => s.historyRev);
  useStore((s) => s.userPresets);
  const fileInput = useRef<HTMLInputElement>(null);

  if (!item) {
    return (
      <aside className="panel" aria-label="Réglages">
        <section><h2>Réglages</h2><p className="hint">Importez des images pour commencer.</p></section>
      </aside>
    );
  }

  const id = item.id;
  const s = item.settings;
  const look = lookFor(s);
  const kind = resolveKind(s, item.analysis);
  const targets = selection.length > 1 && selection.includes(id) ? selection : [id];

  /** Propriétés communes aux curseurs : un glissement = une étape d'historique. */
  const bind = (get: (s: Settings) => number, set: (s: Settings, v: number) => void) => ({
    value: get(s),
    onBegin: () => { beginEdit(id); setDragging(true); },
    onChange: (v: number) => updateSettings(id, (x) => set(x, v)),
    onEnd: () => { endEdit(id); setDragging(false); },
  });

  const eff = effectiveEffects(s, look);
  const effectBind = <K extends 'grain' | 'halation' | 'vignette' | 'sharpen'>(key: K, field: keyof NonNullable<Settings[K]>) => ({
    value: (eff[key] as unknown as Record<string, number>)[field as string],
    defaultValue: (effectiveEffects({ ...s, [key]: null }, look)[key] as unknown as Record<string, number>)[field as string],
    onBegin: () => { beginEdit(id); setDragging(true); },
    onChange: (v: number) => updateSettings(id, (x) => {
      const cur = { ...(effectiveEffects(x, look)[key] as object) } as Record<string, number>;
      cur[field as string] = v;
      (x[key] as unknown) = cur;
    }),
    onEnd: () => { endEdit(id); setDragging(false); },
  });

  const d = defaultSettings();

  const onImportJson = async (f: File) => {
    try {
      const n = importSettingsJson(await f.text(), targets);
      notify(n ? `Réglages appliqués à ${n} image(s).` : 'Aucune image correspondante dans ce fichier.', n ? 'success' : 'info');
    } catch (e) {
      notify(`Import impossible : ${e instanceof Error ? e.message : e}`, 'error');
    }
  };

  return (
    <aside className="panel" aria-label="Réglages">
      <section aria-labelledby="h-type">
        <h2 id="h-type">Image</h2>
        <div className="field">
          <label htmlFor="kind">Type</label>
          <select id="kind" data-testid="kind" value={s.input.kind} onChange={(e) => edit(id, (x) => { x.input.kind = e.target.value as InputKind; })}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
      </section>

      <section aria-labelledby="h-presets">
        <h2 id="h-presets">Pellicule</h2>
        <PresetList selected={s.presetId} onPick={(pid) => edit(id, (x) => { x.presetId = pid; })} />
        <Slider
          label="Intensité du préset"
          testId="intensity"
          min={0} max={1} step={RANGES.intensity.step} defaultValue={1}
          format={pct}
          {...bind((x) => x.intensity, (x, v) => { x.intensity = v; })}
        />
        {targets.length > 1 && (
          <button type="button" className="btn small" onClick={() => applyPreset(targets.filter((t) => t !== id), s.presetId)}>
            Appliquer ce préset aux {targets.length - 1} autres images sélectionnées
          </button>
        )}
      </section>

      {kind !== 'positive' && (
        <details>
          <summary>Inversion du négatif</summary>
          <p className="hint">Masque orange mesuré sur le bord non exposé, niveaux et balance automatiques.</p>
          <div className="field">
            <label htmlFor="transfer">Courbe d’entrée</label>
            <select id="transfer" value={s.input.transfer} onChange={(e) => edit(id, (x) => { x.input.transfer = e.target.value as TransferOverride; })}>
              {TRANSFERS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </div>
          <Slider label="Point noir" min={-50} max={50} step={1} defaultValue={0} format={signed}
            {...bind((x) => x.inversionAdjust.blackPoint, (x, v) => { x.inversionAdjust.blackPoint = v; })} />
          <Slider label="Point blanc" min={-50} max={50} step={1} defaultValue={0} format={signed}
            {...bind((x) => x.inversionAdjust.whitePoint, (x, v) => { x.inversionAdjust.whitePoint = v; })} />
          <div className="row">
            {s.inversion ? (
              <button type="button" className="btn small" onClick={() => edit(id, (x) => { x.inversion = null; })}>Revenir au calcul automatique</button>
            ) : null}
            {targets.length > 1 && item.analysis && (
              <button
                type="button"
                className="btn small"
                title="Même pellicule : même masque et mêmes niveaux pour toutes les vues"
                onClick={() => {
                  const inv = s.inversion ?? (kind === 'negative-bw' ? item.analysis!.bw : item.analysis!.color);
                  for (const t of targets) edit(t, (x) => { x.inversion = structuredClone(inv); x.input.kind = kind; });
                  notify(`Inversion appliquée à ${targets.length} images.`, 'success');
                }}
              >
                Même inversion pour la sélection
              </button>
            )}
          </div>
        </details>
      )}

      <details>
        <summary>Balance des blancs {(s.temperature || s.tint) ? <span className="modified">modifié</span> : null}</summary>
        <Slider label="Température" min={-100} max={100} step={1} defaultValue={0} format={signed}
          {...bind((x) => x.temperature, (x, v) => { x.temperature = v; })} />
        <Slider label="Teinte" min={-100} max={100} step={1} defaultValue={0} format={signed} description="Négatif : vers le vert, positif : vers le magenta"
          {...bind((x) => x.tint, (x, v) => { x.tint = v; })} />
      </details>

      <details>
        <summary>Lumière et couleur {(s.exposure || s.contrast || s.saturation) ? <span className="modified">modifié</span> : null}</summary>
        <Slider label="Exposition" min={RANGES.exposure.min} max={RANGES.exposure.max} step={RANGES.exposure.step} defaultValue={0}
          format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} IL`}
          {...bind((x) => x.exposure, (x, v) => { x.exposure = v; })} />
        <Slider label="Contraste" min={-100} max={100} step={1} defaultValue={0} format={signed}
          {...bind((x) => x.contrast, (x, v) => { x.contrast = v; })} />
        <Slider label="Saturation" min={-100} max={100} step={1} defaultValue={0} format={signed}
          {...bind((x) => x.saturation, (x, v) => { x.saturation = v; })} />
      </details>

      <details>
        <summary>Courbes</summary>
        <CurveEditor
          curves={s.curves}
          onBegin={() => { beginEdit(id); setDragging(true); }}
          onChange={(k, c) => updateSettings(id, (x) => { x.curves[k] = c; })}
          onEnd={() => { endEdit(id); setDragging(false); }}
        />
      </details>

      <EffectSection title="Grain" active={!!s.grain} onReset={() => edit(id, (x) => { x.grain = null; })} fromPreset={!!look}>
        <Slider label="Intensité" min={0} max={1} step={0.01} format={pct} {...effectBind('grain', 'amount')} />
        <Slider label="Taille" min={RANGES.grainSize.min} max={RANGES.grainSize.max} step={0.05} format={(v) => v.toFixed(2)} {...effectBind('grain', 'size')} />
        <Slider label="Rugosité" min={0} max={1} step={0.01} format={pct} {...effectBind('grain', 'roughness')} />
        <Slider label="Couleur" min={0} max={1} step={0.01} format={pct} {...effectBind('grain', 'color')} />
        <Slider label="Concentration dans les tons moyens" min={0} max={1} step={0.01} format={pct} {...effectBind('grain', 'luminance')} />
      </EffectSection>

      <EffectSection title="Halo" active={!!s.halation} onReset={() => edit(id, (x) => { x.halation = null; })} fromPreset={!!look}>
        <Slider label="Intensité" min={0} max={1} step={0.01} format={pct} {...effectBind('halation', 'amount')} />
        <Slider label="Rayon" min={RANGES.halationRadius.min} max={1} step={0.01} format={pct} {...effectBind('halation', 'radius')} />
        <Slider label="Seuil des hautes lumières" min={RANGES.halationThreshold.min} max={RANGES.halationThreshold.max} step={0.01} format={pct} {...effectBind('halation', 'threshold')} />
      </EffectSection>

      <EffectSection title="Vignettage" active={!!s.vignette} onReset={() => edit(id, (x) => { x.vignette = null; })} fromPreset={!!look}>
        <Slider label="Intensité" min={-1} max={1} step={0.01} format={(v) => signed(v * 100)} description="Négatif : éclaircit les bords" {...effectBind('vignette', 'amount')} />
        <Slider label="Étendue" min={0} max={1} step={0.01} format={pct} {...effectBind('vignette', 'midpoint')} />
        <Slider label="Douceur" min={RANGES.vignetteFeather.min} max={1} step={0.01} format={pct} {...effectBind('vignette', 'feather')} />
      </EffectSection>

      <EffectSection title="Netteté" active={!!s.sharpen} onReset={() => edit(id, (x) => { x.sharpen = null; })} fromPreset={!!look}>
        <Slider label="Intensité" min={0} max={2} step={0.01} format={pct} {...effectBind('sharpen', 'amount')} />
        <p className="hint">Appliquée à l’échelle de l’écran dans l’aperçu, au pixel près à l’export.</p>
      </EffectSection>

      <section aria-labelledby="h-actions">
        <h2 id="h-actions">Réglages</h2>
        <div className="row">
          <button type="button" className="btn small" onClick={() => undo(id)} disabled={!canUndo(id)} title="Ctrl+Z">Annuler</button>
          <button type="button" className="btn small" onClick={() => redo(id)} disabled={!canRedo(id)} title="Ctrl+Maj+Z">Rétablir</button>
          <button type="button" className="btn small" onClick={() => copySettings(id)} title="Ctrl+Maj+C">Copier</button>
          <button type="button" className="btn small" onClick={() => pasteSettings(targets)} disabled={!clipboard} title="Ctrl+Maj+V">
            Coller{targets.length > 1 ? ` (${targets.length})` : ''}
          </button>
          <button type="button" className="btn small" onClick={() => resetSettings(targets)}>Tout réinitialiser</button>
        </div>
        <SavePreset settings={s} />
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn small"
            onClick={() => downloadBlob(new Blob([exportSettingsJson(targets)], { type: 'application/json' }), targets.length > 1 ? 'reglages.json' : `${item.name}.reglages.json`)}
          >
            Exporter en JSON
          </button>
          <button type="button" className="btn small" onClick={() => fileInput.current?.click()}>Importer un JSON</button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden aria-hidden="true" tabIndex={-1}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportJson(f); e.target.value = ''; }} />
        </div>
        {JSON.stringify(s) !== JSON.stringify(d) ? null : <p className="hint">Réglages par défaut.</p>}
      </section>
    </aside>
  );
}

function EffectSection({ title, active, onReset, fromPreset, children }: { title: string; active: boolean; onReset: () => void; fromPreset: boolean; children: React.ReactNode }) {
  return (
    <details>
      <summary>
        {title} {active ? <span className="modified">personnalisé</span> : null}
      </summary>
      <p className="hint">{active ? 'Vos valeurs remplacent celles du préset.' : fromPreset ? 'Valeurs du préset (selon l’intensité).' : 'Désactivé par défaut.'}</p>
      {children}
      {active && <button type="button" className="btn small" onClick={onReset}>{fromPreset ? 'Revenir aux valeurs du préset' : 'Réinitialiser'}</button>}
    </details>
  );
}

function PresetList({ selected, onPick }: { selected: string | null; onPick: (id: string | null) => void }) {
  const presets = allPresets();
  const groups = new Map<string, FilmLook[]>();
  for (const p of presets) groups.set(p.category, [...(groups.get(p.category) ?? []), p]);
  const order: (string | null)[] = [null, ...presets.map((p) => p.id)];
  const onKey = (e: React.KeyboardEvent) => {
    const i = order.indexOf(selected);
    let j = i;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = Math.min(order.length - 1, i + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = Math.max(0, i - 1);
    else return;
    e.preventDefault();
    onPick(order[j]);
    requestAnimationFrame(() => (document.querySelector(`[data-preset="${order[j] ?? ''}"]`) as HTMLElement | null)?.focus());
  };
  const btn = (id: string | null, name: string, desc: string) => (
    <button
      key={id ?? 'none'}
      type="button"
      role="radio"
      aria-checked={selected === id}
      tabIndex={selected === id ? 0 : -1}
      className="preset"
      data-preset={id ?? ''}
      onClick={() => onPick(id)}
    >
      <span className="p-name">{name}</span>
      {desc && <span className="p-desc">{desc}</span>}
    </button>
  );
  return (
    <div className="presets" role="radiogroup" aria-label="Préset de pellicule" onKeyDown={onKey} data-testid="presets">
      {btn(null, 'Aucun préset', 'Inversion et réglages seulement')}
      {[...groups].map(([cat, list]) => (
        <div key={cat} role="presentation">
          <div className="preset-cat" aria-hidden="true">{cat}</div>
          {list.map((p) => (
            <div key={p.id} style={{ display: 'flex', gap: 4 }}>
              {btn(p.id, p.name, p.description)}
              {!p.builtin && (
                <button type="button" className="btn small danger" aria-label={`Supprimer le préset ${p.name}`}
                  onClick={() => { if (confirm(`Supprimer le préset « ${p.name} » ?`)) void deleteUserPreset(p.id); }}>×</button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SavePreset({ settings }: { settings: Settings }) {
  const [name, setName] = useState('');
  return (
    <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (name.trim()) { void saveUserPreset(name, settings); setName(''); } }}>
      <label htmlFor="preset-name" className="sr-only">Nom du nouveau préset</label>
      <input id="preset-name" type="text" placeholder="Nom du nouveau préset" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
      <button type="submit" className="btn small" disabled={!name.trim()}>Enregistrer comme préset</button>
    </form>
  );
}

