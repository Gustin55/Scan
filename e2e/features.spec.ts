import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { decodeTiff } from '../src/core/tiff/decode.ts';
import { canvasPixel, fixture, freshPage, importFiles, previewReady, waitReady } from './helpers.ts';

const neg = { name: 'negatif-couleur.tif', mimeType: 'image/tiff', buffer: fixture('negatif-couleur.tif') };

async function exportCurrentTiff(page: import('@playwright/test').Page) {
  await page.getByTestId('open-export').click();
  const dlg = page.getByTestId('export-dialog');
  await dlg.getByLabel('Image affichée').check();
  await dlg.getByLabel('TIFF 16 bits').check();
  const download = page.waitForEvent('download');
  await dlg.getByTestId('export-go').click();
  return decodeTiff(new Uint8Array(readFileSync((await (await download).path())!)));
}

test('recadrage auto du bord du film et rotation, appliqués à l’export', async ({ page }) => {
  await freshPage(page);
  await importFiles(page, [neg]);
  await previewReady(page);
  await page.locator('summary', { hasText: 'Cadrage' }).click();
  await page.getByTestId('autocrop').click();
  await page.getByRole('button', { name: 'Pivoter de 90° vers la droite' }).click();
  await expect(page.getByText(/1280 × 880 px → \d+ × \d+ px/)).toBeVisible();
  const r = await exportCurrentTiff(page);
  // Bord de 40 px retiré (1200 × 800 visibles), puis rotation : portrait.
  expect(r.width).toBeGreaterThan(780);
  expect(r.width).toBeLessThan(800);
  expect(r.height).toBeGreaterThan(1180);
  expect(r.height).toBeLessThan(1200);
  // Plus de liseré noir : la colonne de gauche (bas de l'image d'origine : aplats) n'est pas noire.
  let sum = 0;
  for (let y = Math.floor(r.height * 0.5); y < r.height; y++) sum += r.data[(y * r.width + 1) * 3 + 1];
  expect(sum / (r.height * 0.5) / 257).toBeGreaterThan(40);
  // Annuler retire la rotation.
  await page.keyboard.press('Control+z');
  await expect(page.getByText(/1280 × 880 px → (11|12)\d\d × \d+ px/)).toBeVisible();
});

test('pipette : un gris redevient neutre', async ({ page }) => {
  await freshPage(page);
  await importFiles(page, [neg]);
  await previewReady(page);
  // Dominante volontaire.
  await page.locator('summary', { hasText: 'Balance des blancs' }).click();
  const temp = page.getByLabel('Température', { exact: true });
  await temp.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  // Palier de gris moyen (haut à gauche de la scène).
  const u = 0.35, v = 0.85;
  const castBefore = await canvasPixel(page, u, v);
  expect(castBefore[0] - castBefore[2]).toBeGreaterThan(10);
  await page.getByTestId('picker').click();
  const box = (await page.getByTestId('preview').boundingBox())!;
  // Zone grise de la mire (bas de l'image, à gauche des aplats).
  await page.mouse.click(box.x + box.width * u, box.y + box.height * v);
  await expect(page.getByTestId('picker')).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(400);
  const after = await canvasPixel(page, u, v);
  expect(Math.abs(after[0] - after[2])).toBeLessThan(6);
  expect(Math.abs(after[0] - after[1])).toBeLessThan(6);
});

test('histogramme, préchargement de l’image suivante, JSON d’une image sur une autre', async ({ page }) => {
  await freshPage(page);
  await importFiles(page, [neg, { name: 'positif.jpg', mimeType: 'image/jpeg', buffer: fixture('positif.jpg') }]);
  await waitReady(page, 2);
  await previewReady(page);
  await expect(page.getByTestId('histogram')).toHaveAttribute('aria-label', /Histogramme/);
  // L'image suivante est préchargée : son ouverture est immédiate.
  await expect.poll(() => page.evaluate(() => window.__scan!.cached().length)).toBe(2);

  await page.locator('[data-preset="nb-doux-sepia"]').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter en JSON' }).click();
  // Réglages venant d'une image absente de la session (autre ordinateur, par exemple).
  const parsed = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
  parsed.images[0].fingerprint = 'ailleurs.tif|1|1';
  parsed.images[0].name = 'ailleurs.tif';
  const json = Buffer.from(JSON.stringify(parsed));
  await page.getByTestId('thumb').nth(1).click();
  await expect(page.locator('[data-preset=""]')).toHaveAttribute('aria-checked', 'true');
  // Le fichier ne correspond pas à cette image : il s'applique quand même à la sélection.
  await page.locator('input[type=file][accept*=json]').setInputFiles({ name: 'r.json', mimeType: 'application/json', buffer: json });
  await expect(page.locator('[data-preset="nb-doux-sepia"]')).toHaveAttribute('aria-checked', 'true');
});

test('import d’un dossier avec sous-dossiers, fichiers non image ignorés', async ({ page }) => {
  const { mkdirSync, writeFileSync, copyFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = join(tmpdir(), `scan-dossier-${Date.now()}`);
  mkdirSync(join(root, 'bobine-2', 'scans'), { recursive: true });
  copyFileSync('fixtures/positif.jpg', join(root, 'a.jpg'));
  copyFileSync('fixtures/negatif-nb.tif', join(root, 'bobine-2', 'scans', 'b.tif'));
  writeFileSync(join(root, 'notes.txt'), 'pas une image');
  await freshPage(page);
  await page.getByTestId('folder-input').setInputFiles(root);
  await expect(page.getByText(/2 image\(s\) ajoutée\(s\), 1 fichier\(s\) ignoré\(s\)/)).toBeVisible();
  await waitReady(page, 2);
  await expect(page.getByTestId('thumb').nth(1)).toHaveAttribute('title', /bobine-2\/scans\/b\.tif$/);
});

test('glisser-déposer de fichiers sur la fenêtre', async ({ page }) => {
  await freshPage(page);
  const b64 = fixture('positif.jpg').toString('base64');
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'depose.jpg', { type: 'image/jpeg' }));
    dt.items.add(new File(['x'], 'lisezmoi.txt', { type: 'text/plain' }));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, b64);
  await waitReady(page, 1);
  await expect(page.getByTestId('thumb')).toHaveAttribute('aria-label', 'depose.jpg');
});
