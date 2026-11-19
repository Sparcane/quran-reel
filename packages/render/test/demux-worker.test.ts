import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemuxedSource } from '../src/background-video';
import {
  createWorkerDemux,
  installDemuxHandler,
  type DemuxWorkerLike,
  type DemuxWorkerRequest,
  type DemuxWorkerResponse,
} from '../src/demux-worker';

function fixture(): Blob {
  const path = resolve(process.cwd(), 'packages/render/test/fixtures/background.h264.mp4');
  return new Blob([new Uint8Array(readFileSync(path))], { type: 'video/mp4' });
}

const SOURCE: DemuxedSource = {
  codec: 'avc1.42e01e',
  codedWidth: 64,
  codedHeight: 64,
  samples: [],
  durationSec: 0,
};

/**
 * A worker and its global wired in memory: what one side posts, the other
 * receives in a microtask, which is how the structured clone arrives.
 */
function inMemoryWorker(): DemuxWorkerLike {
  const scope = {
    onmessage: null as ((event: { data: DemuxWorkerRequest }) => void) | null,
    postMessage(message: DemuxWorkerResponse) {
      queueMicrotask(() => client.onmessage?.({ data: message }));
    },
  };
  const client: DemuxWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      queueMicrotask(() => scope.onmessage?.({ data: message }));
    },
    terminate: vi.fn(),
  };
  installDemuxHandler(scope);
  return client;
}

describe('createWorkerDemux', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the file in the worker and hands back the same samples', async () => {
    const source = await createWorkerDemux({ createWorker: inMemoryWorker })(fixture());

    expect(source.samples).toHaveLength(120);
    expect(source.codedWidth).toBe(64);
    expect(source.codedHeight).toBe(64);
    expect(source.codec).toMatch(/^avc[13]\./);
  });

  it('parses here only when the platform has no worker', async () => {
    const source = await createWorkerDemux({ createWorker: () => null })(fixture());

    expect(source.samples).toHaveLength(120);
  });

  it('parses here when a page policy refuses to start the worker', async () => {
    const createWorker = () => {
      throw new Error('worker refused by Content Security Policy');
    };

    const source = await createWorkerDemux({ createWorker })(fixture());

    expect(source.samples).toHaveLength(120);
  });

  it('passes the parse failure back with the message the caller shows', async () => {
    await expect(
      createWorkerDemux({ createWorker: inMemoryWorker })(new Blob(['not a movie'])),
    ).rejects.toThrow(/video|readable MP4/i);
  });

  it('reports a worker that dies instead of parsing the bytes again here', async () => {
    const terminate = vi.fn();
    const createWorker = (): DemuxWorkerLike => {
      const worker: DemuxWorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage() {
          queueMicrotask(() => worker.onerror?.(new Error('the reader crashed')));
        },
        terminate,
      };
      return worker;
    };

    // The file is readable, so a silent fall back to this thread would resolve.
    await expect(createWorkerDemux({ createWorker })(fixture())).rejects.toThrow(
      /could not be read/,
    );
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('gives up on a worker that never answers', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const createWorker = (): DemuxWorkerLike => ({
      onmessage: null,
      onerror: null,
      postMessage() {},
      terminate,
    });

    const pending = createWorkerDemux({ createWorker, timeoutMs: 1_000 })(fixture());
    const rejection = expect(pending).rejects.toThrow(/too long/);
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('closes the worker once the file is read', async () => {
    const terminate = vi.fn();
    const worker: DemuxWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        queueMicrotask(() => worker.onmessage?.({ data: { id: message.id, source: SOURCE } }));
      },
      terminate,
    };

    await expect(createWorkerDemux({ createWorker: () => worker })(fixture())).resolves.toBe(SOURCE);
    expect(terminate).toHaveBeenCalledOnce();
  });
});

describe('installDemuxHandler', () => {
  it('answers with the error message when the bytes are not a movie', async () => {
    const answers: DemuxWorkerResponse[] = [];
    const scope = {
      onmessage: null as ((event: { data: DemuxWorkerRequest }) => void) | null,
      postMessage: (message: DemuxWorkerResponse) => answers.push(message),
    };
    installDemuxHandler(scope);

    scope.onmessage?.({ data: { id: 7, file: new Blob(['still not a movie']) } });
    await vi.waitFor(() => expect(answers).toHaveLength(1));

    expect(answers[0]).toMatchObject({ id: 7 });
    expect('error' in answers[0]).toBe(true);
  });
});
