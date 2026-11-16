import catalogue from '../../public/data/reciters.json';
import type { Reciter } from '@quran/core';

/**
 * The shipped reciter catalogue. It is imported (not fetched from `/data`) so
 * that the studio can name a reciter while offline, straight from the bundle.
 */
export const RECITERS: readonly Reciter[] = catalogue as Reciter[];

/** Returns the reciter, or throws: a silent fallback would record the wrong voice. */
export function reciterById(id: string): Reciter {
  const reciter = RECITERS.find((candidate) => candidate.id === id);
  if (!reciter) {
    throw new Error(`reciters: unknown reciter ${JSON.stringify(id)}`);
  }
  return reciter;
}
