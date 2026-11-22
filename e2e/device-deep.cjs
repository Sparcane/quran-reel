/* global process, console, Buffer, window, document, btoa, fetch */
/**
 * Deeper real-device suite: gradient, imported image, imported video, square
 * format with word-by-word subtitles, history and axe. Same adb setup as
 * e2e/device-test.cjs; run with: node e2e/device-deep.cjs
 */
const { chromium } = require('@playwright/test');
const zlib = require('node:zlib');

const URL = process.env.DEVICE_URL || 'http://127.0.0.1:3100';
const CDP = process.env.DEVICE_CDP || 'http://127.0.0.1:9222';
const AXE = require.resolve('axe-core/axe.min.js');

function silentWav(durationSec, rate = 8000) {
  const samples = Math.round(durationSec * rate);
  const dataSize = samples * 2;
  const file = Buffer.alloc(44 + dataSize);
  file.write('RIFF', 0); file.writeUInt32LE(36 + dataSize, 4); file.write('WAVE', 8);
  file.write('fmt ', 12); file.writeUInt32LE(16, 16); file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22); file.writeUInt32LE(rate, 24); file.writeUInt32LE(rate * 2, 28);
  file.writeUInt16LE(2, 32); file.writeUInt16LE(16, 34); file.write('data', 36);
  file.writeUInt32LE(dataSize, 40);
  return file;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(width = 64, height = 64) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.alloc(1 + width * 3);
  row.fill(0x33);
  row[0] = 0; // PNG filter: none
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  const jsErrors = [];
  page.on('pageerror', (error) => jsErrors.push(error.message));
  await page.route('https://everyayah.com/**', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' }, body: silentWav(0.5) }),
  );
  const report = {};

  async function selectVerses() {
    await page.goto(`${URL}/bibliotheque/`, { timeout: 30000 });
    await page.getByLabel('Rechercher une sourate').fill('yassin');
    await page.getByRole('link', { name: /Yâ-Sîn/ }).click();
    await page.getByLabel('Sélectionner le verset 1', { exact: true }).check();
    await page.getByLabel('Sélectionner le verset 2', { exact: true }).check();
    await page.getByRole('button', { name: /Studio/ }).click();
  }

  async function render(name, setup) {
    await selectVerses();
    if (setup) await setup();
    await page.getByRole('button', { name: /Générer/ }).click();
    await page.waitForFunction(
      () => /Télécharger|rendu a échoué/i.test(document.body?.innerText ?? ''),
      undefined, { timeout: 180000 },
    );
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    if (/rendu a échoué/i.test(text)) {
      report[name] = { ok: false, error: text.replace(/\n/g, ' | ').slice(0, 300) };
      return null;
    }
    await page.waitForFunction(() => !!document.querySelector('video'), undefined, { timeout: 30000 });
    await page.locator('video').evaluate((el) => { el.muted = true; return el.play(); });
    await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0, undefined, { timeout: 20000 });
    const state = await page.locator('video').evaluate((el) => ({
      time: el.currentTime, duration: el.duration, w: el.videoWidth, h: el.videoHeight, error: el.error?.message ?? '',
    }));
    const clip = await page.evaluate(async () => {
      const src = document.querySelector('video')?.src;
      if (!src) return null;
      const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    });
    report[name] = { ok: true, ...state, bytes: clip ? Buffer.from(clip, 'base64').length : 0 };
    return clip ? Buffer.from(clip, 'base64') : null;
  }

  const firstClip = await render('gradient-9x16-verse');
  console.log('[scenario] gradient done');

  if (firstClip) {
    await render('image-background', async () => {
      await page.locator('#studio-background-file').setInputFiles({ name: 'fond.png', mimeType: 'image/png', buffer: png() });
      await page.getByText(/Fond importé/).waitFor({ timeout: 15000 });
    });
    console.log('[scenario] image done');

    await render('video-background', async () => {
      await page.locator('#studio-background-file').setInputFiles({ name: 'fond.mp4', mimeType: 'video/mp4', buffer: firstClip });
      await page.getByText(/Fond importé/).waitFor({ timeout: 15000 });
    });
    console.log('[scenario] video done');
  }

  await render('1x1-word-by-word', async () => {
    await page.getByLabel('Format 1:1').check();
    await page.getByLabel(/Mot par mot/).check();
  });
  console.log('[scenario] 1x1 words done');

  await page.goto(`${URL}/studio/`, { timeout: 30000 });
  report.history = {
    heading: await page.getByRole('heading', { name: /Vidéos récentes/ }).isVisible(),
    links: await page.getByRole('link', { name: 'Voir', exact: true }).count(),
  };

  for (const route of ['/bibliotheque/', '/studio/']) {
    await page.goto(URL + route, { timeout: 30000 });
    await page.addScriptTag({ path: AXE });
    const violations = await page.evaluate(async () => {
      const results = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
      return results.violations.map((v) => `${v.id}: ${v.nodes.length}`);
    });
    report[`axe${route}`] = violations;
  }

  console.log('[report] ' + JSON.stringify(report, null, 2));
  console.log('[jsErrors] ' + JSON.stringify(jsErrors));
  await page.close();
  await browser.close();
})().catch((error) => {
  console.error('[fail] ' + (error instanceof Error ? error.stack : String(error)));
  process.exitCode = 1;
});
