import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.use({ locale: 'fr-FR' });

/**
 * WebKit reports encoder failures with a generic "unknown transient reason".
 * Print each capability separately so a CI log says which API is missing
 * instead of leaving the render journey to time out mysteriously.
 */
test('report the codecs and recorders WebKit exposes', async ({ page }) => {
  await page.goto('/bibliotheque/');
  const report = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    const probe = async (name: string, run: () => unknown | Promise<unknown>) => {
      try {
        out[name] = await run();
      } catch (error) {
        out[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
      }
    };

    await probe('encoder API', () => ({
      VideoEncoder: typeof VideoEncoder,
      AudioEncoder: typeof AudioEncoder,
      VideoFrame: typeof VideoFrame,
      OffscreenCanvas: typeof OffscreenCanvas,
      MediaRecorder: typeof MediaRecorder,
      AudioContext: typeof AudioContext,
    }));
    await probe('video avc1.42001f', async () =>
      typeof VideoEncoder === 'function'
        ? await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 1080, height: 1920, bitrate: 6_000_000, framerate: 30 })
        : 'no VideoEncoder',
    );
    await probe('audio mp4a.40.2', async () =>
      typeof AudioEncoder === 'function'
        ? await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 })
        : 'no AudioEncoder',
    );
    for (const mime of ['video/mp4;codecs=avc1.42001f,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus']) {
      await probe(`isTypeSupported ${mime}`, () =>
        typeof MediaRecorder === 'function' && typeof MediaRecorder.isTypeSupported === 'function'
          ? MediaRecorder.isTypeSupported(mime)
          : 'no MediaRecorder',
      );
    }
    await probe('AudioContext 48000', () =>
      typeof AudioContext === 'function' ? new AudioContext({ sampleRate: 48_000 }).state : 'no AudioContext',
    );
    await probe('captureStream', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (!ctx) return 'no 2D context';
      return canvas.captureStream(30).getVideoTracks().length;
    });
    await probe('MediaRecorder start', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });
      recorder.start();
      const state = recorder.state;
      recorder.stop();
      return state;
    });

    return out;
  });
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/webkit-caps.json', JSON.stringify(report, null, 2));
  console.log('[webkit caps] ' + JSON.stringify(report, null, 2));
  expect(report).toBeTruthy();
});
