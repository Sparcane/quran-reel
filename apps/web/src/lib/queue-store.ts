/**
 * Device storage for the render queue.
 *
 * The queue itself (`@quran/render`) knows nothing about IndexedDB; this module
 * is its `JobStore` on the web. A `RenderSpec` holds a live painter with methods,
 * which structured clone cannot store, so the record keeps the plain
 * `backgroundSelection` instead and rebuilds a painter when read back. Done
 * jobs carry a video blob, stored as bytes for the same reason imported
 * backgrounds are. Without IndexedDB the jobs live for the session only.
 */

import type { BackgroundSelection, GradientSelection } from '@quran/core';
import { createGradientPainter, deserialiseAudio, serialiseAudio } from '@quran/render';
import type { JobStore, RenderedVideo, RenderJob, RenderSpec, WireVerseClip } from '@quran/render';
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

interface StoredResult extends Omit<RenderedVideo, 'blob'> {
  bytes: ArrayBuffer;
  mime: string;
}

interface StoredJob {
  id: string;
  spec: StoredSpec;
  status: RenderJob['status'];
  progress: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: StoredResult;
}

async function toStored(job: RenderJob): Promise<StoredJob> {
  const { background: _painter, verses, ...rest } = job.spec;
  void _painter;
  const spec: StoredSpec = {
    ...rest,
    verses: verses.map((verse) => ({ ...verse, audio: serialiseAudio(verse.audio) })),
  };

  let result: StoredResult | undefined;
  if (job.result) {
    result = {
      durationSec: job.result.durationSec,
      width: job.result.width,
      height: job.result.height,
      container: job.result.container,
      videoCodec: job.result.videoCodec,
      bytes: await job.result.blob.arrayBuffer(),
      mime: job.result.blob.type,
    };
  }

  return {
    id: job.id,
    spec,
    status: job.status,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result,
  };
}

async function fromStored(record: StoredJob): Promise<RenderJob> {
  const selection: BackgroundSelection = record.spec.backgroundSelection ?? DEFAULT_BACKGROUND;
  // Only a gradient can be rebuilt without loading a device asset. An imported
  // background is re-created by the studio when the user relaunches a job; a
  // revived record only has to describe the job honestly until then.
  const gradient: GradientSelection = selection.kind === 'gradient' ? selection : DEFAULT_BACKGROUND;
  const background = createGradientPainter(gradient, {
    width: record.spec.width,
    height: record.spec.height,
  });

  let result: RenderedVideo | undefined;
  if (record.result) {
    result = {
      durationSec: record.result.durationSec,
      width: record.result.width,
      height: record.result.height,
      container: record.result.container,
      videoCodec: record.result.videoCodec,
      blob: new Blob([record.result.bytes], { type: record.result.mime }),
    };
  }

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
      return (await db.getAll(STUDIO_JOB_STORE_NAME)) as StoredJob[];
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
      const records = await readAll();
      return Promise.all(records.map(fromStored));
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
