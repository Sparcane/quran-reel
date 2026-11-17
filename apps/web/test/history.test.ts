import { beforeEach, describe, expect, it } from 'vitest';
import { StorageQuotaError, type RenderedVideo } from '@quran/render';
import {
  addToHistory,
  createMemoryHistoryStore,
  deleteFromHistory,
  enforceRetention,
  listHistory,
  type HistoryEntry,
  type HistoryStore,
} from '../src/lib/history';

function video(label: string): RenderedVideo {
  return {
    blob: new Blob([label], { type: 'video/mp4' }),
    durationSec: 3,
    width: 1080,
    height: 1920,
    container: 'mp4',
    videoCodec: 'avc1',
  };
}

function entry(id: string, createdAt: number): HistoryEntry {
  const rendered = video(id);
  return { id, createdAt, size: rendered.blob.size, video: rendered };
}

/** Wraps a store with a quota failure and records every deletion. */
function failingStore(
  inner: HistoryStore,
  failures: number,
): HistoryStore & { deleted: string[] } {
  let remaining = failures;
  const deleted: string[] = [];
  return {
    deleted,
    async list() {
      return inner.list();
    },
    async put(value) {
      if (remaining-- > 0) throw new StorageQuotaError();
      return inner.put(value);
    },
    async delete(id) {
      deleted.push(id);
      return inner.delete(id);
    },
  };
}

let store: HistoryStore;

beforeEach(() => {
  store = createMemoryHistoryStore();
});

describe('history retention', () => {
  it('keeps only the three newest entries, in descending date order', async () => {
    for (let i = 0; i < 5; i += 1) {
      await addToHistory(entry(`v${i}`, i), { store });
    }

    expect((await listHistory({ store })).map((item) => item.id)).toEqual(['v4', 'v3', 'v2']);
  });

  it('deletes an entry by id', async () => {
    await addToHistory(entry('old', 1), { store });
    await addToHistory(entry('new', 2), { store });

    await deleteFromHistory('new', { store });

    expect((await listHistory({ store })).map((item) => item.id)).toEqual(['old']);
  });

  it('returns the blob and metadata untouched', async () => {
    const original = entry('clip', 10);
    await addToHistory(original, { store });

    const [found] = await listHistory({ store });

    expect(found.id).toBe('clip');
    expect(found.createdAt).toBe(10);
    expect(found.size).toBe(original.video.blob.size);
    expect(found.video.durationSec).toBe(3);
    expect(found.video.width).toBe(1080);
    expect(found.video.height).toBe(1920);
    expect(found.video.container).toBe('mp4');
    expect(found.video.videoCodec).toBe('avc1');
    expect(await found.video.blob.text()).toBe('clip');
  });

  it('purges the oldest entry once, then retries a quota-blocked write', async () => {
    await addToHistory(entry('a', 1), { store });
    await addToHistory(entry('b', 2), { store });
    const failing = failingStore(store, 1);

    await addToHistory(entry('c', 3), { store: failing });

    expect(failing.deleted).toEqual(['a']);
    expect((await listHistory({ store })).map((item) => item.id)).toEqual(['c', 'b']);
  });

  it('gives up after one retry when the quota error repeats', async () => {
    await addToHistory(entry('a', 1), { store });
    const failing = failingStore(store, 5);

    await expect(addToHistory(entry('b', 2), { store: failing })).rejects.toBeInstanceOf(
      StorageQuotaError,
    );
    // One victim was freed for the retry; the second failure is surfaced and
    // the new entry was never written.
    expect(failing.deleted).toEqual(['a']);
    expect((await listHistory({ store })).map((item) => item.id)).toEqual([]);
  });

  it('does not purge for a non-quota error', async () => {
    await addToHistory(entry('a', 1), { store });
    const failing = failingStore(store, 0);
    const boom = new Error('disk exploded');
    failing.put = async () => {
      throw boom;
    };

    await expect(addToHistory(entry('b', 2), { store: failing })).rejects.toBe(boom);
    expect(failing.deleted).toEqual([]);
  });

  it('honours a custom retention limit', async () => {
    for (let i = 0; i < 4; i += 1) {
      await addToHistory(entry(`v${i}`, i), { store, max: 2 });
    }

    expect((await listHistory({ store })).map((item) => item.id)).toEqual(['v3', 'v2']);
  });

  it('enforceRetention alone trims a store that already overflowed', async () => {
    for (let i = 0; i < 5; i += 1) {
      await store.put(entry(`v${i}`, i));
    }

    await enforceRetention(3, { store });

    expect((await listHistory({ store })).map((item) => item.id)).toEqual(['v4', 'v3', 'v2']);
  });
});
