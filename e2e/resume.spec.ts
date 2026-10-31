import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTiff } from '../src/core/tiff/decode.ts';
import { freshPage, previewReady, waitReady } from './helpers.ts';

test('reprise d’un export ZIP après rechargement de la page', async ({ page }) => {
  // Fichiers sur disque : leur date de modification est stable (même empreinte à la réimportation).
  const dir = join(tmpdir(), 'scan-resume');
  mkdirSync(dir, { recursive: true });
  const paths = Array.from({ length: 8 }, (_, i) => {
    const p = join(dir, `bobine_${i + 1}.tif`);
    copyFileSync('fixtures/negatif-couleur.tif', p);
    return p;
  });
  await freshPage(page);
  await page.getByTestId('file-input').setInputFiles(paths);
  await waitReady(page, 8);
  await page.getByTestId('open-export').click();
  const dlg = page.getByTestId('export-dialog');
  await dlg.getByLabel(/Toutes/).check();
  await dlg.getByLabel('TIFF 16 bits').check();
  await dlg.locator('select').selectOption('2');
  await dlg.getByTestId('export-go').click();
  // On attend au moins deux images terminées, puis on recharge en plein travail.
  await expect.poll(async () => page.getByTestId('queue').getByText('Terminé').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  await page.reload();

  const queue = page.getByTestId('queue');
  await expect(queue).toContainText('Export interrompu');
  // Les fichiers déposés par <input> ne sont plus lisibles : on les réimporte (réglages retrouvés).
  await expect(page.getByText(/ne sont pas accessibles/)).toBeVisible();
  await page.getByTestId('file-input').setInputFiles(paths);
  await waitReady(page, 8);
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await queue.getByRole('button', { name: 'Reprendre' }).click();
  const zip = unzipSync(new Uint8Array(readFileSync((await (await download).path())!)));
  const names = Object.keys(zip).sort();
  expect(names).toHaveLength(8);
  for (const n of names) expect(decodeTiff(zip[n]).width).toBe(1280);
});

test('l’export (CPU) correspond à l’aperçu (GPU)', async ({ page }) => {
  await freshPage(page);
  await page.getByTestId('file-input').setInputFiles('fixtures/negatif-couleur.tif');
  await previewReady(page);
  await page.locator('[data-preset="couleur-froid-cinema"]').click();
  await page.waitForTimeout(500);
  // Moyenne de blocs (le grain diffère d'échelle entre aperçu et pleine résolution).
  const regions = [[0.2, 0.15], [0.5, 0.5], [0.75, 0.85], [0.1, 0.9], [0.72, 0.25]] as const;
  const gpu = await page.evaluate((regions) => {
    const c = document.querySelector('[data-testid=preview]') as HTMLCanvasElement;
    const gl = c.getContext('webgl2')!;
    return regions.map(([u, v]) => {
      const n = 9;
      const px = new Uint8Array(n * n * 4);
      gl.readPixels(Math.floor(u * c.width) - 4, Math.floor((1 - v) * c.height) - 4, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const m = [0, 0, 0];
      for (let i = 0; i < n * n; i++) for (let k = 0; k < 3; k++) m[k] += px[i * 4 + k] / (n * n);
      return m;
    });
  }, regions);
  await page.getByTestId('open-export').click();
  const dlg = page.getByTestId('export-dialog');
  await dlg.getByLabel('Image affichée').check();
  await dlg.getByLabel('TIFF 16 bits').check();
  const download = page.waitForEvent('download');
  await dlg.getByTestId('export-go').click();
  const r = decodeTiff(new Uint8Array(readFileSync((await (await download).path())!)));
  const cpu = regions.map(([u, v]) => {
    const n = 12;
    const cx = Math.floor(u * r.width), cy = Math.floor(v * r.height);
    const m = [0, 0, 0];
    for (let y = cy - n; y < cy + n; y++) for (let x = cx - n; x < cx + n; x++) for (let k = 0; k < 3; k++) m[k] += r.data[(y * r.width + x) * 3 + k] / 257 / (4 * n * n);
    return m;
  });
  const diffs = gpu.map((g, i) => Math.max(...g.map((v, k) => Math.abs(v - cpu[i][k]))));
  console.log('écart aperçu/export par zone (sur 255) :', diffs.map((d) => d.toFixed(1)).join(', '));
  for (const d of diffs) expect(d).toBeLessThan(10);
});
