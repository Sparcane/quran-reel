import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EncodeReport } from './fixtures/encode-entry';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * One small bundle, built once: esbuild resolves the workspace aliases the same
 * way the app's bundler does, and the result is served from a fake origin so
 * the page is a secure context (WebCodecs requires one).
 */
const bundle = buildSync({
  entryPoints: [path.join(root, 'e2e/fixtures/encode-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  logLevel: 'silent',
  alias: {
    '@quran/core': path.join(root, 'packages/core/src/index.ts'),
    '@quran/render': path.join(root, 'packages/render/src/index.ts'),
  },
}).outputFiles[0].text;

const html = '<!doctype html><html><head><meta charset="utf-8"><title>render</title></head>' +
  '<body><script src="/bundle.js"></script></body></html>';

test('renders a real MP4 with WebCodecs and plays it back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.route('https://quran.test/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/bundle.js') {
      await route.fulfill({ body: bundle, contentType: 'text/javascript; charset=utf-8' });
    } else {
      await route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
    }
  });

  await page.goto('https://quran.test/');
  await page.waitForFunction(
    () => typeof (window as unknown as { runQuranEncode?: unknown }).runQuranEncode === 'function',
  );

  const report = await page.evaluate(
    () => (window as unknown as { runQuranEncode: () => Promise<EncodeReport> }).runQuranEncode(),
  );

  expect(errors).toEqual([]);

  // The bytes are an MP4 a player recognises…
  expect(report.ftyp).toBe('ftyp');
  expect(report.container).toBe('mp4');
  expect(report.videoCodec).toBe('avc1');

  // …for the frame size and duration the plan asked for.
  expect(report.width).toBe(1080);
  expect(report.height).toBe(1920);
  expect(report.durationSec).toBeCloseTo(4.4, 2);
  expect(report.size).toBeGreaterThan(50_000);

  // The progress the UI would show runs from 0 to 100 without going back.
  expect(report.progress.first).toBe(0);
  expect(report.progress.last).toBe(100);
  expect(report.progress.monotonic).toBe(true);

  // And a real <video> element opens it, knows its size and decodes a frame.
  expect(report.playback.videoWidth).toBe(1080);
  expect(report.playback.videoHeight).toBe(1920);
  expect(report.playback.duration).toBeCloseTo(4.4, 1);
  expect(report.playback.readyState).toBeGreaterThanOrEqual(2);
  // The AAC track is not just declared: the player decoded sound from it.
  expect(report.playback.audioBytes).toBeGreaterThan(0);

  test.info().annotations.push({
    type: 'throughput',
    description: `${report.framesPerSecond.toFixed(1)} fps, ${(report.size / 1_000_000).toFixed(2)} MB in ${(report.elapsedMs / 1000).toFixed(1)} s`,
  });
  console.log(
    `[render] ${report.framesPerSecond.toFixed(1)} fps · ${(report.size / 1_000_000).toFixed(2)} MB · ${(report.elapsedMs / 1000).toFixed(1)} s for 4.4 s of video`,
  );
});
