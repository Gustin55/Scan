import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { freshPage, previewReady } from './helpers.ts';

const BIG = 'fixtures/big/scan-40mpx.tif';

/**
 * Scan de 40 Mpx (≈ 240 Mo décodés). Générer d'abord : `npm run fixtures:big`.
 * Vérifie que l'interface reste réactive et que la mémoire du thread principal reste
 * bornée (l'image pleine résolution ne vit que dans les workers).
 */
test.describe('gros scan 40 Mpx', () => {
  test.skip(!existsSync(BIG), 'fixture absente : npm run fixtures:big');
  test.setTimeout(300_000);

  test('aperçu, réglages et export sans bloquer le thread principal', async ({ page }) => {
    await freshPage(page);
    await page.evaluate(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push(e.duration); }).observe({ type: 'longtask' });
    });
    const t0 = Date.now();
    // Passe par un fichier sur disque (et non un tampon) pour ne pas mesurer le transfert.
    await page.getByTestId('file-input').setInputFiles(BIG);
    await previewReady(page);
    const tPreview = Date.now() - t0;
    await page.locator('[data-preset="couleur-froid-cinema"]').click();
    const slider = page.getByTestId('intensity');
    await slider.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(500);
    const heap = await page.evaluate(() => {
      (window as unknown as { gc?: () => void }).gc?.();
      return (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    });

    await page.getByTestId('open-export').click();
    const dlg = page.getByTestId('export-dialog');
    await dlg.getByLabel('Image affichée').check();
    await dlg.getByLabel('JPEG', { exact: true }).check();
    const download = page.waitForEvent('download', { timeout: 280_000 });
    const t1 = Date.now();
    await dlg.getByTestId('export-go').click();
    const d = await download;
    const tExport = Date.now() - t1;
    const size = statSync((await d.path())!).size;
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    console.log(
      `40 Mpx : aperçu ${tPreview} ms, export JPEG ${tExport} ms (${(size / 1e6).toFixed(1)} Mo), ` +
      `tas JS principal ${(heap / 1e6).toFixed(0)} Mo, tâche longue max ${Math.max(0, ...long).toFixed(0)} ms (${long.length})`,
    );
    expect(heap).toBeLessThan(200e6);
    expect(Math.max(0, ...long)).toBeLessThan(300);
    expect(size).toBeGreaterThan(1e6);
    void readFileSync;
  });
});
