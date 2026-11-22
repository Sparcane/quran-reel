/* global process, console, Buffer, navigator, window, document */
/**
 * Real-device journey on a physical Android phone, driven through Chrome's
 * DevTools socket over adb. Prerequisites (run once per USB session):
 *
 *   adb reverse tcp:3100 tcp:3100
 *   adb forward tcp:9222 localabstract:chrome_devtools_remote
 *   node e2e/serve.cjs              # in another terminal
 *   adb shell am start -a android.intent.action.VIEW \
 *     -d http://127.0.0.1:3100/bibliotheque/ \
 *     -n com.android.chrome/com.google.android.apps.chrome.Main
 *
 * Then: node e2e/device-test.cjs
 */
const { chromium } = require('@playwright/test');

const URL = process.env.DEVICE_URL || 'http://127.0.0.1:3100';
const CDP = process.env.DEVICE_CDP || 'http://127.0.0.1:9222';

function silentWav(durationSec, rate = 8000) {
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

async function main() {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('console: ' + message.text());
  });
  await page.route('https://everyayah.com/**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' },
      body: silentWav(0.5),
    }),
  );

  console.log('[device] ' + JSON.stringify(await page.evaluate(() => ({
    ua: navigator.userAgent,
    webCodecs: typeof VideoEncoder === 'function',
    mediaRecorder: typeof MediaRecorder === 'function',
    opfs: typeof navigator.storage?.getDirectory === 'function',
    secure: window.isSecureContext,
  }))));

  await page.goto(`${URL}/bibliotheque/`, { timeout: 30000 });
  await page.getByLabel('Rechercher une sourate').fill('yassin');
  await page.getByRole('link', { name: /Yâ-Sîn/ }).click();
  await page.getByLabel('Sélectionner le verset 1', { exact: true }).check();
  await page.getByLabel('Sélectionner le verset 2', { exact: true }).check();
  await page.getByRole('button', { name: /Studio/ }).click();
  await page.getByRole('button', { name: /Générer/ }).click();

  await page.waitForFunction(
    () => /Télécharger|rendu a échoué/i.test(document.body?.innerText ?? ''),
    undefined,
    { timeout: 180000 },
  );
  const text = await page.evaluate(() => document.body?.innerText ?? '');
  if (/rendu a échoué/i.test(text)) throw new Error('render failed on device: ' + text.slice(0, 400));
  console.log('[result] ' + text.slice(0, 200).replace(/\n/g, ' | '));

  const player = page.locator('video');
  await page.waitForFunction(() => !!document.querySelector('video'), undefined, { timeout: 30000 });
  await player.evaluate((element) => {
    element.muted = true;
    return element.play();
  });
  await page.waitForFunction(
    () => (document.querySelector('video')?.currentTime ?? 0) > 0,
    undefined,
    { timeout: 20000 },
  );
  const playback = await player.evaluate((element) => ({
    currentTime: element.currentTime,
    duration: element.duration,
    error: element.error?.message ?? '',
    width: element.videoWidth,
    height: element.videoHeight,
  }));
  console.log('[playback] ' + JSON.stringify(playback));

  await page.close();
  await browser.close();
  if (playback.error) throw new Error(playback.error);
  console.log('[errors] ' + JSON.stringify(errors.filter((line) => !/404/.test(line))));
}

main().catch((error) => {
  console.error('[fail] ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
