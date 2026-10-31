/** Modèle de nommage des exports : {nom}, {film}, {n}, {n:3}, {date}, {ext}. */

export interface NameContext {
  /** Nom du fichier source sans extension. */
  name: string;
  /** Nom (ou identifiant) du préset. */
  film: string;
  /** Rang dans le lot (1, 2, 3…). */
  index: number;
  date?: Date;
}

const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeFileName(s: string): string {
  const cleaned = s.replace(FORBIDDEN, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return cleaned.slice(0, 180) || 'image';
}

export function stripExtension(file: string): string {
  const i = file.lastIndexOf('.');
  return i > 0 ? file.slice(0, i) : file;
}

export function applyTemplate(template: string, ctx: NameContext): string {
  const d = ctx.date ?? new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const out = (template || '{nom}').replace(/\{(nom|film|n|date)(?::(\d+))?\}/g, (_, key: string, pad?: string) => {
    switch (key) {
      case 'nom': return ctx.name;
      case 'film': return ctx.film;
      case 'date': return date;
      case 'n': return String(ctx.index).padStart(pad ? Number(pad) : 1, '0');
      default: return '';
    }
  });
  return sanitizeFileName(out);
}

/** Rend les noms uniques dans un lot (ajoute « -2 », « -3 »…). */
export function uniqueNames(names: string[], ext: string): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const c = seen.get(key) ?? 0;
    seen.set(key, c + 1);
    return c === 0 ? `${n}.${ext}` : `${n}-${c + 1}.${ext}`;
  });
}
