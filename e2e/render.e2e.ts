import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The journey follows the French labels the plan specifies. Pin the browser
// locale so detectLocale() cannot pick the machine's default (English here).
test.use({ locale: 'fr-FR' });

/**
 * A tiny, valid PCM WAV stood in for EveryAyah's MP3s. The journey must not
 * depend on the network, and a silent verse is enough to prove the decoded
 * audio reaches the AAC track (the WebCodecs e2e checks the sound itself).
 */
function silentWav(durationSec: number, rate = 8_000): Buffer {
  const samples = Math.round(durationSec * rate);
  const dataSize = samples * 2; // 16-bit mono
  const file = Buffer.alloc(44 + dataSize);
  file.write('RIFF', 0);
  file.writeUInt32LE(36 + dataSize, 4);
  file.write('WAVE', 8);
  file.write('fmt ', 12);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20); // PCM
  file.writeUInt16LE(1, 22); // mono
  file.writeUInt32LE(rate, 24);
  file.writeUInt32LE(rate * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36);
  file.writeUInt32LE(dataSize, 40);
  return file;
}

test('parcours complet : 3 versets → MP4', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // A static export has no RSC payload for a dynamic segment; the router
    // still prefetches one and the browser logs a harmless 404. Every real
    // pipeline error is collected below.
    if (/__next\..*__PAGE__\.txt/.test(message.location().url)) return;
    errors.push(message.text());
  });
  await page.route('https://everyayah.com/**', (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'content-type': 'audio/wav',
        'access-control-allow-origin': '*',
      },
      body: silentWav(0.5),
    }),
  );

  await page.goto('/bibliotheque/');
  await page.getByLabel('Rechercher une sourate').fill('yassin');
  await page.getByRole('link', { name: /Yâ-Sîn/ }).click();
  await page.getByLabel('Sélectionner le verset 1', { exact: true }).check();
  await page.getByLabel('Sélectionner le verset 2', { exact: true }).check();
  await page.getByLabel('Sélectionner le verset 3', { exact: true }).check();
  await page.getByRole('button', { name: /Studio/ }).click();
  await page.getByLabel('Format 9:16').check();
  await page.getByRole('button', { name: /Générer/ }).click();

  // The download link only appears once the job is genuinely done; polling a
  // transient "100 %" label would be flaky at a 500 ms refresh.
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('link', { name: /Télécharger/ }).click();
  const file = await (await download).path();
  expect(file).toBeTruthy();

  const head = readFileSync(file!).subarray(0, 12);
  expect(head.toString('ascii', 4, 8)).toBe('ftyp');
  expect(errors).toEqual([]);
});
