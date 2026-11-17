import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // A real browser encoding a real video needs room: the whole file is built
  // frame by frame with the hardware (or software) H.264 encoder.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  // The end-to-end journey needs a real origin for workers, OPFS and codecs;
  // `file://` is not a secure context. Serve the static export on localhost.
  use: {
    baseURL: 'http://127.0.0.1:3100',
    // The machine's own Chrome can encode H.264 and AAC; the browsers Playwright
    // downloads are often built without the proprietary codecs.
    channel: 'chrome',
    headless: true,
    launchOptions: {
      // The test plays half a second without a user gesture to prove the audio
      // track decodes; headless Chrome refuses that by default.
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    // Rebuild first so the journey always exercises the current source, then
    // serve the export. Reuse a server left from a previous run when present.
    command: 'npm run build && node e2e/serve.cjs',
    url: 'http://127.0.0.1:3100/bibliotheque/',
    reuseExistingServer: true,
    timeout: 300_000,
  },
});
