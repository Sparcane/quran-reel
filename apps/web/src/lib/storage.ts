import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { StateStorage } from 'zustand/middleware';
import type { VerseRef } from '@quran/core';
import {
  DEFAULT_STUDIO_SETTINGS,
  clampStudioSettings,
  type StudioSettings,
} from '@/lib/studio-settings';
import { toSelection } from '@/lib/verses';

/** IndexedDB database that holds the studio's own records. */
export const STUDIO_DB_NAME = 'quran-studio';
export const STUDIO_DB_VERSION = 1;
export const STUDIO_STORE_NAME = 'state';

/** Key under which the studio draft lives in that database. */
export const STUDIO_STORAGE_KEY = 'studio';

/** Schema version of the persisted draft itself, not of the database. */
export const STUDIO_STATE_VERSION = 1;

/** The part of the store that outlives the tab. */
export interface PersistedStudio {
  selection: VerseRef[];
  settings: StudioSettings;
}

/**
 * Storage for environments without IndexedDB (private mode, an old WebView).
 * A video draft is small, so losing it at the end of the session is a far
 * better outcome than a studio that cannot save at all.
 */
export function createMemoryStorage(): StateStorage {
  const values = new Map<string, string>();
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
}

let dbPromise: Promise<IDBPDatabase<unknown>> | null = null;

function studioDb(): Promise<IDBPDatabase<unknown>> {
  if (dbPromise === null) {
    dbPromise = openDB(STUDIO_DB_NAME, STUDIO_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STUDIO_STORE_NAME)) {
          db.createObjectStore(STUDIO_STORE_NAME);
        }
      },
    }).catch((error: unknown) => {
      // Never cache a failed open: the next write retries (and then falls back).
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function createIdbStorage(): StateStorage {
  return {
    async getItem(name) {
      const db = await studioDb();
      const value: unknown = await db.get(STUDIO_STORE_NAME, name);
      return typeof value === 'string' ? value : null;
    },
    async setItem(name, value) {
      const db = await studioDb();
      await db.put(STUDIO_STORE_NAME, value, name);
    },
    async removeItem(name) {
      const db = await studioDb();
      await db.delete(STUDIO_STORE_NAME, name);
    },
  };
}

function withFallback(primary: StateStorage, fallback: StateStorage): StateStorage {
  return {
    async getItem(name) {
      try {
        return await primary.getItem(name);
      } catch {
        return fallback.getItem(name);
      }
    },
    async setItem(name, value) {
      try {
        await primary.setItem(name, value);
      } catch {
        await fallback.setItem(name, value);
      }
    },
    async removeItem(name) {
      try {
        await primary.removeItem(name);
      } catch {
        await fallback.removeItem(name);
      }
    },
  };
}

let backend: StateStorage | null = null;

function stateBackend(): StateStorage {
  if (backend === null) {
    backend =
      typeof indexedDB === 'undefined'
        ? createMemoryStorage()
        : withFallback(createIdbStorage(), createMemoryStorage());
  }
  return backend;
}

/**
 * The last payload handed to storage, kept in memory so that
 * `loadPersistedStudio` can answer synchronously (a device read is async) and
 * so that the very first paint can show the draft without waiting.
 */
let mirror: string | null = null;
let lastWrite: Promise<void> = Promise.resolve();

function track(write: Promise<unknown>): void {
  lastWrite = Promise.resolve(write).then(
    () => undefined,
    () => undefined,
  );
}

/** Zustand's adapter: it stores one JSON string per key. */
export const studioStateStorage: StateStorage = {
  async getItem(name) {
    const raw = await stateBackend().getItem(name);
    if (typeof raw === 'string') mirror = raw;
    return raw ?? null;
  },
  setItem(name, value) {
    mirror = value;
    const write = stateBackend().setItem(name, value);
    track(Promise.resolve(write));
    return write;
  },
  removeItem(name) {
    mirror = null;
    const write = stateBackend().removeItem(name);
    track(Promise.resolve(write));
    return write;
  },
};

/** Resolves once every write started so far has reached the device. */
export async function flushStudioWrites(): Promise<void> {
  let current = lastWrite;
  await current;
  while (current !== lastWrite) {
    current = lastWrite;
    await current;
  }
}

function emptyStudio(): PersistedStudio {
  return { selection: [], settings: DEFAULT_STUDIO_SETTINGS };
}

/**
 * Reads a draft of any schema version and returns settings the renderer can
 * use. A v0 draft (before backgrounds and subtitle modes existed) is completed
 * with today's defaults instead of being rejected: losing the user's verses to
 * a schema change would be the worse failure.
 */
export function migrateStudioState(state: unknown): PersistedStudio {
  const record = (typeof state === 'object' && state !== null ? state : {}) as {
    selection?: unknown;
    settings?: unknown;
  };

  let selection: VerseRef[] = [];
  if (Array.isArray(record.selection)) {
    try {
      selection = toSelection(record.selection as VerseRef[]);
    } catch {
      // A reference that cannot exist is dropped with the rest of the draft
      // rather than shipped to the renderer.
      selection = [];
    }
  }

  const settings =
    typeof record.settings === 'object' && record.settings !== null
      ? clampStudioSettings(record.settings as Partial<StudioSettings>)
      : DEFAULT_STUDIO_SETTINGS;

  return { selection, settings };
}

/** The draft as it was last written, or the defaults. Synchronous by design. */
export function loadPersistedStudio(): PersistedStudio {
  if (mirror === null) return emptyStudio();
  try {
    const envelope = JSON.parse(mirror) as { state?: unknown };
    return migrateStudioState(envelope.state);
  } catch {
    return emptyStudio();
  }
}

/**
 * Forgets the cached database and mirror. Used by tests and after an app-wide
 * reset; the data on the device is untouched.
 */
export function resetStudioStorage(): void {
  backend = null;
  dbPromise = null;
  mirror = null;
  lastWrite = Promise.resolve();
}
