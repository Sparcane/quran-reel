/**
 * Entry point of the demux worker, owned by the web app so the bundler can
 * resolve `new URL('./demux-worker-entry.ts', import.meta.url)` locally. The
 * parsing itself lives in `@quran/render`.
 */
import { installDemuxHandler } from '@quran/render';

installDemuxHandler(globalThis as unknown as Parameters<typeof installDemuxHandler>[0]);
