import type { VerseRef } from '@quran/core';

/**
 * Height the virtualizer assumes for one verse before the row has been
 * measured. Only a starting point: real rows are measured in the browser, and
 * a long verse (2:282 is the record) then takes the room it needs.
 */
export const ROW_HEIGHT = 112;

/** Rows kept above and below the visible window while scrolling. */
export const OVERSCAN = 10;

/**
 * Ceiling on mounted verse rows. A 286-verse surah must not produce 286 rows of
 * DOM: the reader keeps at most this many, whatever the viewport.
 */
export const MAX_MOUNTED_ROWS = 60;

/** Session key the reader uses to hand its selection to the studio. */
export const STUDIO_HANDOFF_KEY = 'quran-studio:selection';

function assertRef(ref: VerseRef): void {
  if (!Number.isInteger(ref.surah) || ref.surah < 1 || ref.surah > 114) {
    throw new Error(`invalid verse reference: surah ${ref.surah} is not between 1 and 114`);
  }
  if (!Number.isInteger(ref.verse) || ref.verse < 1) {
    throw new Error(`invalid verse reference: ${ref.surah}:${ref.verse} has no verse number`);
  }
}

/**
 * Turns whatever order the user clicked in into the list the studio consumes:
 * sorted by surah then verse, without duplicates.
 *
 * It deliberately does **not** fill the gaps between two selected verses. On a
 * Quran app, adding a verse the user did not choose would be a content bug,
 * not a convenience.
 */
export function toSelection(refs: readonly VerseRef[]): VerseRef[] {
  const seen = new Set<string>();
  const selection: VerseRef[] = [];

  for (const ref of refs) {
    assertRef(ref);
    const key = `${ref.surah}:${ref.verse}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selection.push({ surah: ref.surah, verse: ref.verse });
  }

  return selection.sort((a, b) => a.surah - b.surah || a.verse - b.verse);
}

/**
 * Passes the selection to the studio across a page load. The studio store
 * (Task 10) takes over from here; until then the reader calls this before
 * navigating, so the button is never a dead end.
 */
export function handoffSelection(selection: readonly VerseRef[]): void {
  try {
    sessionStorage.setItem(STUDIO_HANDOFF_KEY, JSON.stringify(selection));
  } catch {
    // Private mode or a full quota: the studio then opens on its empty state,
    // which is still a working screen.
  }
}

/** Reads back what `handoffSelection` stored, or an empty list. */
export function readHandoffSelection(): VerseRef[] {
  try {
    const raw = sessionStorage.getItem(STUDIO_HANDOFF_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? toSelection(parsed as VerseRef[]) : [];
  } catch {
    return [];
  }
}
