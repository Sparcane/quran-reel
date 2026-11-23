import { expect, test } from '@playwright/test';

/**
 * A render longer than a minute, in one job.
 *
 * The bug this guards against does not show on the short renders the other
 * journeys use: progress arrives once per frame, and persisting each tick
 * rewrote the job record — recitation audio included, about 12 MB a minute —
 * hundreds of times. The tab stopped answering around 1600 frames and the job
 * never finished. A minute is the shortest length where that is unavoidable.
 */
test.use({ locale: 'fr-FR' });

function silentWav(durationSec: number, rate = 8_000): Buffer {
  const dataSize = Math.round(durationSec * rate) * 2;
  const file = Buffer.alloc(44 + dataSize);
  file.write('RIFF', 0);
  file.writeUInt32LE(36 + dataSize, 4);
  file.write('WAVE', 8);
  file.write('fmt ', 12);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(rate, 24);
  file.writeUInt32LE(rate * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36);
  file.writeUInt32LE(dataSize, 40);
  return file;
}

test('renders a video longer than a minute in one job', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://everyayah.com/**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' },
      body: silentWav(62),
    }),
  );

  await page.goto('/bibliotheque/');
  await page.getByLabel('Rechercher une sourate').fill('yassin');
  await page.getByRole('link', { name: /Yâ-Sîn/ }).click();
  await page.getByLabel('Sélectionner le verset 1', { exact: true }).check();
  await page.getByRole('button', { name: /Studio/ }).click();
  // 1:1 keeps the pixel count down: this test is about the length, and a slow
  // machine should fail on the length only.
  await page.getByLabel('Format 1:1').check();
  await page.getByRole('button', { name: /Générer/ }).click();

  const download = page.getByRole('link', { name: /Télécharger/ });
  await expect(download).toBeVisible({ timeout: 200_000 });
  const duration = await page
    .locator('video')
    .evaluate((element: HTMLVideoElement) => element.duration);
  expect(duration).toBeGreaterThan(60);
  expect(errors).toEqual([]);
});
