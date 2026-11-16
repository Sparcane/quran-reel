import { audioUrl } from '@quran/core';
import type { VerseRef } from '@quran/core';
import { reciterById } from '@/lib/reciters';

/**
 * What the button is allowed to say. There is no "error" state on purpose: a
 * failed download rejects `load()` and the component shows the reason, while
 * the player stays `idle` — never a preview that looks like it is about to
 * play and never will.
 */
export type PreviewState = 'idle' | 'loading' | 'playing' | 'blocked';

/** The slice of `AudioBuffer` the player needs. */
export interface AudioBufferLike {
  readonly duration: number;
}

/** The slice of `AudioBufferSourceNode` the player needs. */
export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(): void;
}

/** The slice of `AudioContext` the player needs, injectable for tests. */
export interface AudioContextLike {
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  createBufferSource(): AudioBufferSourceLike;
  close?(): Promise<void>;
}

export type FetchBytes = (url: string) => Promise<ArrayBuffer>;
export type AudioContextFactory = () => AudioContextLike;

const defaultFetchBytes: FetchBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`preview: ${url} answered ${response.status}`);
  }
  return response.arrayBuffer();
};

/**
 * Browsers start an `AudioContext` suspended until the page has seen a user
 * gesture. Creating it is harmless; `resume()` is the call that can be refused,
 * and that refusal is exactly the `blocked` state.
 */
const defaultCreateContext: AudioContextFactory = () => {
  const Context = globalThis.AudioContext;
  if (!Context) {
    throw new Error('preview: this browser has no Web Audio support');
  }
  return new Context() as unknown as AudioContextLike;
};

function selectionKey(refs: readonly VerseRef[], reciterId: string): string {
  return `${reciterId}|${refs.map((ref) => `${ref.surah}:${ref.verse}`).join(',')}`;
}

/**
 * Plays the selected verses, one after the other, so the user can hear the
 * recitation and the reciter before spending minutes on a video render.
 *
 * The whole selection is downloaded and decoded up front: a preview that
 * stutters between verses cannot answer the question it is asked ("is this the
 * right reciter?"). Decoded buffers stay in memory, so stopping and replaying
 * costs nothing.
 */
export class PreviewPlayer {
  readonly #fetchBytes: FetchBytes;
  readonly #createContext: AudioContextFactory;
  #context: AudioContextLike | null = null;
  #buffers: AudioBufferLike[] = [];
  #key = '';
  #state: PreviewState = 'idle';
  #source: AudioBufferSourceLike | null = null;
  /** Increments on every stop/dispose, invalidating queued `onended` calls. */
  #generation = 0;

  constructor(
    fetchBytes: FetchBytes = defaultFetchBytes,
    createContext: AudioContextFactory = defaultCreateContext,
  ) {
    this.#fetchBytes = fetchBytes;
    this.#createContext = createContext;
  }

  get state(): PreviewState {
    return this.#state;
  }

  /** How many verses are decoded and ready to play. */
  get loadedCount(): number {
    return this.#buffers.length;
  }

  private context(): AudioContextLike {
    this.#context ??= this.#createContext();
    return this.#context;
  }

  /**
   * Downloads and decodes the selection. Loaded twice with the same verses and
   * reciter, it is a no-op: the studio re-renders settings far more often than
   * the selection changes.
   */
  async load(refs: readonly VerseRef[], reciterId: string): Promise<void> {
    if (refs.length === 0) {
      this.#reset();
      return;
    }

    const key = selectionKey(refs, reciterId);
    if (key === this.#key) return;

    this.stop();
    this.#state = 'loading';

    try {
      const reciter = reciterById(reciterId);
      const context = this.context();
      const buffers: AudioBufferLike[] = [];
      for (const ref of refs) {
        const bytes = await this.#fetchBytes(audioUrl(reciter, ref));
        buffers.push(await context.decodeAudioData(bytes));
      }
      this.#buffers = buffers;
      this.#key = key;
      this.#state = 'idle';
    } catch (error) {
      this.#reset();
      throw error;
    }
  }

  /**
   * Starts playing. Called from a click, so this is where the browser is asked
   * to allow sound; a refusal leaves the player in `blocked` and the button
   * offers an explicit action instead of a muttering silence.
   */
  async play(): Promise<void> {
    if (this.#buffers.length === 0) {
      throw new Error('preview: no selection loaded, call load() first');
    }
    if (this.#state === 'playing') return;

    const context = this.context();
    try {
      await context.resume();
    } catch {
      this.#state = 'blocked';
      return;
    }
    if (context.state !== 'running') {
      this.#state = 'blocked';
      return;
    }

    this.#state = 'playing';
    const generation = ++this.#generation;
    this.#playFrom(context, 0, generation);
  }

  /** Stops the current verse and keeps the decoded buffers. */
  stop(): void {
    this.#generation += 1;
    const source = this.#source;
    this.#source = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished: stopping twice throws in some browsers.
      }
    }
    if (this.#state === 'playing' || this.#state === 'blocked') {
      this.#state = 'idle';
    }
  }

  /** Stops, forgets the decoded audio and closes the device. */
  dispose(): void {
    this.stop();
    this.#reset();
    const context = this.#context;
    this.#context = null;
    void context?.close?.().catch(() => {
      // Nothing left to release if the context was already closed.
    });
  }

  #reset(): void {
    this.#buffers = [];
    this.#key = '';
    this.#state = 'idle';
  }

  #playFrom(context: AudioContextLike, index: number, generation: number): void {
    if (generation !== this.#generation) return;
    if (index >= this.#buffers.length) {
      this.#source = null;
      this.#state = 'idle';
      return;
    }

    const source = context.createBufferSource();
    source.buffer = this.#buffers[index];
    source.connect(context.destination);
    source.onended = () => {
      if (generation === this.#generation) this.#playFrom(context, index + 1, generation);
    };
    this.#source = source;
    source.start();
  }
}
