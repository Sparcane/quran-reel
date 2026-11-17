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
import { addToHistory } from '@/lib/history';
import { jobStore } from '@/lib/queue-store';

export const renderQueue = createQueue(jobStore);

/**
 * The `new Worker(new URL(...))` expression must live in the app that owns the
 * worker file. In the workspace package Turbopack follows the URL through the
 * node_modules symlink and never finishes building. Only a gradient can be
 * described across that boundary; an imported background keeps the main thread
 * so its real painter (and asset bytes) stay available to the encoder.
 */
function rendererFor(spec: RenderSpec): VideoRenderer {
  const offload = spec.backgroundSelection?.kind === 'gradient';
  const environment = defaultRendererEnvironment(
    offload
      ? () =>
          typeof Worker === 'function'
            ? (new Worker(new URL('./render-worker-entry.ts', import.meta.url), {
                type: 'module',
              }) as unknown as RenderWorkerLike)
            : null
      : () => null,
  );
  return createRenderer(environment);
}

/**
 * Stores the spec as a queued job. A static export cannot route to a dynamic
 * result page from the client (Next prerenders /rendu/[id] once as /rendu/_),
 * so the studio opens the result page with a full page load. That reload ends
 * this JavaScript context: the render must therefore start on the result page,
 * not here, or the worker would die with the old document.
 */
export async function startRender(spec: RenderSpec): Promise<RenderJob> {
  return renderQueue.enqueue(spec);
}

/** Pumps the oldest queued job from the page that now owns it. */
export async function resumeRender(job: RenderJob): Promise<void> {
  if (renderQueue.isBusy()) return;
  // A render outlives the click that started it; the result page polls the
  // store for progress rather than holding this promise.
  const finished = await renderQueue.runNext(rendererFor(job.spec));
  // The history lives here, in the web layer that owns IndexedDB, not in the
  // platform-agnostic queue. A render that did not finish is not a video the
  // user can watch again, so only a `done` job is kept.
  if (finished?.status !== 'done' || !finished.result) return;
  await addToHistory({
    id: finished.id,
    createdAt: finished.createdAt,
    size: finished.result.blob.size,
    video: finished.result,
  });
}

/** A job still `running` after a restart is interrupted, not half-finished. */
export async function recoverQueue(): Promise<void> {
  await renderQueue.recover();
}
