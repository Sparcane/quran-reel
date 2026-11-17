/**
 * Entry point of the render worker, owned by the web app so the bundler can
 * resolve `new URL('./render-worker-entry.ts', import.meta.url)` locally. The
 * worker logic itself lives in `@quran/render`; only the bootstrap is here.
 */
import { installWorkerHandler } from '@quran/render';

installWorkerHandler(globalThis as unknown as Parameters<typeof installWorkerHandler>[0]);
