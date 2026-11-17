/**
 * The one entry point the studio calls to render a video.
 *
 * A fifteen-minute render must not freeze the interface, so the WebCodecs path
 * runs in a module worker. MediaRecorder cannot: it needs a DOM canvas and a
 * real-time clock, so it stays on the main thread as the fallback. Both paths
 * share the same plan, sink and progress contract, and both refuse a cancelled
 * render without leaving a partial file behind.
 */

import { buildTimeline, MAX_VIDEO_SECONDS } from '@quran/core';
import { deserialiseEncodePlan, serialiseEncodePlan, type WireEncodePlan } from './audio-wire';
import type { BackgroundPainter } from './background';
import {
  EncoderUnavailableError,
  validateEncodePlan,
  videoBitrateFor,
  type EncodePlan,
} from './encoder-plan';
import {
  defaultEncoderEnvironment,
  encodeWebCodecs,
  webCodecsAvailable,
} from './encoder-webcodecs';
import {
  defaultMediaRecorderEnvironment,
  encodeMediaRecorder,
  mediaRecorderAvailable,
} from './encoder-mediarecorder';
import { selectEncoder, type EncoderCapabilities, type EncoderKind } from './select-encoder';
import {
  createSink,
  pickSinkKind,
  type OutputSink,
  type SinkCapabilities,
  type SinkKind,
} from './sink';
import type { Progress, RenderedVideo, RenderSpec } from './types';

export class RenderCancelledError extends Error {
  constructor(message = 'render: cancelled') {
    super(message);
    this.name = 'RenderCancelledError';
  }
}

/** Messages sent from the main thread to the module worker. */
export interface RenderWorkerRequest {
  kind: 'render';
  id: number;
  plan: EncodePlan;
  sinkKind: SinkKind;
  fileName: string;
}

/** The same request after serialisation, as it actually crosses `postMessage`. */
export interface WireRenderWorkerRequest {
  kind: 'render';
  id: number;
  plan: WireEncodePlan;
  sinkKind: SinkKind;
  fileName: string;
}

export interface CancelWorkerRequest {
  kind: 'cancel';
}

export type WorkerRequest = RenderWorkerRequest | WireRenderWorkerRequest | CancelWorkerRequest;

/** Messages sent back from the worker to the main thread. */
export type WorkerResponse =
  | { kind: 'progress'; id: number; progress: Progress }
  | { kind: 'done'; id: number; video: RenderedVideo }
  | { kind: 'error'; id: number; message: string }
  | { kind: 'cancelled'; id: number };

export interface RenderWorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RendererCapabilities extends EncoderCapabilities, SinkCapabilities {}

export type RenderEncode = (
  kind: EncoderKind,
  plan: EncodePlan,
  sink: OutputSink,
  onProgress: (progress: Progress) => void,
) => Promise<RenderedVideo>;

/**
 * Everything the renderer needs from the platform. jsdom has no `Worker`, no
 * codecs and no file picker, so tests replace the whole seam.
 */
export interface RendererEnvironment {
  /** `null` means there is no worker here; render inline on the calling thread. */
  createWorker(): RenderWorkerLike | null;
  capabilities: RendererCapabilities;
  createSink(kind: SinkKind, name: string): Promise<OutputSink>;
  encode: RenderEncode;
  now(): number;
}

export interface VideoRenderer {
  render(spec: RenderSpec, onProgress: (progress: Progress) => void): Promise<RenderedVideo>;
  cancel(): void;
}

export interface WorkerJobDeps {
  createSink(kind: SinkKind, name: string): Promise<OutputSink>;
  encode: RenderEncode;
}

/** Derive the encoder plan, applying the hard limit before any work starts. */
export function planFromSpec(spec: RenderSpec): EncodePlan {
  if (!Number.isFinite(spec.maxDurationSec) || spec.maxDurationSec > MAX_VIDEO_SECONDS) {
    throw new Error(
      `render: the ${MAX_VIDEO_SECONDS} s limit cannot be raised (got ${spec.maxDurationSec})`,
    );
  }

  const timeline = spec.timeline ?? buildTimeline(spec.verses.map((verse) => verse.durationSec));
  if (!Number.isFinite(timeline.totalSec) || timeline.totalSec > spec.maxDurationSec) {
    throw new Error(
      `render: the video would last ${timeline.totalSec.toFixed(1)} s, over the ${spec.maxDurationSec} s limit`,
    );
  }

  return {
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    verses: spec.verses,
    style: spec.style,
    background: spec.background,
    backgroundSelection: spec.backgroundSelection,
    timeline,
    overlayOpacity: spec.overlayOpacity,
    centerY: spec.centerY,
    watermark: spec.watermark,
  };
}

function defaultWorkerDeps(): WorkerJobDeps {
  return {
    createSink,
    encode: (kind, plan, sink, onProgress) => {
      if (kind === 'webcodecs') {
        return encodeWebCodecs(plan, sink, onProgress, defaultEncoderEnvironment());
      }
      if (kind === 'mediarecorder') {
        return encodeMediaRecorder(plan, sink, onProgress, defaultMediaRecorderEnvironment());
      }
      throw new EncoderUnavailableError('render: the worker has no usable encoder');
    },
  };
}

/**
 * Worker side of one render. A cancellation flips the flag; the guarded
 * progress callback then throws inside the encoder, whose own error path aborts
 * the sink. This is why no change to the encoders was needed.
 */
export async function runWorkerJob(
  request: RenderWorkerRequest,
  post: (message: WorkerResponse) => void,
  isCancelled: () => boolean,
  deps: WorkerJobDeps = defaultWorkerDeps(),
): Promise<void> {
  let sink: OutputSink | null = null;
  try {
    // Sink creation is part of the job: if it throws, the caller still needs an
    // answer. Leaving it outside the try used to hang the render promise on the
    // main thread with no error ever posted back.
    sink = await deps.createSink(request.sinkKind, request.fileName);
    const video = await deps.encode('webcodecs', request.plan, sink, (progress) => {
      if (isCancelled()) throw new RenderCancelledError();
      post({ kind: 'progress', id: request.id, progress });
    });
    if (isCancelled()) throw new RenderCancelledError();
    post({ kind: 'done', id: request.id, video });
  } catch (error) {
    if (sink) await sink.abort().catch(() => undefined);
    if (error instanceof RenderCancelledError) {
      post({ kind: 'cancelled', id: request.id });
      return;
    }
    post({
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Wire a worker global's `onmessage` to the job runner. */
export function installWorkerHandler(scope: {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
}): () => void {
  let cancelled = false;
  scope.onmessage = (event) => {
    const message = event.data;
    if (message.kind === 'cancel') {
      cancelled = true;
      return;
    }
    cancelled = false;
    // The plan arrived as a structured clone: audio is channel arrays and the
    // painter is a plain selection. Give the encoder the live objects back.
    const request: RenderWorkerRequest = {
      ...message,
      plan: deserialiseEncodePlan(message.plan as WireEncodePlan),
    };
    void runWorkerJob(request, (response) => scope.postMessage(response), () => cancelled);
  };
  return () => {
    scope.onmessage = null;
  };
}

interface ActiveJob {
  cancel(): void;
}

export function createRenderer(
  environment: RendererEnvironment = defaultRendererEnvironment(),
): VideoRenderer {
  let active: ActiveJob | null = null;
  let nextId = 1;

  return {
    async render(spec, onProgress) {
      const plan = planFromSpec(spec);
      validateEncodePlan(plan);

      const kind = selectEncoder(environment.capabilities);
      if (kind === 'none') {
        throw new EncoderUnavailableError('render: no encoder is available in this browser');
      }

      const estimatedBytes = (videoBitrateFor(plan.width, plan.height) * plan.timeline.totalSec) / 8;
      const worker = kind === 'webcodecs' ? environment.createWorker() : null;
      // A module worker has no showSaveFilePicker, so it cannot honour an
      // fs-access sink even when the window can. Excluding it here keeps the
      // worker's createSink from throwing before it posts any response back.
      const sinkKind = pickSinkKind(
        estimatedBytes,
        worker ? { ...environment.capabilities, fsAccess: false } : environment.capabilities,
      );
      const fileName = `quran-${Date.now()}.${kind === 'mediarecorder' ? 'webm' : 'mp4'}`;
      const id = nextId;
      if (worker) {
        return new Promise<RenderedVideo>((resolve, reject) => {
          let settled = false;
          const finish = (done: () => void) => {
            if (settled) return;
            settled = true;
            active = null;
            done();
          };

          active = { cancel: () => worker.postMessage({ kind: 'cancel' }) };
          worker.onmessage = (event) => {
            const response = event.data;
            if (response.id !== id) return;
            if (response.kind === 'progress') {
              onProgress(response.progress);
              return;
            }
            if (response.kind === 'done') finish(() => resolve(response.video));
            else if (response.kind === 'error') finish(() => reject(new Error(response.message)));
            else finish(() => reject(new RenderCancelledError()));
          };
          worker.onerror = (event) => {
            const message = event instanceof Error ? event.message : String(event);
            finish(() => reject(new Error(message)));
          };
          worker.postMessage({
            kind: 'render',
            id,
            plan: serialiseEncodePlan(plan),
            sinkKind,
            fileName,
          });
        });
      }

      const sink = await environment.createSink(sinkKind, fileName);
      let cancelJob: () => void = () => {};
      const cancellation = new Promise<never>((_resolve, reject) => {
        cancelJob = () => reject(new RenderCancelledError());
      });
      active = { cancel: cancelJob };

      const job = environment.encode(kind, plan, sink, (progress) => {
        if (!Number.isFinite(progress.percent)) return;
        onProgress(progress);
      });
      // Cancellation can win the race; keep the encoder's eventual rejection
      // from becoming an unhandled promise rejection.
      job.catch(() => undefined);

      try {
        const result = await Promise.race([job, cancellation]);
        onProgress({
          frame: Math.round(plan.timeline.totalSec * plan.fps),
          totalFrames: Math.round(plan.timeline.totalSec * plan.fps),
          percent: 100,
          etaSec: 0,
        });
        return result;
      } catch (error) {
        await sink.abort().catch(() => undefined);
        throw error;
      } finally {
        active = null;
      }
    },

    cancel() {
      active?.cancel();
    },
  };
}

/**
 * The browser/native environment: real codecs and device storage.
 *
 * The worker factory is injected because a bundler must see the
 * `new Worker(new URL(...))` call in the app that owns the worker file: placed
 * in a workspace package resolved through node_modules, Turbopack follows the
 * URL through the symlink forever. Callers that do not need offloading (tests,
 * direct encoder use) get inline rendering by default.
 */
export function defaultRendererEnvironment(
  createWorker: () => RenderWorkerLike | null = () => null,
): RendererEnvironment {
  const globals = globalThis as {
    showSaveFilePicker?: unknown;
  };
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;

  return {
    createWorker,
    capabilities: {
      webCodecs: webCodecsAvailable(),
      mediaRecorder: mediaRecorderAvailable(),
      opfs: typeof storage?.getDirectory === 'function',
      fsAccess: typeof globals.showSaveFilePicker === 'function',
    },
    createSink,
    encode: (kind, plan, sink, onProgress) => {
      if (kind === 'webcodecs') return encodeWebCodecs(plan, sink, onProgress);
      if (kind === 'mediarecorder') return encodeMediaRecorder(plan, sink, onProgress);
      throw new EncoderUnavailableError('render: no encoder is available in this browser');
    },
    now: () => Date.now(),
  };
}

