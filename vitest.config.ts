import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // The app's tsconfig says `jsx: preserve` for Next; the plugin gives the
  // tests the automatic runtime instead of parsing JSX that nothing compiles.
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./apps/web/test/setup.ts'],
    include: [
      'packages/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.tsx',
      'apps/web/test/**/*.test.ts',
      'apps/web/test/**/*.test.tsx',
      'scripts/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/e2e/**'],
  },
  resolve: {
    alias: {
      'next/link': r('./apps/web/test/next-link-stub.tsx'),
      '@quran/core': r('./packages/core/src/index.ts'),
      '@quran/render': r('./packages/render/src/index.ts'),
      '@': r('./apps/web/src'),
    },
  },
});
