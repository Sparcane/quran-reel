import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * Real WebKit, used on a macOS runner where the system codecs are available.
 * Only the container-agnostic journey runs here: WebKit may encode MP4 or fall
 * back to WebM, and both are playable results.
 */
export default defineConfig({
  ...base,
  testMatch: '**/fallback.e2e.ts',
  use: { ...base.use, channel: undefined },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'], channel: undefined } }],
});
