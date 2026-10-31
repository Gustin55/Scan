import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

export const fixture = (name: string) => readFileSync(`fixtures/${name}`);

export async function freshPage(page: Page) {
  await page.addInitScript(() => { (window as { __scanMemoryZip?: boolean }).__scanMemoryZip = true; });
  await page.goto('/');
  // Base IndexedDB vierge pour chaque test.
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((d) => new Promise((r) => { const q = indexedDB.deleteDatabase(d.name!); q.onsuccess = q.onerror = q.onblocked = r; })));
    localStorage.clear();
  });
  await page.reload();
}

export async function importFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.getByTestId('file-input').setInputFiles(files);
}

export async function waitReady(page: Page, n: number) {
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=grid]').length > 0 &&
    // les miniatures non affichées ne sont pas dans le DOM : on lit le compteur de la grille
    (document.querySelector('.grid-head span')?.textContent ?? '').trim() === `${n} image${n > 1 ? 's' : ''}`, n, { timeout: 120_000 });
}

export async function previewReady(page: Page) {
  await page.waitForFunction(() => !!window.__scan?.previewReady && window.__scan.lastRenderMs > 0);
}

/** Lit un pixel du canvas d'aperçu (coordonnées relatives 0..1). */
export async function canvasPixel(page: Page, u: number, v: number): Promise<number[]> {
  return page.evaluate(([u, v]) => {
    const c = document.querySelector('[data-testid=preview]') as HTMLCanvasElement;
    const gl = c.getContext('webgl2')!;
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(u * c.width), Math.floor((1 - v) * c.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px);
  }, [u, v]);
}
