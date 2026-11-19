import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ locale: 'fr-FR' });

function silentWav(durationSec: number, rate = 8_000): Buffer {
  const samples = Math.round(durationSec * rate);
  const dataSize = samples * 2;
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

/**
 * The render must produce a watchable file even when WebCodecs is present but
 * cannot encode H.264 (Firefox). Chrome takes the WebCodecs path and writes MP4;
 * Firefox takes MediaRecorder and writes WebM. Both are accepted here.
 */
test('a render produces a playable file on any browser with an encoder', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // MediaRecorder renders on the main thread, where Chromium advertises
  // showSaveFilePicker but headless cannot answer it. Let the sink use OPFS.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.route('https://everyayah.com/**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' },
      body: silentWav(0.5),
    }),
  );

  await page.goto('/bibliotheque/');
  await page.getByLabel('Rechercher une sourate').fill('yassin');
  await page.getByRole('link', { name: /Yâ-Sîn/ }).click();
  await page.getByLabel('Sélectionner le verset 1', { exact: true }).check();
  await page.getByRole('button', { name: /Studio/ }).click();
  await page.getByRole('button', { name: /Générer/ }).click();

  // Fail fast with the page's own message: a timeout on a missing link says
  // nothing about why the render was refused.
  await page.waitForFunction(
    () => /Télécharger|rendu a échoué/i.test(document.body?.innerText ?? ''),
    undefined,
    { timeout: 120_000 },
  );
  if (await page.getByRole('heading', { name: /échoué/i }).count()) {
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    throw new Error(`render failed; the result page says: ${text.slice(-1200)}`);
  }

  const link = page.getByRole('link', { name: /Télécharger/ });
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await link.click();
  const file = await (await download).path();
  expect(file).toBeTruthy();
  const head = readFileSync(file!);
  const webm = head.subarray(0, 4).toString('hex') === '1a45dfa3';
  const mp4 = head.toString('ascii', 4, 8) === 'ftyp';
  expect(webm || mp4).toBe(true);

  const player = page.locator('video');
  await player.evaluate((element: HTMLVideoElement) => {
    element.muted = true;
    return element.play();
  });
  await page.waitForFunction(
    () => ((document.querySelector('video') as HTMLVideoElement | null)?.currentTime ?? 0) > 0,
    undefined,
    { timeout: 15_000 },
  );
  expect(await player.evaluate((element: HTMLVideoElement) => element.error?.message ?? '')).toBe('');

  expect(errors).toEqual([]);
});
