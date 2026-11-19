import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Browsers without proprietary H.264 codecs: both must take the MediaRecorder fallback. */
export default defineConfig({
  ...base,
  testMatch: '**/fallback.e2e.ts',
  use: { ...base.use, channel: undefined },
  projects: [
    { name: 'firefox', use: { ...devices['Desktop Firefox'], channel: undefined } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: undefined } },
  ],
});
