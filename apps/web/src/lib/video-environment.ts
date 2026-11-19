/**
 * The environment a video background painter runs in.
 *
 * Decoded frames and the encoder canvas keep the painter on the main thread,
 * but the demux does not need them: the imported bytes are untrusted, so they
 * are read in a module worker. The `new Worker(new URL(...))` expression lives
 * in this app because the bundler only resolves the URL in the app that owns
 * the worker file.
 */

import {
  createWorkerDemux,
  defaultBackgroundVideoEnvironment,
  type BackgroundVideoEnvironment,
  type DemuxWorkerLike,
} from '@quran/render';

export function videoBackgroundEnvironment(): BackgroundVideoEnvironment {
  const environment = defaultBackgroundVideoEnvironment();
  if (typeof Worker !== 'function') return environment;

  return {
    ...environment,
    demuxSource: createWorkerDemux({
      createWorker: () =>
        new Worker(new URL('./demux-worker-entry.ts', import.meta.url), {
          type: 'module',
        }) as unknown as DemuxWorkerLike,
    }),
  };
}
