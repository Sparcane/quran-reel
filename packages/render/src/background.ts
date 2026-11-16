import type { GradientSelection } from '@quran/core';

export interface Size {
  width: number;
  height: number;
}

/**
 * The slice of a 2D canvas a painter touches. Narrowing it keeps the painters
 * usable from an `OffscreenCanvas` (the renderer) and a regular `<canvas>` (the
 * preview) without importing either, and lets a test record the calls.
 */
export type PaintContext = Pick<
  OffscreenCanvasRenderingContext2D,
  | 'fillStyle'
  | 'globalAlpha'
  | 'save'
  | 'restore'
  | 'fillRect'
  | 'createLinearGradient'
  | 'drawImage'
>;

/**
 * Paints the background of one frame.
 *
 * `t` is the time inside the video, in seconds. Painters are pure functions of
 * `t`: rendering happens as fast as the device allows, never in real time, so
 * the same frame must always look the same.
 */
export interface BackgroundPainter {
  paint(ctx: PaintContext, t: number): void;
  readonly ready: boolean;
  dispose(): void;
}

/** One full sweep of the animated gradient, in seconds. */
const MOTION_PERIOD_SECONDS = 20;

/** How far the angle swings either side of the chosen one, in degrees. */
const MOTION_AMPLITUDE_DEGREES = 18;

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function assertColor(color: string, name: string): void {
  if (!COLOR_PATTERN.test(color)) {
    throw new Error(`background: ${name} colour ${JSON.stringify(color)} is not a hex colour`);
  }
}

function assertSize(size: Size): void {
  for (const [name, value] of [
    ['width', size.width],
    ['height', size.height],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`background: size ${name} must be a positive number, got ${value}`);
    }
  }
}

function angleAt(selection: GradientSelection, t: number): number {
  if (!selection.motion) return selection.angle;
  const phase = (2 * Math.PI * t) / MOTION_PERIOD_SECONDS;
  return selection.angle + MOTION_AMPLITUDE_DEGREES * Math.sin(phase);
}

/**
 * Endpoints of a linear gradient across the frame's full diagonal, so that no
 * corner is left with a flat colour whatever the angle.
 */
function gradientLine(size: Size, angleDegrees: number) {
  const radians = (angleDegrees * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const length = Math.abs(size.width * dx) + Math.abs(size.height * dy);
  const centerX = size.width / 2;
  const centerY = size.height / 2;
  const half = length / 2;

  return {
    x0: centerX - dx * half,
    y0: centerY - dy * half,
    x1: centerX + dx * half,
    y1: centerY + dy * half,
  };
}

export function createGradientPainter(selection: GradientSelection, size: Size): BackgroundPainter {
  assertColor(selection.from, 'from');
  assertColor(selection.to, 'to');
  assertSize(size);
  if (!Number.isFinite(selection.angle)) {
    throw new Error(`background: angle must be a finite number, got ${selection.angle}`);
  }

  return {
    ready: true,
    paint(ctx, t) {
      const line = gradientLine(size, angleAt(selection, t));
      const gradient = ctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1);
      gradient.addColorStop(0, selection.from);
      gradient.addColorStop(1, selection.to);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size.width, size.height);
    },
    dispose() {
      // Nothing to release: the gradient holds no resources.
    },
  };
}

/**
 * Paints an imported picture so that it covers the frame (the overflow is
 * cropped, never squashed). The video is vertical or square most of the time,
 * so a landscape photo must not be distorted to fit.
 */
export function createImagePainter(bitmap: ImageBitmap, size: Size): BackgroundPainter {
  assertSize(size);
  if (!bitmap || bitmap.width <= 0 || bitmap.height <= 0) {
    throw new Error('background: the picture has no size to paint');
  }

  const scale = Math.max(size.width / bitmap.width, size.height / bitmap.height);
  const drawWidth = bitmap.width * scale;
  const drawHeight = bitmap.height * scale;
  const offsetX = (size.width - drawWidth) / 2;
  const offsetY = (size.height - drawHeight) / 2;

  let disposed = false;

  return {
    ready: true,
    paint(ctx) {
      if (disposed) return;
      ctx.drawImage(bitmap, offsetX, offsetY, drawWidth, drawHeight);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // An ImageBitmap holds decoded memory the size of the picture.
      bitmap.close();
    },
  };
}
