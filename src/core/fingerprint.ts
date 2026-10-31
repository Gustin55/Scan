/** Empreinte stable d'un fichier importé, pour retrouver ses réglages à la réimportation. */
export function fingerprint(f: { name: string; size: number; lastModified: number }, path = ''): string {
  return `${path || f.name}|${f.size}|${f.lastModified}`;
}

export function fileKind(name: string, type = ''): 'tiff' | 'jpeg' | null {
  const n = name.toLowerCase();
  if (n.endsWith('.tif') || n.endsWith('.tiff') || type === 'image/tiff') return 'tiff';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.jfif') || type === 'image/jpeg') return 'jpeg';
  return null;
}
