import { vi } from 'vitest';
import type {
  AudioBufferSourceLike,
  AudioContextLike,
  FetchBytes,
} from '../src/lib/preview-audio';

interface FakeSource extends AudioBufferSourceLike {
  started: number;
  stopped: boolean;
  connectedTo: unknown[];
}

/**
 * jsdom has no Web Audio at all, so the preview tests drive a fake context.
 * The fake enforces the same autoplay rule as a browser: `resume()` rejects
 * until the page earned a gesture.
 */
export function fakeAudio() {
  let blocked = true;
  const sources: FakeSource[] = [];

  const context = {
    state: 'suspended',
    destination: { name: 'speakers' },
    resume: vi.fn(async () => {
      if (blocked) {
        throw new Error('NotAllowedError: play() failed because the user did not interact');
      }
      context.state = 'running';
    }),
    decodeAudioData: vi.fn(async () => ({ duration: 1.5 })),
    createBufferSource: vi.fn(() => {
      const source: FakeSource = {
        buffer: null,
        onended: null,
        started: -1,
        stopped: false,
        connectedTo: [],
        connect(destination: unknown) {
          source.connectedTo.push(destination);
        },
        start(when = 0) {
          source.started = when;
        },
        stop() {
          source.stopped = true;
        },
      };
      sources.push(source);
      return source;
    }),
    close: vi.fn(async () => {
      context.state = 'closed';
    }),
  };

  return {
    context: context as unknown as AudioContextLike,
    factory: () => context as unknown as AudioContextLike,
    sources,
    block() {
      blocked = true;
      context.state = 'suspended';
    },
    unblock() {
      blocked = false;
    },
  };
}

/** A download that never touches the network. */
export function fakeFetch(failSuffix?: string) {
  return vi.fn(async (url: string) => {
    if (failSuffix && url.endsWith(failSuffix)) throw new Error('404');
    return new ArrayBuffer(16);
  }) as unknown as FetchBytes & { mock: { calls: [string][] } };
}
