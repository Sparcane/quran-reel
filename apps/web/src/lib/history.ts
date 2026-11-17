/**
 * The finished-video history and its retention rule.
 *
 * A 15-minute render is hundreds of megabytes, so the app keeps only the three
 * newest by default. Each entry owns its blob: deleting an entry deletes the
 * bytes too. Persistence is a seam — the pure retention logic takes a
 * `HistoryStore`, so the quota path is testable without a real device.
 */

import { StorageQuotaError, type RenderedVideo } from '@quran/render';
import { openStudioDatabase, STUDIO_HISTORY_STORE_NAME } from '@/lib/storage';

/** How many finished videos stay on the device unless the caller says otherwise. */
export const DEFAULT_HISTORY_LIMIT = 3;

/** One finished video, with the metadata needed to show it in a list. */
export interface HistoryEntry {
  id: string;
  createdAt: number;
  /** Blob size in bytes, kept so the UI can warn about storage. */
  size: number;
  video: RenderedVideo;
}

export interface HistoryStore {
  list(): Promise<HistoryEntry[]>;
  put(entry: HistoryEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface HistoryOptions {
  store?: HistoryStore;
  /** Retention limit used after a write; defaults to three. */
  max?: number;
}

/** A store that lives for the session, used where IndexedDB is unavailable. */
export function createMemoryHistoryStore(): HistoryStore {
  const entries = new Map<string, HistoryEntry>();
  return {
    async list() {
      return [...entries.values()].map((entry) => ({ ...entry }));
    },
    async put(entry) {
      entries.set(entry.id, { ...entry });
    },
    async delete(id) {
      entries.delete(id);
    },
  };
}

interface StoredHistoryEntry extends Omit<HistoryEntry, 'video'> {
  bytes: ArrayBuffer;
  mime: string;
  durationSec: number;
  width: number;
  height: number;
  container: RenderedVideo['container'];
  videoCodec: string;
}

async function toStored(entry: HistoryEntry): Promise<StoredHistoryEntry> {
  const { video, ...rest } = entry;
  return {
    ...rest,
    bytes: await video.blob.arrayBuffer(),
    mime: video.blob.type,
    durationSec: video.durationSec,
    width: video.width,
    height: video.height,
    container: video.container,
    videoCodec: video.videoCodec,
  };
}

function fromStored(record: StoredHistoryEntry): HistoryEntry {
  const { bytes, mime, durationSec, width, height, container, videoCodec, ...rest } = record;
  return {
    ...rest,
    video: {
      blob: new Blob([bytes], { type: mime }),
      durationSec,
      width,
      height,
      container,
      videoCodec,
    },
  };
}

function isQuotaError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'QuotaExceededError'
  );
}

/** Entries kept for the session when the device database fails. */
const memoryHistory = new Map<string, StoredHistoryEntry>();

/**
 * The store the app uses. A quota failure is translated into `StorageQuotaError`
 * so `addToHistory` can react to it; other failures fall back to memory rather
 * than losing the video the user just made.
 */
function deviceStore(): HistoryStore {
  return {
    async list() {
      if (typeof indexedDB !== 'undefined') {
        try {
          const db = await openStudioDatabase();
          const records = (await db.getAll(STUDIO_HISTORY_STORE_NAME)) as StoredHistoryEntry[];
          return records.map(fromStored);
        } catch {
          // Fall through to the session copy.
        }
      }
      return [...memoryHistory.values()].map(fromStored);
    },

    async put(entry) {
      const record = await toStored(entry);
      memoryHistory.delete(record.id);
      if (typeof indexedDB !== 'undefined') {
        try {
          const db = await openStudioDatabase();
          await db.put(STUDIO_HISTORY_STORE_NAME, record, record.id);
          return;
        } catch (error) {
          if (isQuotaError(error)) throw new StorageQuotaError(undefined, { cause: error });
          // Fall through: keeping this render for the session is better than
          // reporting success and losing it.
        }
      }
      memoryHistory.set(record.id, record);
    },

    async delete(id) {
      memoryHistory.delete(id);
      if (typeof indexedDB === 'undefined') return;
      try {
        const db = await openStudioDatabase();
        await db.delete(STUDIO_HISTORY_STORE_NAME, id);
      } catch {
        // Nothing else to clean up.
      }
    },
  };
}

/** Newest first; the id breaks ties so equal timestamps stay deterministic. */
function newestFirst(a: HistoryEntry, b: HistoryEntry): number {
  return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
}

function oldestFirst(a: HistoryEntry, b: HistoryEntry): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

export async function listHistory(options: HistoryOptions = {}): Promise<HistoryEntry[]> {
  const store = options.store ?? deviceStore();
  return (await store.list()).sort(newestFirst);
}

/** Trims a store that already holds more than `max` entries. */
export async function enforceRetention(
  max: number = DEFAULT_HISTORY_LIMIT,
  options: Pick<HistoryOptions, 'store'> = {},
): Promise<void> {
  const store = options.store ?? deviceStore();
  const entries = (await store.list()).sort(newestFirst);
  for (const old of entries.slice(Math.max(0, max))) {
    await store.delete(old.id);
  }
}

/**
 * Stores a finished video and enforces retention. A full device triggers one
 * purge of the oldest entry and one retry; a second failure is surfaced to the
 * caller instead of being swallowed.
 */
export async function addToHistory(entry: HistoryEntry, options: HistoryOptions = {}): Promise<void> {
  const store = options.store ?? deviceStore();
  try {
    await store.put(entry);
  } catch (error) {
    if (!(error instanceof StorageQuotaError)) throw error;
    const oldest = (await store.list()).sort(oldestFirst).find((item) => item.id !== entry.id);
    if (oldest) await store.delete(oldest.id);
    await store.put(entry);
  }
  await enforceRetention(options.max ?? DEFAULT_HISTORY_LIMIT, { store });
}

/** Removes an entry and its video bytes together. */
export async function deleteFromHistory(
  id: string,
  options: Pick<HistoryOptions, 'store'> = {},
): Promise<void> {
  const store = options.store ?? deviceStore();
  await store.delete(id);
}

/** The store used by the app, exported for the history view. */
export const historyStore: HistoryStore = {
  list: () => deviceStore().list(),
  put: (entry) => deviceStore().put(entry),
  delete: (id) => deviceStore().delete(id),
};
