import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/test/**/*.test.ts',
      'apps/web/test/**/*.test.ts',
      'apps/web/test/**/*.test.tsx',
      'scripts/test/**/*.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@quran/core': r('./packages/core/src/index.ts'),
      '@quran/render': r('./packages/render/src/index.ts'),
      '@': r('./apps/web/src'),
    },
  },
});
