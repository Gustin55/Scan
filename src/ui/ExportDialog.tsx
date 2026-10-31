import { useEffect, useRef, useState } from 'react';
import { startExport, planNames, type ExportOptions } from '../export/queue.ts';
import { supportsSavePicker } from '../export/zip.ts';
import { useStore } from '../state/store.ts';
import { useUi } from './uiStore.ts';

const DEFAULTS: ExportOptions = { format: 'jpeg', quality: 0.92, template: '{nom}_{film}_{n}', concurrency: 3, zip: true };
const KEY = 'scan.export-options';

function loadOptions(): ExportOptions {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULTS; }
}

export function ExportDialog() {
  const open = useUi((s) => s.exportOpen);
  const items = useStore((s) => s.items);
  const selection = useStore((s) => s.selection);
  const currentId = useStore((s) => s.currentId);
  const ref = useRef<HTMLDialogElement>(null);
  const [opts, setOpts] = useState<ExportOptions>(loadOptions);
  const [scope, setScope] = useState<'current' | 'selection' | 'all'>('selection');

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const usable = items.filter((i) => i.status !== 'offline' && i.status !== 'error');
  const ids = (scope === 'current' ? [currentId] : scope === 'selection' ? selection : items.map((i) => i.id))
    .filter((id): id is string => !!id && usable.some((u) => u.id === id));
  const preview = ids.length ? planNames(ids.slice(0, 3), opts) : [];
  const set = <K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem(KEY, JSON.stringify(opts));
    useUi.setState({ exportOpen: false });
    const zip = opts.zip && ids.length > 0 && !(ids.length === 1 && scope === 'current');
    await startExport(ids, { ...opts, zip });
  };

  return (
    <dialog ref={ref} aria-labelledby="export-title" onClose={() => useUi.setState({ exportOpen: false })} data-testid="export-dialog">
      <form method="dialog" onSubmit={submit}>
        <h2 id="export-title">Exporter</h2>
        <fieldset>
          <legend>Images</legend>
          <div className="radio-row">
            <label><input type="radio" name="scope" checked={scope === 'current'} onChange={() => setScope('current')} /> Image affichée</label>
            <label><input type="radio" name="scope" checked={scope === 'selection'} onChange={() => setScope('selection')} /> Sélection ({selection.length})</label>
            <label><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} /> Toutes ({usable.length})</label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Format</legend>
          <div className="radio-row">
            <label><input type="radio" name="format" checked={opts.format === 'jpeg'} onChange={() => set('format', 'jpeg')} /> JPEG</label>
            <label><input type="radio" name="format" checked={opts.format === 'png'} onChange={() => set('format', 'png')} /> PNG 8 bits</label>
            <label><input type="radio" name="format" checked={opts.format === 'tiff16'} onChange={() => set('format', 'tiff16')} /> TIFF 16 bits</label>
          </div>
          {opts.format === 'jpeg' && (
            <div className="field">
              <label htmlFor="q">Qualité JPEG : {Math.round(opts.quality * 100)}</label>
              <input id="q" type="range" min={0.5} max={1} step={0.01} value={opts.quality} onChange={(e) => set('quality', Number(e.target.value))} />
            </div>
          )}
          <p className="hint">Couleurs en sRGB ; le TIFF embarque un profil ICC sRGB.</p>
        </fieldset>
        <div className="field">
          <label htmlFor="tpl">Modèle de nom</label>
          <input id="tpl" type="text" value={opts.template} onChange={(e) => set('template', e.target.value)} aria-describedby="tpl-help" data-testid="template" />
          <span id="tpl-help" className="hint">
            Variables : {'{nom}'}, {'{film}'}, {'{n}'} (ou {'{n:3}'} pour 001), {'{date}'}.
            {preview.length > 0 && <> Exemple : <code>{preview.map((p) => p.fileName).join(', ')}</code></>}
          </span>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <label><input type="checkbox" checked={opts.zip} onChange={(e) => set('zip', e.target.checked)} /> Regrouper dans un ZIP</label>
          <label>
            Travaux en parallèle{' '}
            <select value={opts.concurrency} onChange={(e) => set('concurrency', Number(e.target.value))} aria-label="Travaux en parallèle">
              {[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        {opts.zip && <p className="hint">{supportsSavePicker() ? 'Le ZIP est écrit directement sur le disque, au fil des images.' : 'Le ZIP est assemblé en mémoire puis téléchargé.'}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={() => useUi.setState({ exportOpen: false })}>Annuler</button>
          <button type="submit" className="btn primary" disabled={!ids.length} data-testid="export-go">
            Exporter {ids.length} image{ids.length > 1 ? 's' : ''}
          </button>
        </div>
      </form>
    </dialog>
  );
}
