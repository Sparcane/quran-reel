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
/** v2 added `assets`, v3 `drafts`, v4 the render `jobs` queue; older databases upgrade in place. */
export const STUDIO_DB_VERSION = 4;
export const STUDIO_STORE_NAME = 'state';
export const STUDIO_ASSET_STORE_NAME = 'assets';
export const STUDIO_DRAFT_STORE_NAME = 'drafts';
export const STUDIO_JOB_STORE_NAME = 'jobs';

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

/**
 * One connection per tab, shared by the studio draft, the imported assets and
 * the saved drafts. Exported so `drafts.ts` does not redeclare the database
 * name and version (two copies would drift apart at the next schema change).
 */
export function openStudioDatabase(): Promise<IDBPDatabase<unknown>> {
  if (dbPromise === null) {
    dbPromise = openDB(STUDIO_DB_NAME, STUDIO_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STUDIO_STORE_NAME)) {
          db.createObjectStore(STUDIO_STORE_NAME);
        }
        if (!db.objectStoreNames.contains(STUDIO_ASSET_STORE_NAME)) {
          db.createObjectStore(STUDIO_ASSET_STORE_NAME);
        }
        if (!db.objectStoreNames.contains(STUDIO_DRAFT_STORE_NAME)) {
          db.createObjectStore(STUDIO_DRAFT_STORE_NAME);
        }
        if (!db.objectStoreNames.contains(STUDIO_JOB_STORE_NAME)) {
          db.createObjectStore(STUDIO_JOB_STORE_NAME);
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
      const db = await openStudioDatabase();
      const value: unknown = await db.get(STUDIO_STORE_NAME, name);
      return typeof value === 'string' ? value : null;
    },
    async setItem(name, value) {
      const db = await openStudioDatabase();
      await db.put(STUDIO_STORE_NAME, value, name);
    },
    async removeItem(name) {
      const db = await openStudioDatabase();
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
  memoryAssets.clear();
}

/** A picture or a video the user imported, kept as bytes on the device. */
export interface BackgroundAsset {
  id: string;
  name: string;
  mime: string;
  blob: Blob;
  savedAt: number;
}

/**
 * The record actually written to IndexedDB. The bytes are stored as an
 * `ArrayBuffer` rather than a `Blob`: the structured-clone implementations of
 * older WebViews (and of the test's IndexedDB) do not always carry a `Blob`
 * across, and a background that comes back empty is worse than one extra copy
 * on the way in.
 */
interface StoredAsset {
  id: string;
  name: string;
  mime: string;
  bytes: ArrayBuffer;
  savedAt: number;
}

function toAsset(record: StoredAsset): BackgroundAsset {
  return {
    id: record.id,
    name: record.name,
    mime: record.mime,
    blob: new Blob([record.bytes], { type: record.mime }),
    savedAt: record.savedAt,
  };
}

/**
 * Assets for environments without a working IndexedDB. A background is shown
 * for the length of one session rather than refusing the import outright.
 */
const memoryAssets = new Map<string, StoredAsset>();

function newAssetId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  return `asset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Stores the imported file and returns its id. The settings only ever hold the
 * id, so the draft stays small and the file never leaves the device.
 */
export async function saveBackgroundAsset(file: Blob, name: string): Promise<string> {
  const asset: StoredAsset = {
    id: newAssetId(),
    name,
    mime: file.type,
    bytes: await file.arrayBuffer(),
    savedAt: Date.now(),
  };

  try {
    const db = await openStudioDatabase();
    await db.put(STUDIO_ASSET_STORE_NAME, asset, asset.id);
  } catch {
    memoryAssets.set(asset.id, asset);
  }
  return asset.id;
}

/** Reads an imported file back, or null when it was removed or never saved. */
export async function loadBackgroundAsset(id: string): Promise<BackgroundAsset | null> {
  try {
    const db = await openStudioDatabase();
    const asset = (await db.get(STUDIO_ASSET_STORE_NAME, id)) as StoredAsset | undefined;
    if (asset) return toAsset(asset);
  } catch {
    // Fall through to the session copy.
  }
  const asset = memoryAssets.get(id);
  return asset ? toAsset(asset) : null;
}

/** Removes an imported file once no draft refers to it. */
export async function deleteBackgroundAsset(id: string): Promise<void> {
  memoryAssets.delete(id);
  try {
    const db = await openStudioDatabase();
    await db.delete(STUDIO_ASSET_STORE_NAME, id);
  } catch {
    // Nothing else to clean up: the device copy was never written.
  }
}
