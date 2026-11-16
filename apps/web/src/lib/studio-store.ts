import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { VerseRef } from '@quran/core';
import {
  DEFAULT_STUDIO_SETTINGS,
  clampStudioSettings,
  type StudioSettings,
} from '@/lib/studio-settings';
import {
  STUDIO_STATE_VERSION,
  STUDIO_STORAGE_KEY,
  migrateStudioState,
  studioStateStorage,
} from '@/lib/storage';
import { clearHandoffSelection, readHandoffSelection, toSelection } from '@/lib/verses';

export { DEFAULT_STUDIO_SETTINGS, STUDIO_BOUNDS, clampStudioSettings } from '@/lib/studio-settings';
export type { StudioSettings } from '@/lib/studio-settings';

export interface StudioState {
  /** Verses the video is being built from, in reading order. */
  selection: VerseRef[];
  settings: StudioSettings;
  setSelection: (refs: readonly VerseRef[]) => void;
  patchSettings: (patch: Partial<StudioSettings>) => void;
  reset: () => void;
}

/**
 * Builds a studio store bound to the device's storage. Exported as a factory so
 * a test can do what a reload does — a brand-new in-memory store reading the
 * same device data — without faking the storage layer.
 *
 * Every write goes through `clampStudioSettings`, so nothing unusable can be
 * persisted even if a control lets an impossible value through.
 */
export function createStudioStore() {
  return create<StudioState>()(
    persist(
      (set) => ({
        selection: [],
        settings: DEFAULT_STUDIO_SETTINGS,
        setSelection: (refs) => set({ selection: toSelection(refs) }),
        patchSettings: (patch) =>
          set((state) => ({ settings: clampStudioSettings({ ...state.settings, ...patch }) })),
        reset: () => set({ selection: [], settings: DEFAULT_STUDIO_SETTINGS }),
      }),
      {
        name: STUDIO_STORAGE_KEY,
        version: STUDIO_STATE_VERSION,
        storage: createJSONStorage(() => studioStateStorage),
        partialize: (state) => ({ selection: state.selection, settings: state.settings }),
        migrate: (persisted) => migrateStudioState(persisted),
        onRehydrateStorage: () => (state) => {
          // A record written by a newer build, or edited by hand, is bounded
          // again before a single frame is drawn from it.
          if (state) state.settings = clampStudioSettings(state.settings);
        },
      },
    ),
  );
}

export type StudioStore = ReturnType<typeof createStudioStore>;

/** The draft survives a reload, a crash and a trip to another tab. */
export const useStudioStore = createStudioStore();

/**
 * Takes the verses the reader sent through session storage and makes them the
 * draft. The reader deliberately posts them once: coming back to the studio
 * later must not silently replace the verses the user chose since.
 */
export function adoptHandoffSelection(): VerseRef[] {
  const handoff = readHandoffSelection();
  if (handoff.length === 0) return [];
  useStudioStore.getState().setSelection(handoff);
  clearHandoffSelection();
  return handoff;
}
