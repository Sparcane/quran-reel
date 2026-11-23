/* global process, console, Buffer, document */
/**
 * Long-render check on a real device: one 62 second video in a single job.
 *
 * This is the journey the S9+ used to crash on. Progress arrived once per
 * frame and the job record — recitation audio included — was rewritten to
 * IndexedDB for every tick, so the tab died at a few percent. The running
 * percentage now stays in memory (see `queue-store.ts`), and this run proves
 * it end to end on the phone: drawn, recorded, muxed and played back.
 *
 * Same adb setup as e2e/device-test.cjs; run with: node e2e/device-long.cjs
 */
const { chromium } = require('@playwright/test');

const URL = process.env.DEVICE_URL || 'http://127.0.0.1:3100';
const CDP = process.env.DEVICE_CDP || 'http://127.0.0.1:9222';
const SECONDS = Number(process.env.DEVICE_SECONDS || 62);
const SHOT = process.env.DEVICE_SHOT || 'device-long.png';

function silentWav(durationSec, rate = 8000) {
  const dataSize = Math.round(durationSec * rate) * 2;
  const file = Buffer.alloc(44 + dataSize);
  file.write('RIFF', 0); file.writeUInt32LE(36 + dataSize, 4); file.write('WAVE', 8);
  file.write('fmt ', 12); file.writeUInt32LE(16, 16); file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22); file.writeUInt32LE(rate, 24); file.writeUInt32LE(rate * 2, 28);
  file.writeUInt16LE(2, 32); file.writeUInt16LE(16, 34); file.write('data', 36);
  file.writeUInt32LE(dataSize, 40);
  return file;
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  for (const old of context.pages()) {
    if (old.url().startsWith(URL)) await old.close().catch(() => undefined);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('crash', () => errors.push('tab crashed'));
  await page.route('https://everyayah.com/**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' },
      body: silentWav(SECONDS),
    }),
  );

  await page.goto(`${URL}/bibliotheque/`, { timeout: 45000 });
  await page.getByLabel('Rechercher une sourate').fill('yassin');
  await page.getByRole('link', { name: /Yâ-Sîn/ }).click();
  await page.getByLabel('Sélectionner le verset 1', { exact: true }).check();
  await page.getByRole('button', { name: /Studio/ }).click();
  // Square keeps the pixel count down; the point of the run is the length.
  await page.getByLabel('Format 1:1').check();
  console.log(`[device] studio ready, ${SECONDS}s`);

  const started = Date.now();
  await page.getByRole('button', { name: /Générer/ }).click();
  let done = false;
  for (let i = 0; i < 40 && !done; i += 1) {
    await page.waitForTimeout(5000);
    const text = await page
      .evaluate(() => (document.body?.innerText ?? '').slice(0, 90).replace(/\n/g, ' | '))
      .catch((error) => 'EVAL FAILED ' + String(error).slice(0, 60));
    console.log(`[device t+${Math.round((Date.now() - started) / 1000)}s] ${text}`);
    done = /Télécharger|échoué/.test(text);
  }

  const body = await page.evaluate(() => document.body?.innerText ?? '');
  if (/échoué/i.test(body)) throw new Error('render failed: ' + body.slice(0, 160));

  const info = await page.locator('video').evaluate((element) => ({
    duration: element.duration,
    width: element.videoWidth,
    height: element.videoHeight,
    error: element.error?.message ?? '',
  }));
  console.log('[device] video ' + JSON.stringify(info));
  if (!(info.duration > SECONDS - 2)) throw new Error('video is too short: ' + info.duration);

  await page.locator('video').evaluate((element) => {
    element.muted = true;
    return element.play();
  });
  await page.waitForFunction(
    () => (document.querySelector('video')?.currentTime ?? 0) > 1,
    undefined,
    { timeout: 30000 },
  );
  await page.screenshot({ path: SHOT });
  console.log(
    `[device] done in ${Math.round((Date.now() - started) / 1000)}s, ` +
      `${errors.length} page error(s) ${JSON.stringify(errors)}`,
  );
  await browser.close();
  if (errors.length > 0) process.exitCode = 1;
})().catch((error) => {
  console.error('[device] failed: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
