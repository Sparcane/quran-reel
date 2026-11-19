/**
 * Parsing an imported movie in a worker.
 *
 * `mp4box` walks whatever bytes the user picked. A well-formed file is read in
 * milliseconds, but the bytes are untrusted: a malformed one can make the
 * parser allocate, spin or throw. The painter has to stay on the main thread
 * (WebCodecs frames and the encoder canvas live there), so only the demux
 * crosses: a `Blob` in, a plain description out, and a failure that arrives as
 * a message instead of a frozen or dead tab.
 *
 * Everything here is plain data so it survives the structured clone. When the
 * platform has no worker, or a page policy refuses to start one, the caller
 * parses on its own thread — the render still works, it is only less isolated.
 */

import { demuxMp4, type DemuxedSource } from './background-video';

/** How long a worker may take before the render gives up on it. */
export const DEMUX_TIMEOUT_MS = 30_000;

export interface DemuxWorkerRequest {
  id: number;
  file: Blob;
}

export type DemuxWorkerResponse =
  | { id: number; source: DemuxedSource }
  | { id: number; error: string };

export interface DemuxWorkerLike {
  postMessage(message: DemuxWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: DemuxWorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * Worker side: read each file it is sent and answer with the description or the
 * reason it could not be read. A throw here kills only this worker.
 */
export function installDemuxHandler(
  scope: {
    postMessage(message: DemuxWorkerResponse): void;
    onmessage: ((event: { data: DemuxWorkerRequest }) => void) | null;
  },
  parse: (bytes: ArrayBuffer) => DemuxedSource = demuxMp4,
): () => void {
  scope.onmessage = (event) => {
    const { id, file } = event.data;
    void (async () => {
      try {
        scope.postMessage({ id, source: parse(await file.arrayBuffer()) });
      } catch (error) {
        scope.postMessage({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };
  return () => {
    scope.onmessage = null;
  };
}

export interface WorkerDemuxOptions {
  /** `null` when this platform has no worker; parsing then happens inline. */
  createWorker: () => DemuxWorkerLike | null;
  /** A worker that stops answering is treated as a failed read. */
  timeoutMs?: number;
}

let nextId = 1;

export function createWorkerDemux(options: WorkerDemuxOptions): (file: Blob) => Promise<DemuxedSource> {
  return (file) => {
    let spawned: DemuxWorkerLike | null;
    try {
      spawned = options.createWorker();
    } catch {
      // A Content Security Policy can forbid workers; the file is still valid.
      spawned = null;
    }
    if (!spawned) return inline(file);
    const worker = spawned;
    const id = nextId;
    nextId += 1;

    return new Promise<DemuxedSource>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (done: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        worker.terminate();
        done();
      };

      timer = setTimeout(
        () =>
          finish(() =>
            reject(new Error('background-video: the file took too long to read')),
          ),
        options.timeoutMs ?? DEMUX_TIMEOUT_MS,
      );

      worker.onmessage = (event) => {
        const response = event.data;
        if (response.id !== id) return;
        if ('source' in response) finish(() => resolve(response.source));
        else finish(() => reject(new Error(response.error)));
      };
      // The worker is gone: its bytes cannot be parsed here either, since a
      // crash on them would take this thread down the same way.
      worker.onerror = () =>
        finish(() => reject(new Error('background-video: the file could not be read')));

      worker.postMessage({ id, file });
    });
  };
}

/** The inline path, kept in one place so both branches return the same shape. */
async function inline(file: Blob): Promise<DemuxedSource> {
  return demuxMp4(await file.arrayBuffer());
}
