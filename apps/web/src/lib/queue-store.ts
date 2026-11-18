/**
 * Device storage for the render queue.
 *
 * The queue itself (`@quran/render`) knows nothing about IndexedDB; this module
 * is its `JobStore` on the web. A `RenderSpec` holds a live painter with methods,
 * which structured clone cannot store, so the record keeps the plain
 * `backgroundSelection` instead and rebuilds a painter when the queue reads a
 * job to render it. Done jobs carry a video blob, stored as bytes for the same
 * reason imported backgrounds are. Without IndexedDB the jobs live for the
 * session only.
 */

import type { BackgroundSelection, GradientSelection } from '@quran/core';
import {
  createGradientPainter,
  deserialiseAudio,
  fromStoredVideo,
  serialiseAudio,
  toStoredVideo,
  type StoredVideo,
} from '@quran/render';
import type { JobStore, RenderedVideo, RenderJob, RenderSpec, WireVerseClip } from '@quran/render';
import {
  createImportedBackground,
  ensureImportedAsset,
  type ImportedSelection,
} from '@/lib/background-painter';
import { openStudioDatabase, STUDIO_JOB_STORE_NAME } from '@/lib/storage';

const DEFAULT_BACKGROUND: GradientSelection = {
  kind: 'gradient',
  from: '#0b1026',
  to: '#1e3a5f',
  angle: 135,
  motion: true,
};

/** Audio loses its method on the way to IndexedDB, just as it does in a worker. */
type StoredSpec = Omit<RenderSpec, 'background' | 'verses'> & { verses: WireVerseClip[] };

interface StoredJob {
  id: string;
  spec: StoredSpec;
  status: RenderJob['status'];
  progress: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: StoredVideo;
}

async function toStored(job: RenderJob): Promise<StoredJob> {
  const { background: _painter, verses, ...rest } = job.spec;
  void _painter;
  const spec: StoredSpec = {
    ...rest,
    verses: verses.map((verse) => ({ ...verse, audio: serialiseAudio(verse.audio) })),
  };

  return {
    id: job.id,
    spec,
    status: job.status,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result ? await toStoredVideo(job.result) : undefined,
  };
}

async function fromStored(record: StoredJob, forRender = false): Promise<RenderJob> {
  const selection: BackgroundSelection = record.spec.backgroundSelection ?? DEFAULT_BACKGROUND;
  const size = { width: record.spec.width, height: record.spec.height };
  // Only a queued job is going to paint: a finished one is displayed from its
  // stored bytes, so loading a device asset for it would only cost I/O — and
  // would break displaying results the user deleted the background since.
  const imported = selection.kind !== 'gradient' && record.status === 'queued';
  const gradient: GradientSelection = selection.kind === 'gradient' ? selection : DEFAULT_BACKGROUND;
  let background = createGradientPainter(gradient, size);
  if (imported) {
    try {
      // The result page polls get() every 500 ms; only the queue's own read
      // (list, right before a render) may pay the demux and the decode. Every
      // other read pays only this cheap existence check.
      await ensureImportedAsset(selection as ImportedSelection);
      if (forRender) {
        // The timeline carries the lead-in; without one, the verse durations
        // are the honest floor for how long the looped source must cover.
        const durationSec =
          record.spec.timeline?.totalSec ??
          record.spec.verses.reduce((total, verse) => total + (verse.durationSec ?? 0), 0);
        background = await createImportedBackground(
          selection as ImportedSelection,
          size,
          durationSec,
        );
      }
    } catch (error) {
      // A missing asset must not turn into the default gradient: that would
      // render a video that silently contradicts the user's choice. The job is
      // shown and stored failed; its spec cannot be repaired here (the
      // re-import creates a new asset id), so the result page offers no
      // Relancer for this error — the user re-imports in the studio.
      return persistFailure(record, error instanceof Error ? error.message : String(error));
    }
  }

  const result: RenderedVideo | undefined = record.result
    ? fromStoredVideo(record.result)
    : undefined;

  return {
    id: record.id,
    spec: {
      ...record.spec,
      background,
      verses: record.spec.verses.map((verse) => ({
        ...verse,
        audio: deserialiseAudio(verse.audio),
      })),
    },
    status: record.status,
    progress: record.progress,
    error: record.error,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    result,
  };
}

/** Stores a failed job so later reads see the failure instead of re-testing it. */
async function persistFailure(record: StoredJob, message: string): Promise<RenderJob> {
  const failed: StoredJob = {
    ...record,
    status: 'failed',
    error: message,
    finishedAt: record.finishedAt ?? Date.now(),
  };
  memoryJobs.set(failed.id, failed);
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openStudioDatabase();
      await db.put(STUDIO_JOB_STORE_NAME, failed, failed.id);
      // The device now holds the failure; a second copy would only be a way to
      // resurrect the old status if a later write fails.
      memoryJobs.delete(failed.id);
    } catch {
      // The session copy already carries the failure.
    }
  }
  return fromStored(failed);
}

/** Jobs kept for the session when the device has no usable IndexedDB. */
const memoryJobs = new Map<string, StoredJob>();

async function read(id: string): Promise<StoredJob | null> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openStudioDatabase();
      const record = (await db.get(STUDIO_JOB_STORE_NAME, id)) as StoredJob | undefined;
      if (record) return record;
    } catch {
      // Fall through to the session copy.
    }
  }
  return memoryJobs.get(id) ?? null;
}

async function readAll(): Promise<StoredJob[]> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openStudioDatabase();
      const records = (await db.getAll(STUDIO_JOB_STORE_NAME)) as StoredJob[];
      // A write that did not fit on the device fell back to the session copy.
      // Returning the database alone would hide that job from the queue, and
      // the result page would wait forever on a render nothing picks up.
      const stored = new Set(records.map((record) => record.id));
      return [...records, ...[...memoryJobs.values()].filter((record) => !stored.has(record.id))];
    } catch {
      // Fall through to the session copy.
    }
  }
  return [...memoryJobs.values()];
}

export function createQueueStore(): JobStore {
  return {
    async get(id) {
      const record = await read(id);
      return record ? fromStored(record) : null;
    },

    async list() {
      // The queue reads jobs to render them: this is the only read allowed to
      // rebuild an imported painter (and pay the decode).
      const records = await readAll();
      return Promise.all(records.map((record) => fromStored(record, true)));
    },

    async put(job) {
      const record = await toStored(job);
      memoryJobs.delete(record.id);
      if (typeof indexedDB !== 'undefined') {
        try {
          const db = await openStudioDatabase();
          await db.put(STUDIO_JOB_STORE_NAME, record, record.id);
          return;
        } catch {
          // Fall through to the session copy.
        }
      }
      memoryJobs.set(record.id, record);
    },

    async delete(id) {
      memoryJobs.delete(id);
      if (typeof indexedDB === 'undefined') return;
      try {
        const db = await openStudioDatabase();
        await db.delete(STUDIO_JOB_STORE_NAME, id);
      } catch {
        // Nothing on the device; the session copy is already gone.
      }
    },
  };
}

/** The store the app uses. Created once so all callers share the session copy. */
export const jobStore: JobStore = createQueueStore();

/** For tests and app-wide resets; device data is untouched. */
export function resetQueueStore(): void {
  memoryJobs.clear();
}
