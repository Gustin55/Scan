import { cancelBatch, cancelJob, dismissBatch, overallProgress, resumeExport, useQueue } from '../export/queue.ts';

const LABEL = { pending: 'En attente', running: 'En cours', done: 'Terminé', error: 'Erreur', cancelled: 'Annulé' } as const;

export function QueuePanel() {
  const batch = useQueue((s) => s.batch);
  if (!batch) return null;
  const done = batch.jobs.filter((j) => j.status === 'done').length;
  const total = batch.jobs.length;
  const pct = Math.round(overallProgress(batch) * 100);
  const live = batch.state === 'running' || batch.state === 'finishing';
  return (
    <section className="queue" aria-label="File d’export" data-testid="queue">
      <header>
        <strong>
          {batch.state === 'interrupted' ? 'Export interrompu' : batch.state === 'finishing' ? 'Finalisation du ZIP…' : batch.state === 'done' ? 'Export terminé' : batch.state === 'cancelled' ? 'Export annulé' : 'Export en cours'}
        </strong>
        <span>{done}/{total}</span>
        {live && <button type="button" className="btn small" onClick={() => void cancelBatch()}>Tout annuler</button>}
        {batch.state === 'interrupted' && <button type="button" className="btn small primary" onClick={() => void resumeExport()}>Reprendre</button>}
        {!live && <button type="button" className="btn small" onClick={dismissBatch} aria-label="Fermer la file d’export">×</button>}
      </header>
      <div style={{ padding: '6px 10px 0' }}>
        <progress max={100} value={pct} aria-label="Progression globale" data-testid="overall-progress" />
        <span className="sr-only" aria-live="polite">{pct} %</span>
      </div>
      <ul>
        {batch.jobs.map((j) => (
          <li key={j.itemId}>
            <span title={j.name}>{j.fileName}</span>
            <span>
              {LABEL[j.status]}
              {(j.status === 'pending' || j.status === 'running') && live && (
                <button type="button" className="btn small" style={{ marginLeft: 6 }} onClick={() => cancelJob(j.itemId)} aria-label={`Annuler ${j.fileName}`}>×</button>
              )}
            </span>
            {j.status === 'running' && <progress max={1} value={j.progress} aria-label={`Progression de ${j.fileName}`} />}
            {j.error && <span className="err">{j.error}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
