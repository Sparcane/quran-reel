/* global process, console, Buffer, document, window, fetch, btoa */
/**
 * Real-recitation check: seven verses of Al-Baqara with their actual sound.
 *
 * The other e2e journeys stand a silent WAV in for EveryAyah so they never need
 * the network — which is why their videos play without audio. This one uses the
 * real MP3s, renders the whole thing in the app, and writes the finished file
 * out so it can be inspected with ffprobe.
 *
 * Run on this machine:   node e2e/recitation-check.cjs
 * Run on a phone:        adb reverse tcp:3100 tcp:3100
 *                        adb forward tcp:9222 localabstract:chrome_devtools_remote
 *                        node e2e/serve.cjs   (in another shell)
 *                        DEVICE_CDP=http://127.0.0.1:9222 node e2e/recitation-check.cjs
 *
 * Env: OUT (destination, default quran-baqara.mp4), ASPECT (default 9:16),
 *      VERSES (default 7), RENDER_TIMEOUT_SEC (default 420).
 */
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const URL = process.env.DEVICE_URL || 'http://127.0.0.1:3100';
const CDP = process.env.DEVICE_CDP || '';
const OUT = path.resolve(process.env.OUT || 'quran-baqara.mp4');
const ASPECT = process.env.ASPECT || '9:16';
const VERSES = Number(process.env.VERSES || 7);
const TIMEOUT_SEC = Number(process.env.RENDER_TIMEOUT_SEC || 420);
const CHUNK = 3 * 1024 * 1024;

async function openPage() {
  if (CDP) {
    const browser = await chromium.connectOverCDP(CDP);
    const context = browser.contexts()[0];
    for (const old of context.pages()) {
      if (old.url().startsWith(URL)) await old.close().catch(() => undefined);
    }
    return { browser, page: await context.newPage() };
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'fr-FR', acceptDownloads: true });
  return { browser, page: await context.newPage() };
}

/** Pulls the finished video out of the page, chunk by chunk, as base64. */
async function saveResult(page, destination) {
  await page.evaluate(async () => {
    const element = document.querySelector('video');
    const response = await fetch(element.src);
    window.__result = new Uint8Array(await response.arrayBuffer());
  });
  const size = await page.evaluate(() => window.__result.byteLength);
  const handle = fs.openSync(destination, 'w');
  try {
    for (let offset = 0; offset < size; offset += CHUNK) {
      const base64 = await page.evaluate(
        ({ from, to }) => {
          const slice = window.__result.subarray(from, to);
          let text = '';
          for (let i = 0; i < slice.length; i += 0x8000) {
            text += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000));
          }
          return btoa(text);
        },
        { from: offset, to: Math.min(offset + CHUNK, size) },
      );
      fs.writeSync(handle, Buffer.from(base64, 'base64'));
    }
  } finally {
    fs.closeSync(handle);
  }
  return size;
}

(async () => {
  const { browser, page } = await openPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Like the Playwright suite: the static export has no RSC payload for the
    // dynamic result route, so the router's prefetch 404s harmlessly.
    if (/__next\./.test(message.location().url)) return;
    errors.push(`${message.text()} (${message.location().url})`);
  });

  if (!CDP) await page.goto(`${URL}/bibliotheque/`);
  else await page.goto(`${URL}/bibliotheque/`, { timeout: 45000 });

  await page.getByLabel('Rechercher une sourate').fill('baqara');
  await page.getByRole('link', { name: /Al-Baqara/ }).first().click();
  for (let verse = 1; verse <= VERSES; verse += 1) {
    await page.getByLabel(`Sélectionner le verset ${verse}`, { exact: true }).check();
  }
  await page.getByRole('button', { name: /Studio/ }).click();
  await page.getByLabel(`Format ${ASPECT}`).check();
  console.log(`[recitation] ${VERSES} versets d'Al-Baqara, format ${ASPECT}, audio réel`);

  const started = Date.now();
  await page.getByRole('button', { name: /Générer/ }).click();
  const deadline = started + TIMEOUT_SEC * 1000;
  let state = '';
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    state = await page.evaluate(() => document.body.innerText.slice(0, 120).replace(/\n/g, ' | '));
    console.log(`[recitation t+${Math.round((Date.now() - started) / 1000)}s] ${state}`);
    if (/Télécharger|échoué/.test(state)) break;
  }
  if (/échoué/i.test(state)) throw new Error('render failed: ' + state);
  if (!/Télécharger/.test(state)) throw new Error(`no result after ${TIMEOUT_SEC}s: ${state}`);

  const bytes = await saveResult(page, OUT);
  const info = await page.locator('video').evaluate((element) => ({
    duration: element.duration,
    width: element.videoWidth,
    height: element.videoHeight,
    error: element.error?.message ?? '',
  }));
  await page.locator('video').evaluate((element) => {
    element.muted = true;
    return element.play();
  });
  await page.waitForFunction(
    () => (document.querySelector('video')?.currentTime ?? 0) > 1,
    undefined,
    { timeout: 30000 },
  );

  console.log(
    `[recitation] ${OUT} ${bytes} octets, ${JSON.stringify(info)}, ` +
      `${Math.round((Date.now() - started) / 1000)}s de rendu, ${errors.length} erreur(s)`,
  );
  if (errors.length) console.log('[recitation] erreurs: ' + JSON.stringify(errors.slice(0, 5)));
  await browser.close();
  if (errors.length) process.exitCode = 1;
})().catch((error) => {
  console.error('[recitation] échec: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
