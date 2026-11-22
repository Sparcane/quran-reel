import { afterEach, describe, expect, it } from 'vitest';
import {
  createSink,
  pickSinkKind,
  StorageQuotaError,
  type OutputSink,
} from '../src/sink';

type WritableStub = {
  writes: Uint8Array[];
  closed: boolean;
  aborted: boolean;
};

function fakeFileHandle(behaviour: { failWrite?: Error } = {}) {
  const state: WritableStub = { writes: [], closed: false, aborted: false };
  const removable = { removed: 0 };

  const writable = {
    async write(chunk: Uint8Array) {
      if (behaviour.failWrite) throw behaviour.failWrite;
      state.writes.push(chunk.slice());
    },
    async close() {
      state.closed = true;
    },
    async abort() {
      state.aborted = true;
    },
  };

  const handle = {
    createWritable: async () => writable,
    getFile: async () => new Blob(state.writes.map((chunk) => chunk.slice())),
    remove: async () => {
      removable.removed += 1;
    },
  };

  return { handle, state, removable };
}

function fakeOpfsDirectory(behaviour: { failWrite?: Error } = {}) {
  const file = fakeFileHandle(behaviour);
  const created: string[] = [];
  const removed: string[] = [];

  const directory = {
    getFileHandle: async (name: string, options: { create?: boolean }) => {
      if (options?.create !== true) throw new Error('the sink must create the file');
      created.push(name);
      return file.handle;
    },
    removeEntry: async (name: string) => {
      removed.push(name);
    },
  };

  return { directory, file, created, removed };
}

function stubOpfs(directory: unknown): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => directory },
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'storage');
  Reflect.deleteProperty(window, 'showSaveFilePicker');
});

async function bytes(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

async function readAll(sink: OutputSink): Promise<number[]> {
  return bytes(await sink.finalize());
}

describe('pickSinkKind', () => {
  it('writes somewhere the size allows', () => {
    // Below the memory ceiling, keep the whole file in memory: no save dialog,
    // no device quota, no partial file to clean up.
    expect(pickSinkKind(50_000_000, { opfs: true, fsAccess: true })).toBe('memory');
    expect(pickSinkKind(50_000_000, { opfs: true, fsAccess: false })).toBe('memory');
    expect(pickSinkKind(10_000_000, { opfs: false, fsAccess: false })).toBe('memory');
    expect(pickSinkKind(64 * 1024 * 1024, { opfs: true, fsAccess: true })).toBe('memory');
  });

  it('streams to disk only above the memory ceiling', () => {
    expect(pickSinkKind(64 * 1024 * 1024 + 1, { opfs: true, fsAccess: true })).toBe('fs-access');
    expect(pickSinkKind(64 * 1024 * 1024 + 1, { opfs: true, fsAccess: false })).toBe('opfs');
    expect(pickSinkKind(900_000_000, { opfs: false, fsAccess: false })).toBe('fs-access');
  });

  it('refuses a size that cannot exist', () => {
    expect(() => pickSinkKind(Number.NaN, { opfs: true, fsAccess: false })).toThrow(/maxBytes/);
    expect(() => pickSinkKind(-1, { opfs: true, fsAccess: false })).toThrow(/maxBytes/);
  });
});

describe('memory sink', () => {
  it('collects the chunks and reports the bytes written', async () => {
    const sink = await createSink('memory', 'render.mp4');

    await sink.write(new Uint8Array([1, 2, 3]));
    await sink.write(new Uint8Array([4, 5, 6]));

    expect(sink.bytesWritten).toBe(6);
    expect(await readAll(sink)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('copies each chunk, because encoders reuse their buffers', async () => {
    const sink = await createSink('memory', 'render.mp4');
    const chunk = new Uint8Array([7, 8, 9]);

    await sink.write(chunk);
    chunk.fill(0);

    expect(await readAll(sink)).toEqual([7, 8, 9]);
  });

  it('refuses to write after finalize, and finalizes only once', async () => {
    const sink = await createSink('memory', 'render.mp4');
    await sink.write(new Uint8Array([1]));

    const blob = await sink.finalize();
    expect(await sink.finalize()).toBe(blob);
    await expect(sink.write(new Uint8Array([2]))).rejects.toThrow(/finalize/i);
    expect(sink.bytesWritten).toBe(1);
  });

  it('drops the partial file on abort and refuses further work', async () => {
    const sink = await createSink('memory', 'render.mp4');
    await sink.write(new Uint8Array([1, 2]));

    await sink.abort();

    expect(sink.bytesWritten).toBe(0);
    await expect(sink.write(new Uint8Array([3]))).rejects.toThrow(/abort/i);
    await expect(sink.finalize()).rejects.toThrow(/abort/i);
  });

  it('refuses something that is not a byte array', async () => {
    const sink = await createSink('memory', 'render.mp4');

    await expect(sink.write('bytes' as never)).rejects.toThrow(/Uint8Array/);
  });
});

describe('OPFS sink', () => {
  it('streams to a file in the origin private file system', async () => {
    const { directory, file, created } = fakeOpfsDirectory();
    stubOpfs(directory);
    const sink = await createSink('opfs', 'render.mp4');

    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));

    expect(created).toEqual(['render.mp4']);
    expect(sink.bytesWritten).toBe(3);
    expect(await readAll(sink)).toEqual([1, 2, 3]);
    expect(file.state.closed).toBe(true);
    expect(file.state.writes.map((chunk) => [...chunk])).toEqual([[1, 2], [3]]);
  });

  it('removes the partial file on abort', async () => {
    const { directory, file, removed } = fakeOpfsDirectory();
    stubOpfs(directory);
    const sink = await createSink('opfs', 'render.mp4');
    await sink.write(new Uint8Array([1]));

    await sink.abort();

    expect(removed).toEqual(['render.mp4']);
    expect(file.state.aborted).toBe(true);
    expect(sink.bytesWritten).toBe(0);
  });

  it('translates a quota failure into a typed error', async () => {
    const { directory } = fakeOpfsDirectory({
      failWrite: new DOMException('the disk is full', 'QuotaExceededError'),
    });
    stubOpfs(directory);
    const sink = await createSink('opfs', 'render.mp4');

    await expect(sink.write(new Uint8Array([1]))).rejects.toBeInstanceOf(StorageQuotaError);
    expect(sink.bytesWritten).toBe(0);
  });

  it('says OPFS is unavailable instead of writing nowhere', async () => {
    await expect(createSink('opfs', 'render.mp4')).rejects.toThrow(/OPFS/);
  });
});

describe('File System Access sink', () => {
  it('asks where to save, using the requested name', async () => {
    const { handle } = fakeFileHandle();
    let suggestion: string | undefined;
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options: { suggestedName: string }) => {
        suggestion = options.suggestedName;
        return handle;
      },
    });

    const sink = await createSink('fs-access', 'yassin.mp4');
    await sink.write(new Uint8Array([9]));

    expect(suggestion).toBe('yassin.mp4');
    expect(await readAll(sink)).toEqual([9]);
    expect(sink.bytesWritten).toBe(1);
  });

  it('keeps the user cancellation as an AbortError, not a failure', async () => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        throw new DOMException('cancelled', 'AbortError');
      },
    });

    await expect(createSink('fs-access', 'yassin.mp4')).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('removes the file when the render is abandoned', async () => {
    const { handle, removable } = fakeFileHandle();
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => handle,
    });
    const sink = await createSink('fs-access', 'yassin.mp4');
    await sink.write(new Uint8Array([1]));

    await sink.abort();

    expect(removable.removed).toBe(1);
  });

  it('says the API is unavailable where the browser does not have it', async () => {
    await expect(createSink('fs-access', 'yassin.mp4')).rejects.toThrow(/File System Access/);
  });

  it('translates a quota failure from the writable stream', async () => {
    const { handle } = fakeFileHandle({
      failWrite: new DOMException('quota', 'QuotaExceededError'),
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => handle,
    });
    const sink = await createSink('fs-access', 'yassin.mp4');

    await expect(sink.write(new Uint8Array([1]))).rejects.toBeInstanceOf(StorageQuotaError);
  });
});

describe('createSink', () => {
  it('refuses a sink kind it does not implement, naming it', async () => {
    await expect(createSink('dropbox' as never, 'render.mp4')).rejects.toThrow(/dropbox/);
  });

  it('refuses an empty file name', async () => {
    await expect(createSink('memory', '  ')).rejects.toThrow(/name/);
  });

  it('renders in memory when the browser exposes OPFS but refuses to open it', async () => {
    // WebKit has navigator.storage.getDirectory but calling it throws a
    // generic UnknownError in some sandboxed contexts.
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: async () => {
          throw new Error('UnknownError: The operation failed for an unknown transient reason');
        },
      },
    });

    const sink = await createSink('opfs', 'render.mp4');
    await sink.write(new Uint8Array([1, 2, 3]));
    expect(await bytes(await sink.finalize())).toEqual([1, 2, 3]);
  });
});
