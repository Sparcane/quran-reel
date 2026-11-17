/**
 * The persistent render queue.
 *
 * A render can take minutes, so the studio stores every job before it starts.
 * Only one runs at a time; the rest wait in FIFO order. Persistence is a seam:
 * this module never imports IndexedDB, so the same queue runs in a test with a
 * memory store and in the app with the device store. Because a fragmented MP4
 * cannot be resumed mid-encode, a job found `running` after a restart is marked
 * `failed` — the UI offers to relaunch it from the beginning.
 */

import { RenderCancelledError, type VideoRenderer } from './worker';
import type { RenderedVideo, RenderSpec } from './types';

export type RenderJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** One render, from the spec that produced it to the video it became. */
export interface RenderJob {
  id: string;
  spec: RenderSpec;
  status: RenderJobStatus;
  /** Last reported percent, 0–100. */
  progress: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Present once the job is done. */
  result?: RenderedVideo;
}

/** The persistence seam. A store keeps jobs keyed by id. */
export interface JobStore {
  get(id: string): Promise<RenderJob | null>;
  list(): Promise<RenderJob[]>;
  put(job: RenderJob): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface QueueOptions {
  newId?(): string;
  now?(): number;
}

export interface RenderQueue {
  /** Stores a spec as a queued job and returns it. */
  enqueue(spec: RenderSpec): Promise<RenderJob>;
  /**
   * Runs the oldest queued job with `renderer`, persisting progress as it goes.
   * Returns the finished job, or `null` when nothing was queued (or a job is
   * already running).
   */
  runNext(renderer: VideoRenderer): Promise<RenderJob | null>;
  cancelJob(id: string): Promise<void>;
  listJobs(): Promise<RenderJob[]>;
  getJob(id: string): Promise<RenderJob | null>;
  /** Marks jobs left `running` by a previous session as interrupted. */
  recover(): Promise<void>;
  isBusy(): boolean;
}

const INTERRUPTED =
  'Rendu interrompu : l’onglet a été fermé. Relancez le rendu depuis le début.';

function newJobId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A store that lives for the session. Returned copies are shallow so a caller
 * mutating a job cannot quietly change what the store holds; the spec and the
 * result are shared because they are large and never mutated in place.
 */
export function createMemoryJobStore(): JobStore {
  const jobs = new Map<string, RenderJob>();
  return {
    async get(id) {
      const job = jobs.get(id);
      return job ? { ...job } : null;
    },
    async list() {
      return [...jobs.values()].map((job) => ({ ...job }));
    },
    async put(job) {
      jobs.set(job.id, { ...job });
    },
    async delete(id) {
      jobs.delete(id);
    },
  };
}

/** Oldest first, with the id as a stable tiebreaker for equal timestamps. */
function byAge(a: RenderJob, b: RenderJob): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

export function createQueue(store: JobStore, options: QueueOptions = {}): RenderQueue {
  const now = options.now ?? (() => Date.now());
  const makeId = options.newId ?? newJobId;

  let busy = false;
  let active: { id: string; cancel(): void } | null = null;

  /** Writes the terminal state unless a cancellation already won the race. */
  async function settle(
    known: RenderJob,
    patch: Pick<RenderJob, 'status' | 'progress'> & Partial<RenderJob>,
  ): Promise<RenderJob> {
    const current = await store.get(known.id);
    const job = current ?? known;
    if (job.status === 'cancelled') return job;
    const finished: RenderJob = { ...job, ...patch, finishedAt: now() };
    await store.put(finished);
    return finished;
  }

  return {
    async enqueue(spec) {
      const job: RenderJob = {
        id: makeId(),
        spec,
        status: 'queued',
        progress: 0,
        createdAt: now(),
      };
      await store.put(job);
      return job;
    },

    async runNext(renderer) {
      // Set synchronously, before the first await, so a second call made in the
      // same tick cannot start a concurrent render.
      if (busy) return null;
      busy = true;

      try {
        const jobs = await store.list();
        const next = jobs.filter((job) => job.status === 'queued').sort(byAge)[0];
        if (!next) return null;

        const running: RenderJob = {
          ...next,
          status: 'running',
          startedAt: now(),
        };
        await store.put(running);
        active = { id: running.id, cancel: () => renderer.cancel() };

        let lastProgress = running.progress;
        try {
          const result = await renderer.render(running.spec, (progress) => {
            if (!Number.isFinite(progress.percent) || progress.percent <= lastProgress) return;
            lastProgress = progress.percent;
            // Progress is best-effort: a lost update costs a stale percentage,
            // never the render itself.
            void store.put({ ...running, progress: progress.percent });
          });
          return await settle(running, {
            status: 'done',
            progress: 100,
            result,
          });
        } catch (error) {
          const current = await store.get(running.id);
          if (current?.status === 'cancelled' || error instanceof RenderCancelledError) {
            return await settle(running, {
              status: 'cancelled',
              progress: current?.progress ?? lastProgress,
            });
          }
          return await settle(running, {
            status: 'failed',
            progress: lastProgress,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          active = null;
        }
      } finally {
        busy = false;
      }
    },

    async cancelJob(id) {
      const job = await store.get(id);
      if (!job) return;
      if (job.status !== 'queued' && job.status !== 'running') return;

      // Write the terminal state first so the renderer's own rejection sees a
      // job that is already cancelled and cannot overwrite it with `done`.
      await store.put({ ...job, status: 'cancelled', finishedAt: now() });
      if (job.status === 'running' && active?.id === id) active.cancel();
    },

    async listJobs() {
      return (await store.list()).sort(byAge);
    },

    async getJob(id) {
      return store.get(id);
    },

    async recover() {
      const jobs = await store.list();
      for (const job of jobs) {
        if (job.status !== 'running') continue;
        // A job rendering in THIS queue is alive, not left behind by a closed
        // tab. The result page calls recover() on mount, including straight
        // after a render it just started; marking that job interrupted would
        // kill it and the download link would never appear.
        if (active?.id === job.id) continue;
        await store.put({
          ...job,
          status: 'failed',
          error: INTERRUPTED,
          finishedAt: now(),
        });
      }
    },

    isBusy() {
      return busy;
    },
  };
}
