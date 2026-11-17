/**
 * The app-wide render runtime: one queue, one renderer, bound to the device
 * store. Kept out of the components so a result page does not create a second
 * queue and start racing the studio over which job runs next.
 */

import {
  createQueue,
  createRenderer,
  defaultRendererEnvironment,
  type RenderJob,
  type RenderSpec,
  type RenderWorkerLike,
  type VideoRenderer,
} from '@quran/render';
import { jobStore } from '@/lib/queue-store';

export const renderQueue = createQueue(jobStore);

let renderer: VideoRenderer | null = null;
function sharedRenderer(): VideoRenderer {
  if (renderer !== null) return renderer;

  // The `new Worker(new URL(...))` expression must live in the app that owns the
  // worker file. In the workspace package Turbopack follows the URL through the
  // node_modules symlink and never finishes building. Everything else — codecs,
  // sink, selection — comes from the package environment.
  const environment = defaultRendererEnvironment(() =>
    typeof Worker === 'function'
      ? (new Worker(new URL('./render-worker-entry.ts', import.meta.url), {
          type: 'module',
        }) as unknown as RenderWorkerLike)
      : null,
  );
  renderer = createRenderer(environment);
  return renderer;
}

/** Stores the spec as a job and pumps the queue if it is idle. */
export async function startRender(spec: RenderSpec): Promise<RenderJob> {
  const job = await renderQueue.enqueue(spec);
  if (!renderQueue.isBusy()) {
    // A render outlives the click that started it; the result page polls the
    // store for progress rather than holding this promise.
    void renderQueue.runNext(sharedRenderer());
  }
  return job;
}

/** A job still `running` after a restart is interrupted, not half-finished. */
export async function recoverQueue(): Promise<void> {
  await renderQueue.recover();
}
