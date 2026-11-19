import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

  // A done job must stop being polled. Every read rebuilds the Blob and its
  // object URL, and a changing <video src> restarts playback from zero.
  const player = page.locator('video');
  const src = await player.getAttribute('src');
  expect(src).toBeTruthy();
  await page.waitForTimeout(1_300);
  expect(await player.getAttribute('src')).toBe(src);

  // A header that merely says "ftyp" is not enough. WebCodecs reports its
  // avcC as an ArrayBuffer inside the worker; writing it as a Uint8Array gave an
  // empty description and a file Chrome could not decode at all.
  await player.evaluate((element: HTMLVideoElement) => {
    element.muted = true;
    return element.play();
  });
  await page.waitForFunction(
    () => ((document.querySelector('video') as HTMLVideoElement | null)?.currentTime ?? 0) > 0,
    undefined,
    { timeout: 10_000 },
  );
  expect(await player.evaluate((element: HTMLVideoElement) => element.error?.message ?? '')).toBe('');

  // The finished render must really reach the history; an empty list here was
  // the second production bug the review found (addToHistory was never called).
  await page.getByRole('link', { name: /Retour au Studio/ }).click();
  await expect(page.getByRole('heading', { name: /Vidéos récentes/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Voir', exact: true }).first()).toBeVisible();

  expect(errors).toEqual([]);
});

/**
 * The imported background is the one journey a unit test cannot prove: WebCodecs
 * recycles a small pool of output buffers, and the painter used to keep every
 * VideoFrame open — the decoder then stopped without ever raising an error. Build
 * a real, decodable MP4 with the app, import it back, and render a second video.
 */
test('un fond vidéo importé est décodé puis rendu à nouveau', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // A video background renders on the main thread, where headless Chrome
  // exposes showSaveFilePicker but cannot answer it. Let the sink choose OPFS
  // instead, as it already does inside the render worker.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
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

  // First render: a gradient, whose output is a real decodable H.264 file.
  await page.goto('/bibliotheque/');
  await page.getByLabel('Rechercher une sourate').fill('yassin');
  await page.getByRole('link', { name: /Yâ-Sîn/ }).click();
  await page.getByLabel('Sélectionner le verset 1', { exact: true }).check();
  await page.getByLabel('Sélectionner le verset 2', { exact: true }).check();
  await page.getByRole('button', { name: /Studio/ }).click();
  await page.getByLabel('Format 9:16').check();
  await page.getByRole('button', { name: /Générer/ }).click();

  const firstDownload = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('link', { name: /Télécharger/ }).click();
  const background = path.join(testInfo.outputDir, 'fond.mp4');
  await (await firstDownload).saveAs(background);
  expect(readFileSync(background).toString('ascii', 4, 8)).toBe('ftyp');

  // The selection and the format survive the reload: the store persists them.
  await page.goto('/studio/');
  await page.locator('#studio-background-file').setInputFiles(background);
  await expect(page.getByText(/Fond importé/)).toBeVisible();
  await page.getByRole('button', { name: /Générer/ }).click();

  const secondDownload = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('link', { name: /Télécharger/ }).click();
  const second = await (await secondDownload).path();
  expect(second).toBeTruthy();
  expect(readFileSync(second!).toString('ascii', 4, 8)).toBe('ftyp');

  const player = page.locator('video');
  await player.evaluate((element: HTMLVideoElement) => {
    element.muted = true;
    return element.play();
  });
  await page.waitForFunction(
    () => ((document.querySelector('video') as HTMLVideoElement | null)?.currentTime ?? 0) > 0,
    undefined,
    { timeout: 10_000 },
  );
  expect(await player.evaluate((element: HTMLVideoElement) => element.error?.message ?? '')).toBe('');

  expect(errors).toEqual([]);
});
