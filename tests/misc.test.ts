import { describe, expect, it } from 'vitest';
import { History } from '../src/core/history.ts';
import { applyTemplate, sanitizeFileName, stripExtension, uniqueNames } from '../src/core/naming.ts';
import { fileKind } from '../src/core/fingerprint.ts';
import { slugify } from '../src/core/presets.ts';

describe('historique', () => {
  it('annule et rétablit', () => {
    const h = new History<number>();
    let v = 0;
    const set = (n: number) => { h.push(v); v = n; };
    set(1); set(2); set(3);
    v = h.undo(v)!; expect(v).toBe(2);
    v = h.undo(v)!; expect(v).toBe(1);
    v = h.redo(v)!; expect(v).toBe(2);
    set(10);
    expect(h.canRedo).toBe(false);
    v = h.undo(v)!; expect(v).toBe(2);
  });
  it('est borné', () => {
    const h = new History<number>(3);
    for (let i = 0; i < 10; i++) h.push(i);
    let n = 0, v = 99;
    while (h.canUndo) { v = h.undo(v)!; n++; }
    expect(n).toBe(3);
    expect(v).toBe(7);
  });
});

describe('nommage', () => {
  it('applique le modèle', () => {
    expect(applyTemplate('{nom}_{film}_{n}', { name: 'scan01', film: 'nb-doux', index: 3 })).toBe('scan01_nb-doux_3');
    expect(applyTemplate('{n:3}-{nom}', { name: 'a', film: '', index: 7 })).toBe('007-a');
    expect(applyTemplate('{date}', { name: 'a', film: '', index: 1, date: new Date(2026, 0, 5) })).toBe('2026-01-05');
  });
  it('nettoie les caractères interdits', () => {
    expect(sanitizeFileName('a/b:c*?')).toBe('a_b_c__');
    expect(sanitizeFileName('...')).toBe('image');
  });
  it('dédoublonne', () => {
    expect(uniqueNames(['a', 'b', 'A', 'a'], 'jpg')).toEqual(['a.jpg', 'b.jpg', 'A-2.jpg', 'a-3.jpg']);
  });
  it('divers', () => {
    expect(stripExtension('photo.final.tif')).toBe('photo.final');
    expect(fileKind('X.TIFF')).toBe('tiff');
    expect(fileKind('x.jpeg')).toBe('jpeg');
    expect(fileKind('x.png')).toBeNull();
    expect(slugify('Mon préset été !')).toBe('mon-preset-ete');
  });
});
