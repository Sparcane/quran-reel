import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STUDIO_SETTINGS } from '../src/lib/studio-settings';
import { openStudioDatabase, resetStudioStorage, STUDIO_DRAFT_STORE_NAME } from '../src/lib/storage';
import { deleteDraft, listDrafts, loadDraft, saveDraft } from '../src/lib/drafts';

const settings = { ...DEFAULT_STUDIO_SETTINGS, arabicSize: 72 };

beforeEach(async () => {
  resetStudioStorage();
  // fake-indexeddb keeps the database for the whole file, so each test starts
  // from an empty store rather than from the previous test's drafts.
  const db = await openStudioDatabase();
  await db.clear(STUDIO_DRAFT_STORE_NAME);
});

describe('drafts', () => {
  it('saves a draft and lists it back', async () => {
    const id = await saveDraft({
      name: 'Yassin',
      selection: [{ surah: 36, verse: 1 }],
      settings,
    });

    const [draft] = await listDrafts();
    expect(draft.id).toBe(id);
    expect(draft.name).toBe('Yassin');
    expect(draft.selection).toEqual([{ surah: 36, verse: 1 }]);
    expect(draft.settings.arabicSize).toBe(72);
    expect(draft.updatedAt).toBeGreaterThan(0);
  });

  it('updates a saved draft instead of creating a duplicate', async () => {
    const id = await saveDraft({
      name: 'Yassin',
      selection: [{ surah: 36, verse: 1 }],
      settings,
    });

    await saveDraft({
      id,
      name: 'Yassin 2',
      selection: [
        { surah: 36, verse: 1 },
        { surah: 36, verse: 2 },
      ],
      settings,
    });

    const drafts = await listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].name).toBe('Yassin 2');
    expect(drafts[0].selection).toHaveLength(2);
  });

  it('lists the most recently saved draft first', async () => {
    const first = await saveDraft({ name: 'Premier', selection: [], settings });
    const second = await saveDraft({ name: 'Second', selection: [], settings });

    const drafts = await listDrafts();
    expect(drafts.map((draft) => draft.id)).toEqual([second, first]);
  });

  it('loads one draft by id, and nothing for an unknown id', async () => {
    const id = await saveDraft({ name: 'Kahf', selection: [{ surah: 18, verse: 1 }], settings });

    expect((await loadDraft(id))?.name).toBe('Kahf');
    expect(await loadDraft('missing')).toBeNull();
  });

  it('deletes a draft', async () => {
    const id = await saveDraft({ name: 'Kahf', selection: [], settings });

    await deleteDraft(id);

    expect(await listDrafts()).toHaveLength(0);
    expect(await loadDraft(id)).toBeNull();
  });

  it('clamps the settings of a record written by an older build', async () => {
    const db = await openStudioDatabase();
    await db.put(
      STUDIO_DRAFT_STORE_NAME,
      {
        id: 'old',
        name: 'Ancien',
        updatedAt: 1_700_000_000_000,
        selection: [{ surah: 2, verse: 255 }],
        settings: { arabicSize: 999, aspectRatio: '21:9', overlayOpacity: 95 },
      },
      'old',
    );

    const draft = await loadDraft('old');

    expect(draft?.settings.arabicSize).toBe(120);
    expect(draft?.settings.aspectRatio).toBe(DEFAULT_STUDIO_SETTINGS.aspectRatio);
    expect(draft?.settings.overlayOpacity).toBe(90);
    expect(draft?.settings.reciterId).toBe(DEFAULT_STUDIO_SETTINGS.reciterId);
  });

  it('skips a corrupted record instead of failing the whole list', async () => {
    await saveDraft({ name: 'Bon', selection: [], settings });
    const db = await openStudioDatabase();
    await db.put(
      STUDIO_DRAFT_STORE_NAME,
      { id: 'bad', name: 'Cassé', updatedAt: 1, selection: [{ surah: 999, verse: 1 }] },
      'bad',
    );

    const drafts = await listDrafts();

    expect(drafts.map((draft) => draft.name)).toEqual(['Bon']);
  });

  it('refuses a draft without a name', async () => {
    await expect(saveDraft({ name: '   ', selection: [], settings })).rejects.toThrow(/name/i);
  });

  it('keeps working when the browser blocks IndexedDB', async () => {
    resetStudioStorage();
    const blocked = globalThis.indexedDB;
    // @ts-expect-error - simulating Safari private mode, where the API is absent.
    delete globalThis.indexedDB;

    try {
      const id = await saveDraft({ name: 'Sans base', selection: [], settings });
      expect((await listDrafts()).map((draft) => draft.id)).toEqual([id]);
      expect((await loadDraft(id))?.name).toBe('Sans base');
      await deleteDraft(id);
      expect(await listDrafts()).toHaveLength(0);
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: blocked,
        configurable: true,
        writable: true,
      });
      resetStudioStorage();
    }
  });
});
