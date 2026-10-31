import { useEffect, useRef, useState } from 'react';
import { collectFromDataTransfer, collectFromDirectoryPicker, collectFromFileList, supportsDirectoryPicker, type CollectResult } from '../import/collect.ts';
import { restoreQueue } from '../export/queue.ts';
import {
  addFiles, copySettings, dismissNotice, notify, pasteSettings, redo, restoreAccess, restoreSession, setTheme, undo, useStore,
} from '../state/store.ts';
import { ExportDialog } from './ExportDialog.tsx';
import { Grid } from './Grid.tsx';
import { Panel } from './Panel.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { useUi } from './uiStore.ts';
import { Viewer } from './Viewer.tsx';

const SAMPLES = ['negatif-couleur.tif', 'negatif-nb.tif', 'positif.jpg'];

async function importResult(r: CollectResult) {
  if (!r.files.length) {
    notify(r.ignored ? `Aucune image TIFF ou JPEG trouvée (${r.ignored} fichier(s) ignoré(s)).` : 'Aucun fichier.', 'error');
    return;
  }
  const n = await addFiles(r.files);
  notify(`${n} image(s) ajoutée(s)${r.ignored ? `, ${r.ignored} fichier(s) ignoré(s)` : ''}.`, 'success', 3000);
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio'].includes((el as HTMLInputElement).type) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function App() {
  const theme = useStore((s) => s.theme);
  const count = useStore((s) => s.items.length);
  const restored = useStore((s) => s.restored);
  const needsPermission = useStore((s) => s.needsPermission);
  const offline = useStore((s) => s.items.filter((i) => i.status === 'offline').length);
  const notices = useStore((s) => s.notices);
  const helpOpen = useUi((s) => s.helpOpen);
  const [dragOver, setDragOver] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  useEffect(() => { void restoreSession(); void restoreQueue(); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // Glisser-déposer sur toute la fenêtre.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setDragOver(true); };
    const over = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragOver(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragOver(false);
      void collectFromDataTransfer(e.dataTransfer!).then(importResult).catch((err) => notify(`Import impossible : ${err}`, 'error'));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // Raccourcis clavier globaux.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const id = useStore.getState().currentId;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(id); else undo(id); }
      else if (mod && k === 'y') { e.preventDefault(); redo(id); }
      else if (mod && e.shiftKey && k === 'c') { e.preventDefault(); copySettings(id); }
      else if (mod && e.shiftKey && k === 'v') {
        e.preventDefault();
        const s = useStore.getState();
        pasteSettings(s.selection.length > 1 ? s.selection : id ? [id] : []);
      } else if (mod && k === 'e') { e.preventDefault(); useUi.setState({ exportOpen: true }); }
      else if (!mod && k === 'b' && !e.repeat) useUi.setState({ before: true });
      else if (!mod && k === 'z') useUi.setState((u) => ({ zoom: !u.zoom }));
      else if (!mod && e.key === '?') useUi.setState({ helpOpen: true });
    };
    const up = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'b') useUi.setState({ before: false }); };
    const blur = () => useUi.setState({ before: false });
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);

  const openFolder = async () => {
    if (supportsDirectoryPicker()) {
      try { await importResult(await collectFromDirectoryPicker()); } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) folder.current?.click(); }
    } else folder.current?.click();
  };

  const loadSamples = async () => {
    const list = await Promise.all(SAMPLES.map(async (n) => {
      const r = await fetch(`${import.meta.env.BASE_URL}samples/${n}`);
      const b = await r.blob();
      return new File([b], n, { type: b.type, lastModified: 1_700_000_000_000 });
    }));
    await importResult(collectFromFileList(list));
  };

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Scan <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· négatifs & pellicule</span></h1>
        <button type="button" className="btn" onClick={() => files.current?.click()}>Ajouter des fichiers</button>
        <button type="button" className="btn" onClick={() => void openFolder()}>Ajouter un dossier</button>
        <input ref={files} type="file" multiple accept=".tif,.tiff,.jpg,.jpeg,image/tiff,image/jpeg" hidden data-testid="file-input"
          onChange={(e) => { if (e.target.files) void importResult(collectFromFileList(e.target.files)); e.target.value = ''; }} />
        <input ref={folder} type="file" multiple hidden {...{ webkitdirectory: '', directory: '' }}
          onChange={(e) => { if (e.target.files) void importResult(collectFromFileList(e.target.files)); e.target.value = ''; }} />
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => useUi.setState({ helpOpen: true })} aria-label="Raccourcis clavier">?</button>
        <button type="button" className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre'}>
          {theme === 'dark' ? '☀ Clair' : '☾ Sombre'}
        </button>
        <button type="button" className="btn primary" disabled={!count} onClick={() => useUi.setState({ exportOpen: true })} data-testid="open-export">
          Exporter…
        </button>
      </header>
      {(needsPermission || offline > 0) && (
        <div className="banner" role="status">
          {offline} image(s) de la session précédente ne sont pas accessibles.
          {needsPermission && <button type="button" className="btn small primary" onClick={() => void restoreAccess()}>Rétablir l’accès</button>}
          <span className="hint">Ou réimportez les fichiers : leurs réglages seront retrouvés.</span>
        </div>
      )}
      {count === 0 && restored ? (
        <div className="app-body" style={{ gridTemplateColumns: '1fr' }}>
          <div className="empty">
            <h2>Importez vos scans</h2>
            <div className="drop-hint">
              <p>Glissez-déposez des fichiers <strong>TIFF</strong> ou <strong>JPEG</strong>, ou des dossiers entiers (sous-dossiers compris).</p>
              <div className="row" style={{ justifyContent: 'center', display: 'flex', gap: 8 }}>
                <button type="button" className="btn primary" onClick={() => files.current?.click()}>Choisir des fichiers</button>
                <button type="button" className="btn" onClick={() => void openFolder()}>Choisir un dossier</button>
                <button type="button" className="btn" onClick={() => void loadSamples()} data-testid="samples">Images d’exemple</button>
              </div>
            </div>
            <p className="hint">Tout reste sur votre ordinateur : aucune image n’est envoyée sur le réseau.</p>
          </div>
        </div>
      ) : (
        <div className="app-body">
          <Grid />
          <Viewer />
          <Panel />
        </div>
      )}
      {dragOver && <div className="drop-overlay" aria-hidden="true"><div>Déposez vos images ou dossiers</div></div>}
      <ExportDialog />
      <QueuePanel />
      {helpOpen && <Help />}
      <div className="notices" role="status" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.kind}`} role={n.kind === 'error' ? 'alert' : undefined}>
            <span>{n.text}</span>
            <button type="button" className="btn small" onClick={() => dismissNotice(n.id)} aria-label="Fermer le message">×</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Help() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const rows: [string, string][] = [
    ['B (maintenu)', 'Voir l’original'],
    ['Z', 'Basculer 100 % / ajusté'],
    ['Ctrl+Z / Ctrl+Maj+Z', 'Annuler / rétablir'],
    ['Ctrl+Maj+C / Ctrl+Maj+V', 'Copier / coller les réglages'],
    ['Ctrl+E', 'Exporter'],
    ['Flèches (grille)', 'Image précédente / suivante'],
    ['Maj+flèches, Espace, Ctrl+A', 'Sélection'],
    ['Suppr (grille)', 'Retirer de la session'],
    ['Double-clic sur un curseur', 'Valeur par défaut'],
  ];
  return (
    <dialog ref={ref} aria-labelledby="help-title" onClose={() => useUi.setState({ helpOpen: false })}>
      <div className="content">
        <h2 id="help-title">Raccourcis clavier</h2>
        <table className="shortcuts"><tbody>{rows.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
        <div className="actions"><button type="button" className="btn" onClick={() => ref.current?.close()} autoFocus>Fermer</button></div>
      </div>
    </dialog>
  );
}
