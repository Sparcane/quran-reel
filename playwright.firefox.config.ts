import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Firefox: WebCodecs exists but H.264 encoding does not, so this exercises the fallback. */
export default defineConfig({
  ...base,
  testMatch: '**/fallback.e2e.ts',
  use: { ...base.use, channel: undefined },
  projects: [{ name: 'firefox', use: { ...devices['Desktop Firefox'] } }],
});
