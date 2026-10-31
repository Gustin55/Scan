import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { db } from '../state/db.ts';
import { openImage, removeImages, selectAll, selectImage, useStore, type Item } from '../state/store.ts';

const MIN_CELL = 116;
const OVERSCAN = 2;

/** Miniature : l'URL d'objet n'existe que tant que la miniature est affichée. */
const Thumb = memo(function Thumb({ item, current, selected, active, style, onPick }: {
  item: Item; current: boolean; selected: boolean; active: boolean; style: React.CSSProperties;
  onPick: (id: string, e: React.MouseEvent) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!item.thumbRev) return;
    let alive = true;
    let u: string | null = null;
    void db.loadThumb(item.id).then((b) => {
      if (!alive || !b) return;
      u = URL.createObjectURL(b);
      setUrl(u);
    });
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [item.id, item.thumbRev]);

  const status =
    item.status === 'error' ? <span className="badge err">Erreur</span>
      : item.status === 'offline' ? <span className="badge err">Hors ligne</span>
        : item.status !== 'ready' && !url ? <div className="spinner" aria-hidden="true" /> : null;

  return (
    <div
      id={`thumb-${cssId(item.id)}`}
      role="option"
      aria-selected={selected}
      aria-current={current ? 'true' : undefined}
      aria-label={`${item.name}${item.status === 'error' ? ' (erreur)' : item.status === 'offline' ? ' (fichier indisponible)' : ''}`}
      className={`thumb${current ? ' current' : ''}${active ? ' active-desc' : ''}`}
      style={style}
      title={item.error ?? item.path}
      data-testid="thumb"
      data-status={item.status}
      onClick={(e) => onPick(item.id, e)}
      onDoubleClick={() => openImage(item.id)}
    >
      <div className="img">{url ? <img src={url} alt="" draggable={false} /> : status}</div>
      <div className="name">{item.name}</div>
    </div>
  );
});

export function cssId(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function Grid() {
  const items = useStore((s) => s.items);
  const currentId = useStore((s) => s.currentId);
  const selection = useStore((s) => s.selection);
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 240, h: 600, top: 0 });

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setBox((b) => ({ ...b, w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor(box.w / MIN_CELL));
  const cellW = box.w / cols;
  const cellH = Math.round(cellW * 0.82 + 22);
  const rows = Math.ceil(items.length / cols);
  const firstRow = Math.max(0, Math.floor(box.top / cellH) - OVERSCAN);
  const lastRow = Math.min(rows - 1, Math.ceil((box.top + box.h) / cellH) + OVERSCAN);
  const sel = new Set(selection);
  const curIndex = items.findIndex((i) => i.id === currentId);

  // Garde l'image courante visible (navigation au clavier).
  useEffect(() => {
    const el = scroller.current;
    if (!el || curIndex < 0) return;
    const top = Math.floor(curIndex / cols) * cellH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + cellH > el.scrollTop + el.clientHeight) el.scrollTop = top + cellH - el.clientHeight;
  }, [curIndex, cols, cellH]);

  const onPick = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey) selectImage(id, 'range');
    else if (e.ctrlKey || e.metaKey) selectImage(id, 'toggle');
    else openImage(id);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!items.length) return;
    let i = curIndex < 0 ? 0 : curIndex;
    switch (e.key) {
      case 'ArrowRight': i++; break;
      case 'ArrowLeft': i--; break;
      case 'ArrowDown': i += cols; break;
      case 'ArrowUp': i -= cols; break;
      case 'Home': i = 0; break;
      case 'End': i = items.length - 1; break;
      case ' ': e.preventDefault(); selectImage(items[i].id, 'toggle'); return;
      case 'a': if (e.ctrlKey || e.metaKey) { e.preventDefault(); selectAll(); } return;
      case 'Delete': {
        e.preventDefault();
        const ids = selection.length ? selection : [items[i].id];
        if (confirm(`Retirer ${ids.length} image(s) de la session ? Les fichiers ne sont pas supprimés.`)) void removeImages(ids);
        return;
      }
      default: return;
    }
    e.preventDefault();
    i = Math.max(0, Math.min(items.length - 1, i));
    if (e.shiftKey) selectImage(items[i].id, 'range');
    else openImage(items[i].id);
  };

  const visible: React.ReactNode[] = [];
  for (let r = firstRow; r <= lastRow; r++)
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const it = items[idx];
      if (!it) break;
      visible.push(
        <Thumb
          key={it.id}
          item={it}
          current={it.id === currentId}
          selected={sel.has(it.id)}
          active={it.id === currentId}
          onPick={onPick}
          style={{ left: c * cellW, top: r * cellH, width: cellW, height: cellH }}
        />,
      );
    }

  const ready = items.filter((i) => i.status === 'ready').length;
  return (
    <aside className="grid-pane" aria-label="Images importées">
      <div className="grid-head">
        <span aria-live="polite">
          {items.length} image{items.length > 1 ? 's' : ''}
          {ready < items.length ? ` · ${ready} prête${ready > 1 ? 's' : ''}` : ''}
          {selection.length > 1 ? ` · ${selection.length} sélectionnées` : ''}
        </span>
        <button type="button" className="btn small" onClick={selectAll} disabled={!items.length}>Tout</button>
      </div>
      <div
        ref={scroller}
        className="grid-scroll"
        tabIndex={0}
        role="listbox"
        aria-multiselectable="true"
        aria-label="Miniatures (flèches pour naviguer, Espace pour sélectionner, Maj pour étendre)"
        aria-activedescendant={currentId ? `thumb-${cssId(currentId)}` : undefined}
        data-testid="grid"
        onKeyDown={onKey}
        onScroll={(e) => { const t = (e.target as HTMLDivElement).scrollTop; setBox((b) => (b.top === t ? b : { ...b, top: t })); }}
      >
        <div style={{ height: rows * cellH, position: 'relative' }}>{visible}</div>
      </div>
    </aside>
  );
}
