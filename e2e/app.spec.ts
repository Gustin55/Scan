import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import jpeg from 'jpeg-js';
import { readFileSync } from 'node:fs';
import { decodeTiff } from '../src/core/tiff/decode.ts';
import { canvasPixel, fixture, freshPage, importFiles, previewReady, waitReady } from './helpers.ts';

const jpg = fixture('positif.jpg');
const negTif = fixture('negatif-couleur.tif');

function batch(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    name: `vue_${String(i + 1).padStart(2, '0')}.${i % 5 === 0 ? 'tif' : 'jpg'}`,
    mimeType: i % 5 === 0 ? 'image/tiff' : 'image/jpeg',
    buffer: i % 5 === 0 ? negTif : jpg,
  }));
}

test('importer 50 images : miniatures sans bloquer l’interface, grille virtualisée', async ({ page }) => {
  await freshPage(page);
  const t0 = Date.now();
  await importFiles(page, batch(50));
  // Le transfert des fichiers par Playwright occupe la page : on observe les tâches longues
  // du thread principal à partir d'ici (le rendu WebGL logiciel du conteneur n'y figure pas).
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push(e.duration); }).observe({ type: 'longtask' });
  });
  await expect(page.locator('.grid-head span')).toContainText('50 images');
  // Pendant le traitement, l'interface répond : on ouvre une autre image.
  await page.getByTestId('thumb').nth(3).click();
  await expect(page.locator('.thumb.current')).toHaveAttribute('aria-label', /vue_04/);
  await waitReady(page, 50);
  const elapsed = Date.now() - t0;
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  const worst = Math.max(0, ...long);
  console.log(`50 miniatures en ${elapsed} ms ; tâches longues du thread principal : ${long.length}, la plus longue ${worst.toFixed(0)} ms`);
  expect(worst).toBeLessThan(250);
  // Seules les miniatures visibles (plus une marge) sont dans le DOM.
  const inDom = await page.getByTestId('thumb').count();
  expect(inDom).toBeGreaterThan(4);
  expect(inDom).toBeLessThan(50);
  const urls = await page.locator('[data-testid=thumb] img').count();
  expect(urls).toBeLessThanOrEqual(inDom);
});

test('préset et intensité : aperçu mis à jour en moins de 100 ms', async ({ page }) => {
  await freshPage(page);
  await importFiles(page, [{ name: 'moyenne-6mpx.tif', mimeType: 'image/tiff', buffer: fixture('moyenne-6mpx.tif') }]);
  await previewReady(page);
  await expect(page.getByText('négatif couleur (détecté)')).toBeVisible();

  // Négatif inversé : le ciel (haut de l'image) doit être bleuté, pas orange.
  const sky = await canvasPixel(page, 0.4, 0.15);
  expect(sky[2]).toBeGreaterThan(sky[0]);

  await page.locator('[data-preset="couleur-sature-contraste"]').click();
  const intensity = page.getByTestId('intensity');
  await intensity.focus();
  // Pression de touche → nouvelle image : mesure de bout en bout (React + compilation + rendu GPU).
  const times: number[] = [];
  for (let i = 0; i < 6; i++) {
    const ms = await page.evaluate(async () => {
      const before = window.__scan!.lastRenderMs;
      void before;
      const t0 = performance.now();
      const el = document.querySelector('[data-testid=intensity]') as HTMLInputElement;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(el, String(Number(el.value) - 0.05));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      window.__scan!.renderer!.finish();
      return performance.now() - t0;
    });
    times.push(ms);
  }
  await intensity.dispatchEvent('keyup');
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const full = await page.evaluate(() => window.__scan!.measure());
  console.log(`intensité → aperçu (brouillon) : médiane ${median.toFixed(1)} ms ; rendu pleine définition : ${full.toFixed(1)} ms`);
  expect(median).toBeLessThan(100);
  await expect(page.getByText('Intensité du préset')).toBeVisible();
  await expect(page.locator('.slider output').first()).toHaveText('70 %');
});

test('avant / après maintenu, annuler / rétablir', async ({ page }) => {
  await freshPage(page);
  await importFiles(page, [{ name: 'negatif-couleur.tif', mimeType: 'image/tiff', buffer: negTif }]);
  await previewReady(page);
  const after = await canvasPixel(page, 0.4, 0.2);
  const btn = page.getByTestId('before-after');
  await btn.hover();
  await page.mouse.down();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(150);
  const before = await canvasPixel(page, 0.4, 0.2);
  await page.mouse.up();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  // L'original est un négatif orangé : rouge > bleu ; après inversion, ciel bleu.
  expect(before[0]).toBeGreaterThan(before[2]);
  expect(after[2]).toBeGreaterThan(after[0]);

  await page.locator('[data-preset="nb-contraste-fort"]').click();
  await expect(page.locator('[data-preset="nb-contraste-fort"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-preset=""]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('[data-preset="nb-contraste-fort"]')).toHaveAttribute('aria-checked', 'true');

  // Persistance : les réglages survivent à un rechargement.
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId('thumb')).toHaveCount(1);
  await expect(page.locator('[data-preset="nb-contraste-fort"]')).toHaveAttribute('aria-checked', 'true');
});

test('export ZIP de 20 images en flux, fichiers lisibles et nommés selon le modèle', async ({ page }) => {
  await freshPage(page);
  await importFiles(page, batch(20));
  await waitReady(page, 20);
  await page.locator('[data-preset="couleur-chaud-grain-fin"]').click();
  await page.getByTestId('open-export').click();
  const dlg = page.getByTestId('export-dialog');
  await dlg.getByLabel(/Toutes/).check();
  await dlg.getByTestId('template').fill('{nom}_{film}_{n:2}');
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await dlg.getByTestId('export-go').click();
  await expect(page.getByTestId('queue')).toBeVisible();
  const d = await download;
  const path = await d.path();
  const files = unzipSync(new Uint8Array(readFileSync(path!)));
  const names = Object.keys(files).sort();
  expect(names).toHaveLength(20);
  expect(names[0]).toBe('vue_01_couleur-chaud-grain-fin_01.jpg');
  expect(names).toContain('vue_02_sans-preset_02.jpg');
  for (const n of names) {
    const img = jpeg.decode(files[n], { useTArray: true });
    expect(img.width).toBeGreaterThan(100);
  }
  await expect(page.getByTestId('queue')).toContainText('Export terminé');
});

test('export unitaire TIFF 16 bits avec profil sRGB', async ({ page }) => {
  await freshPage(page);
  await importFiles(page, [{ name: 'negatif-couleur.tif', mimeType: 'image/tiff', buffer: negTif }]);
  await previewReady(page);
  await page.getByTestId('open-export').click();
  const dlg = page.getByTestId('export-dialog');
  await dlg.getByLabel('Image affichée').check();
  await dlg.getByLabel('TIFF 16 bits').check();
  const download = page.waitForEvent('download');
  await dlg.getByTestId('export-go').click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/\.tif$/);
  const r = decodeTiff(new Uint8Array(readFileSync((await d.path())!)));
  expect(r.width).toBe(1280);
  expect(r.sourceBits).toBe(16);
  expect(r.icc?.length).toBeGreaterThan(100);
  // Ciel inversé : bleu > rouge ; valeurs 16 bits non quantifiées en 8 bits.
  const i = (Math.floor(r.height * 0.2) * r.width + Math.floor(r.width * 0.4)) * 3;
  expect(r.data[i + 2]).toBeGreaterThan(r.data[i]);
  const row = Math.floor(r.height * 0.3) * r.width * 3;
  const distinct = new Set(Array.from(r.data.subarray(row, row + r.width * 3)).map((v) => v & 0xff));
  expect(distinct.size).toBeGreaterThan(64);
});

test('réglages JSON, copier-coller et préset sur une sélection', async ({ page }) => {
  await freshPage(page);
  await importFiles(page, batch(3));
  await waitReady(page, 3);
  await page.getByTestId('thumb').nth(0).click();
  await page.locator('[data-preset="diapositive-vive"]').click();
  await page.keyboard.press('Control+Shift+c');
  await page.getByTestId('thumb').nth(1).click();
  await page.getByTestId('thumb').nth(2).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+Shift+v');
  await page.getByTestId('thumb').nth(2).click();
  await expect(page.locator('[data-preset="diapositive-vive"]')).toHaveAttribute('aria-checked', 'true');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter en JSON' }).click();
  const json = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
  expect(json.format).toBe('scan-pellicule/settings');
  expect(json.images[0].settings.presetId).toBe('diapositive-vive');

  json.images[0].settings.presetId = 'nb-doux-sepia';
  await page.locator('input[type=file][accept*=json]').setInputFiles({ name: 'r.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
  await expect(page.locator('[data-preset="nb-doux-sepia"]')).toHaveAttribute('aria-checked', 'true');
});

test('accessibilité de base : libellés, thème clair, navigation clavier', async ({ page }) => {
  await freshPage(page);
  await page.getByTestId('samples').click();
  await waitReady(page, 3);
  await page.locator('details summary').first().click();
  const unlabeled = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input:not([type=hidden]):not([hidden]), select, button, [role=slider], [role=radio], [role=option]'))
      .filter((el) => {
        const e = el as HTMLElement;
        if (e.closest('[hidden]') || e.offsetParent === null && e.tagName !== 'INPUT') return false;
        const name = e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || (e as HTMLInputElement).labels?.length || e.textContent?.trim();
        return !name;
      })
      .map((e) => e.outerHTML.slice(0, 80)));
  expect(unlabeled).toEqual([]);
  await page.getByRole('button', { name: 'Passer au thème clair' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByTestId('grid').focus();
  const first = await page.getByTestId('thumb').nth(0).getAttribute('aria-label');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.thumb.current')).not.toHaveAttribute('aria-label', first!);
});
