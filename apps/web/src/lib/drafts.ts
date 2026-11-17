import type { VerseRef } from '@quran/core';
import {
  DEFAULT_STUDIO_SETTINGS,
  clampStudioSettings,
  type StudioSettings,
} from '@/lib/studio-settings';
import { openStudioDatabase, STUDIO_DRAFT_STORE_NAME } from '@/lib/storage';
import { toSelection } from '@/lib/verses';

/** A saved project: the verses and the look, enough to pick the work back up. */
export interface Draft {
  id: string;
  name: string;
  updatedAt: number;
  selection: VerseRef[];
  settings: StudioSettings;
}

export interface DraftInput {
  /** Present when an existing draft is being overwritten. */
  id?: string;
  name: string;
  selection: readonly VerseRef[];
  settings: StudioSettings;
}

/**
 * Drafts written without a working IndexedDB live for the session. Losing a
 * named project at the end of a session is bad; refusing to save it at all is
 * worse, because the user only finds out when they come back.
 */
const memoryDrafts = new Map<string, Draft>();

/**
 * The list is ordered by `updatedAt`, and two saves inside the same
 * millisecond would otherwise tie and reorder on a whim. This keeps the stamps
 * strictly increasing in one session.
 */
let lastStamp = 0;

function nextStamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

function newDraftId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Turns a stored record into a draft the studio can open. A record with a verse
 * that cannot exist is dropped rather than partially restored: a draft is
 * either the project the user saved or it is not.
 */
function sanitiseDraft(record: unknown): Draft | null {
  if (typeof record !== 'object' || record === null) return null;
  const candidate = record as Record<string, unknown>;

  const { id, name, updatedAt, selection } = candidate;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  if (!Array.isArray(selection)) return null;

  let refs: VerseRef[];
  try {
    refs = toSelection(selection as VerseRef[]);
  } catch {
    return null;
  }

  return {
    id,
    name,
    updatedAt,
    selection: refs,
    settings:
      typeof candidate.settings === 'object' && candidate.settings !== null
        ? clampStudioSettings(candidate.settings as Partial<StudioSettings>)
        : DEFAULT_STUDIO_SETTINGS,
  };
}

async function readAll(): Promise<Draft[]> {
  if (typeof indexedDB === 'undefined') return [...memoryDrafts.values()];
  try {
    const db = await openStudioDatabase();
    const records = (await db.getAll(STUDIO_DRAFT_STORE_NAME)) as unknown[];
    return records.map(sanitiseDraft).filter((draft): draft is Draft => draft !== null);
  } catch {
    return [...memoryDrafts.values()];
  }
}

/**
 * Saves the current project, with or without an id. Returns the id so the
 * caller can keep saving to the same draft instead of piling up copies.
 */
export async function saveDraft(input: DraftInput): Promise<string> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error('drafts: a draft needs a name');
  }

  const draft: Draft = {
    id: input.id ?? newDraftId(),
    name,
    updatedAt: nextStamp(),
    selection: toSelection(input.selection),
    settings: clampStudioSettings(input.settings),
  };

  memoryDrafts.delete(draft.id);
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openStudioDatabase();
      await db.put(STUDIO_DRAFT_STORE_NAME, draft, draft.id);
      return draft.id;
    } catch {
      // Fall through to the session copy.
    }
  }
  memoryDrafts.set(draft.id, draft);
  return draft.id;
}

/** Every saved draft, newest first. Corrupted records are skipped. */
export async function listDrafts(): Promise<Draft[]> {
  const drafts = await readAll();
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadDraft(id: string): Promise<Draft | null> {
  const drafts = await listDrafts();
  return drafts.find((draft) => draft.id === id) ?? null;
}

export async function deleteDraft(id: string): Promise<void> {
  memoryDrafts.delete(id);
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openStudioDatabase();
    await db.delete(STUDIO_DRAFT_STORE_NAME, id);
  } catch {
    // Nothing on the device; the session copy is already gone.
  }
}
