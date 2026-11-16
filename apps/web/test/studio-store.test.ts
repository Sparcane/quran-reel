import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { STUDIO_HANDOFF_KEY } from '../src/lib/verses';
import {
  DEFAULT_STUDIO_SETTINGS,
  clampStudioSettings,
} from '../src/lib/studio-settings';
import {
  STUDIO_STORAGE_KEY,
  flushStudioWrites,
  loadPersistedStudio,
  resetStudioStorage,
  studioStateStorage,
} from '../src/lib/storage';
import { adoptHandoffSelection, createStudioStore, useStudioStore } from '../src/lib/studio-store';
import type { StudioStore } from '../src/lib/studio-store';

async function reload(): Promise<StudioStore> {
  // What a page reload does: a brand-new in-memory store, reading the data the
  // previous session left on the device.
  const fresh = createStudioStore();
  await fresh.persist.rehydrate();
  return fresh;
}

beforeEach(async () => {
  resetStudioStorage();
  await studioStateStorage.removeItem(STUDIO_STORAGE_KEY);
  useStudioStore.setState({ selection: [], settings: DEFAULT_STUDIO_SETTINGS });
  sessionStorage.clear();
});

describe('studio settings', () => {
  it('starts with a usable default: vertical video, Alafasy, translated verses', () => {
    const { settings, selection } = useStudioStore.getState();

    expect(selection).toEqual([]);
    expect(settings).toEqual(DEFAULT_STUDIO_SETTINGS);
    expect(settings.aspectRatio).toBe('9:16');
    expect(settings.reciterId).toBe('alafasy');
    expect(settings.background.kind).toBe('gradient');
  });

  it('merges a patch instead of replacing every setting', () => {
    const { patchSettings } = useStudioStore.getState();

    patchSettings({ aspectRatio: '16:9' });
    patchSettings({ showTranslation: false });

    const { settings } = useStudioStore.getState();
    expect(settings.aspectRatio).toBe('16:9');
    expect(settings.showTranslation).toBe(false);
    expect(settings.arabicSize).toBe(DEFAULT_STUDIO_SETTINGS.arabicSize);
  });

  it('clamps a value the user could type but the renderer cannot use', () => {
    const { patchSettings } = useStudioStore.getState();

    patchSettings({ arabicSize: 150, translationSize: 4, overlayOpacity: 100 });
    expect(useStudioStore.getState().settings).toMatchObject({
      arabicSize: 120,
      translationSize: 16,
      overlayOpacity: 90,
    });

    patchSettings({ arabicSize: 1, translationSize: 999, overlayOpacity: -20 });
    expect(useStudioStore.getState().settings).toMatchObject({
      arabicSize: 24,
      translationSize: 72,
      overlayOpacity: 0,
    });
  });
});

describe('studio selection', () => {
  it('keeps the picked verses in reading order, without duplicates', () => {
    useStudioStore.getState().setSelection([
      { surah: 2, verse: 3 },
      { surah: 1, verse: 2 },
      { surah: 2, verse: 3 },
    ]);

    expect(useStudioStore.getState().selection).toEqual([
      { surah: 1, verse: 2 },
      { surah: 2, verse: 3 },
    ]);
  });

  it('refuses a verse reference that cannot exist', () => {
    expect(() => useStudioStore.getState().setSelection([{ surah: 115, verse: 1 }])).toThrow(
      /surah/,
    );
  });

  it('resets to an empty draft', () => {
    useStudioStore.getState().setSelection([{ surah: 2, verse: 2 }]);
    useStudioStore.getState().patchSettings({ aspectRatio: '1:1' });

    useStudioStore.getState().reset();

    expect(useStudioStore.getState().selection).toEqual([]);
    expect(useStudioStore.getState().settings).toEqual(DEFAULT_STUDIO_SETTINGS);
  });
});

describe('persistence', () => {
  it('writes the selection and the settings to the device', async () => {
    useStudioStore.getState().setSelection([{ surah: 2, verse: 2 }]);
    useStudioStore.getState().patchSettings({ aspectRatio: '9:16', arabicSize: 72 });
    await flushStudioWrites();

    expect(loadPersistedStudio().selection).toEqual([{ surah: 2, verse: 2 }]);
    expect(loadPersistedStudio().settings.aspectRatio).toBe('9:16');
    expect(loadPersistedStudio().settings.arabicSize).toBe(72);
  });

  it('comes back after a reload', async () => {
    useStudioStore.getState().setSelection([{ surah: 36, verse: 1 }]);
    useStudioStore.getState().patchSettings({ aspectRatio: '4:5', overlayOpacity: 60 });
    await flushStudioWrites();

    const { selection, settings } = (await reload()).getState();

    expect(selection).toEqual([{ surah: 36, verse: 1 }]);
    expect(settings.aspectRatio).toBe('4:5');
    expect(settings.overlayOpacity).toBe(60);
  });

  it('persists a reset, so the studio does not resurrect deleted verses', async () => {
    useStudioStore.getState().setSelection([{ surah: 2, verse: 2 }]);
    await flushStudioWrites();
    useStudioStore.getState().reset();
    await flushStudioWrites();

    expect((await reload()).getState().selection).toEqual([]);
  });

  it('reads a draft written by the previous schema, filling what it lacks', async () => {
    await studioStateStorage.setItem(
      STUDIO_STORAGE_KEY,
      JSON.stringify({
        version: 0,
        state: {
          selection: [{ surah: 1, verse: 1 }],
          settings: { aspectRatio: '16:9', arabicSize: 999, overlayOpacity: 85 },
        },
      }),
    );

    const { selection, settings } = (await reload()).getState();

    expect(selection).toEqual([{ surah: 1, verse: 1 }]);
    expect(settings.aspectRatio).toBe('16:9');
    expect(settings.overlayOpacity).toBe(85);
    // Written by an older build: clamped and completed, never trusted as-is.
    expect(settings.arabicSize).toBe(120);
    expect(settings.reciterId).toBe(DEFAULT_STUDIO_SETTINGS.reciterId);
  });

  it('returns the default draft before anything was saved', () => {
    expect(loadPersistedStudio()).toEqual({
      selection: [],
      settings: DEFAULT_STUDIO_SETTINGS,
    });
  });

  it('keeps working when the browser blocks IndexedDB', async () => {
    resetStudioStorage();
    const blocked = globalThis.indexedDB;
    // @ts-expect-error - simulating Safari private mode, where the API is absent.
    delete globalThis.indexedDB;

    try {
      await studioStateStorage.removeItem(STUDIO_STORAGE_KEY);
      useStudioStore.getState().setSelection([{ surah: 112, verse: 1 }]);
      useStudioStore.getState().patchSettings({ aspectRatio: '1:1' });
      await flushStudioWrites();

      expect(loadPersistedStudio().selection).toEqual([{ surah: 112, verse: 1 }]);
      expect(loadPersistedStudio().settings.aspectRatio).toBe('1:1');
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

describe('handoff from the reader', () => {
  it('adopts the verses the reader sent, once', async () => {
    sessionStorage.setItem(STUDIO_HANDOFF_KEY, JSON.stringify([{ surah: 2, verse: 255 }]));

    expect(adoptHandoffSelection()).toEqual([{ surah: 2, verse: 255 }]);
    expect(useStudioStore.getState().selection).toEqual([{ surah: 2, verse: 255 }]);
    expect(sessionStorage.getItem(STUDIO_HANDOFF_KEY)).toBeNull();

    // A second visit must not overwrite what the user changed since.
    useStudioStore.getState().setSelection([{ surah: 1, verse: 1 }]);
    expect(adoptHandoffSelection()).toEqual([]);
    expect(useStudioStore.getState().selection).toEqual([{ surah: 1, verse: 1 }]);
  });

  it('opens on the saved draft when the reader sent nothing', async () => {
    useStudioStore.getState().setSelection([{ surah: 3, verse: 7 }]);

    expect(adoptHandoffSelection()).toEqual([]);
    expect(useStudioStore.getState().selection).toEqual([{ surah: 3, verse: 7 }]);
  });

  it('ignores a corrupted handoff instead of crashing the studio', () => {
    sessionStorage.setItem(STUDIO_HANDOFF_KEY, '{not json');

    expect(adoptHandoffSelection()).toEqual([]);
    expect(useStudioStore.getState().selection).toEqual([]);
  });
});

describe('clampStudioSettings', () => {
  it('sanitises a payload that no current build would write', () => {
    const sanitised = clampStudioSettings({
      ...DEFAULT_STUDIO_SETTINGS,
      translationLang: 'de' as never,
      subtitleMode: 'sentence' as never,
      textColor: 'red' as never,
      background: { kind: 'gif' } as never,
    });

    expect(sanitised.translationLang).toBe('fr');
    expect(sanitised.subtitleMode).toBe('verse');
    expect(sanitised.textColor).toBe(DEFAULT_STUDIO_SETTINGS.textColor);
    expect(sanitised.background).toEqual(DEFAULT_STUDIO_SETTINGS.background);
  });

  it('rounds a fractional size to a pixel value', () => {
    expect(clampStudioSettings({ ...DEFAULT_STUDIO_SETTINGS, arabicSize: 63.6 }).arabicSize).toBe(
      64,
    );
  });
});
