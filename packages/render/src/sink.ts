/**
 * Where the encoded bytes go.
 *
 * A 15-minute 1080p video is hundreds of megabytes, so it cannot always live in
 * a JavaScript array. Memory holds small renders; OPFS keeps the file private to
 * the app without a prompt; File System Access writes straight to the location
 * the user picks. Every sink supports `abort`, because a cancelled render must
 * not leave a half-written file behind.
 */

export interface OutputSink {
  write(chunk: Uint8Array): Promise<void>;
  finalize(): Promise<Blob>;
  abort(): Promise<void>;
  /** Bytes accepted so far; reset by `abort`. */
  readonly bytesWritten: number;
}

export type SinkKind = 'memory' | 'opfs' | 'fs-access';

export interface SinkCapabilities {
  opfs: boolean;
  fsAccess: boolean;
}

/** Above this, a memory render risks the tab's whole heap. */
export const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;

/** A full device is a state the user can fix, not a mysterious render crash. */
export class StorageQuotaError extends Error {
  constructor(message = 'sink: the device ran out of storage space', options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageQuotaError';
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'QuotaExceededError'
  );
}

function asQuotaError(error: unknown): unknown {
  return isQuotaError(error)
    ? new StorageQuotaError(undefined, { cause: error })
    : error;
}

/**
 * Chooses where a render of `maxBytes` should be written. A supported large
 * sink wins even for a small file: the user keeps the file where they chose and
 * the tab keeps its memory. When neither large sink exists, a file that fits
 * goes to memory, and a larger one still asks for a save location — a prompt
 * that may fail is better than an allocation that will.
 */
export function pickSinkKind(maxBytes: number, caps: SinkCapabilities): SinkKind {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error(`sink: maxBytes must be a finite, non-negative number, got ${maxBytes}`);
  }
  // A file that fits in the memory ceiling does not need a save dialog or a
  // device quota: those fail on long-but-small renders and on WebKit sandboxes.
  if (maxBytes <= MEMORY_LIMIT_BYTES) return 'memory';
  if (caps.fsAccess) return 'fs-access';
  if (caps.opfs) return 'opfs';
  return 'fs-access';
}

interface WritableStreamLike {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

/**
 * The shared state machine: writing, finished once, or aborted. Both file
 * sinks differ only in how the writable and the final blob are obtained.
 */
function createStreamingSink(
  writable: WritableStreamLike,
  finish: () => Promise<Blob>,
  removePartial: () => Promise<void>,
): OutputSink {
  let bytes = 0;
  let blob: Blob | null = null;
  let finished = false;
  let aborted = false;

  return {
    get bytesWritten() {
      return bytes;
    },

    async write(chunk) {
      if (aborted) throw new Error('sink: cannot write after abort');
      if (finished) throw new Error('sink: cannot write after finalize');
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('sink: write expects a Uint8Array');
      }
      try {
        await writable.write(chunk);
      } catch (error) {
        // A failed write keeps the byte count at what actually reached the
        // file, so the queue's progress stays honest.
        throw asQuotaError(error);
      }
      bytes += chunk.byteLength;
    },

    async finalize() {
      if (aborted) throw new Error('sink: cannot finalize an aborted sink');
      if (finished && blob) return blob;
      try {
        await writable.close();
      } catch (error) {
        throw asQuotaError(error);
      }
      finished = true;
      blob = await finish();
      return blob;
    },

    async abort() {
      if (aborted || finished) return;
      aborted = true;
      try {
        await writable.abort?.();
      } catch {
        // The stream is already unusable; removing the file is what matters.
      }
      await removePartial();
      bytes = 0;
    },
  };
}

function createMemorySink(): OutputSink {
  const parts: Blob[] = [];
  let bytes = 0;
  let blob: Blob | null = null;
  let finished = false;
  let aborted = false;

  return {
    get bytesWritten() {
      return bytes;
    },

    async write(chunk) {
      if (aborted) throw new Error('sink: cannot write after abort');
      if (finished) throw new Error('sink: cannot write after finalize');
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('sink: write expects a Uint8Array');
      }
      // Copy now: encoders reuse their frame buffers as soon as write returns.
      parts.push(new Blob([chunk.slice()]));
      bytes += chunk.byteLength;
    },

    async finalize() {
      if (aborted) throw new Error('sink: cannot finalize an aborted sink');
      blob ??= new Blob(parts);
      finished = true;
      return blob;
    },

    async abort() {
      if (aborted || finished) return;
      aborted = true;
      parts.length = 0;
      blob = null;
      bytes = 0;
    },
  };
}

async function createOpfsSink(name: string): Promise<OutputSink> {
  const storage =
    typeof navigator !== 'undefined'
      ? (navigator.storage as StorageManager | undefined)
      : undefined;

  if (!storage || typeof storage.getDirectory !== 'function') {
    throw new Error('sink: OPFS is not available in this browser');
  }

  const directory = await storage.getDirectory();
  const handle = await directory.getFileHandle(name, { create: true });
  let writable: WritableStreamLike;
  try {
    // lib.dom types Uint8Array as ArrayBufferLike; the stream accepts it at runtime.
    writable = (await handle.createWritable()) as unknown as WritableStreamLike;
  } catch (error) {
    throw asQuotaError(error);
  }

  return createStreamingSink(
    writable,
    () => handle.getFile(),
    async () => {
      try {
        await directory.removeEntry(name);
      } catch {
        // Nothing was created, or it is already gone: the goal is "no partial
        // file", and it is met either way.
      }
    },
  );
}

interface FilePickerGlobal {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<FileSystemFileHandle>;
}

async function createFsAccessSink(name: string): Promise<OutputSink> {
  const picker = (globalThis as FilePickerGlobal).showSaveFilePicker;
  if (typeof picker !== 'function') {
    throw new Error('sink: the File System Access API is not available in this browser');
  }

  const handle = await picker({ suggestedName: name });
  let writable: WritableStreamLike;
  try {
    // lib.dom types Uint8Array as ArrayBufferLike; the stream accepts it at runtime.
    writable = (await handle.createWritable()) as unknown as WritableStreamLike;
  } catch (error) {
    throw asQuotaError(error);
  }

  const removable = handle as FileSystemFileHandle & { remove?: () => Promise<void> };

  return createStreamingSink(
    writable,
    () => handle.getFile(),
    async () => {
      if (typeof removable.remove !== 'function') return;
      try {
        await removable.remove();
      } catch {
        // Some browsers do not implement removal for picked files. Failing to
        // delete must not turn the abort itself into an error.
      }
    },
  );
}

export async function createSink(kind: SinkKind, name: string): Promise<OutputSink> {
  if (kind !== 'memory' && kind !== 'opfs' && kind !== 'fs-access') {
    throw new Error(`sink: unknown sink kind ${JSON.stringify(kind)}`);
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('sink: the file needs a name');
  }

  switch (kind) {
    case 'memory':
      return createMemorySink();
    case 'opfs':
      try {
        return await createOpfsSink(name.trim());
      } catch (error) {
        // Absence of the API is a caller mistake (pickSinkKind would not have
        // chosen it), so keep that error. A present-but-refusing API is what
        // WebKit does in sandboxed contexts: render in memory instead.
        if (error instanceof Error && /OPFS is not available/.test(error.message)) throw error;
        console.warn('sink: OPFS could not be opened, rendering in memory', error);
        return createMemorySink();
      }
    case 'fs-access':
      return createFsAccessSink(name.trim());
  }
}
