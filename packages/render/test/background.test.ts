import { describe, expect, it, vi } from 'vitest';
import {
  createGradientPainter,
  createImagePainter,
  type PaintContext,
} from '../src/background';

/**
 * A 2D context that records what a painter asked it to draw. The renderer only
 * needs a handful of calls, so the test can verify the painting geometry
 * exactly instead of reading pixels back (which jsdom cannot do).
 */
function recordingContext() {
  const operations: Record<string, unknown>[] = [];
  const stub = {
    fillStyle: '' as string | CanvasGradient,
    globalAlpha: 1,
    save: () => operations.push({ op: 'save' }),
    restore: () => operations.push({ op: 'restore' }),
    fillRect: (x: number, y: number, width: number, height: number) =>
      operations.push({ op: 'fillRect', x, y, width, height }),
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => {
      const stops: [number, string][] = [];
      operations.push({ op: 'gradient', x0, y0, x1, y1, stops });
      return {
        addColorStop: (offset: number, color: string) => {
          stops.push([offset, color]);
        },
      };
    },
    drawImage: (...args: unknown[]) => operations.push({ op: 'drawImage', args }),
  };
  return { ctx: stub as unknown as PaintContext, operations };
}

type GradientOperation = {
  op: 'gradient';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stops: [number, string][];
};

function gradientOf(operations: Record<string, unknown>[]): GradientOperation {
  const gradient = operations.find((operation) => operation.op === 'gradient');
  if (!gradient) throw new Error('the painter drew no gradient');
  return gradient as unknown as GradientOperation;
}

const gradient = {
  kind: 'gradient' as const,
  from: '#0a0a0a',
  to: '#1e3a5f',
  angle: 45,
  motion: true,
};

describe('createGradientPainter', () => {
  it('fills the whole frame with the two colours', () => {
    const { ctx, operations } = recordingContext();
    const painter = createGradientPainter(gradient, { width: 8, height: 8 });

    painter.paint(ctx, 0);

    expect(operations.filter((operation) => operation.op === 'fillRect')).toEqual([
      { op: 'fillRect', x: 0, y: 0, width: 8, height: 8 },
    ]);
    expect(gradientOf(operations).stops).toEqual([
      [0, '#0a0a0a'],
      [1, '#1e3a5f'],
    ]);
  });

  it('draws the gradient along the requested angle', () => {
    const { ctx, operations } = recordingContext();
    createGradientPainter({ ...gradient, motion: false }, { width: 8, height: 8 }).paint(ctx, 0);

    // 45° across an 8×8 frame runs corner to corner.
    const drawn = gradientOf(operations);
    expect(drawn.x0).toBeCloseTo(0, 5);
    expect(drawn.y0).toBeCloseTo(0, 5);
    expect(drawn.x1).toBeCloseTo(8, 5);
    expect(drawn.y1).toBeCloseTo(8, 5);
  });

  it('moves over time when motion is on', () => {
    const { ctx, operations } = recordingContext();
    const painter = createGradientPainter(gradient, { width: 8, height: 8 });

    painter.paint(ctx, 0);
    const atZero = gradientOf(operations);
    operations.length = 0;
    painter.paint(ctx, 4);
    const atFour = gradientOf(operations);

    expect(atFour.x1).not.toBeCloseTo(atZero.x1, 2);
  });

  it('is deterministic: the same time always paints the same frame', () => {
    const first = recordingContext();
    const second = recordingContext();
    createGradientPainter(gradient, { width: 8, height: 8 }).paint(first.ctx, 3);
    createGradientPainter(gradient, { width: 8, height: 8 }).paint(second.ctx, 3);

    expect(gradientOf(first.operations)).toEqual(gradientOf(second.operations));
  });

  it('comes back to the same angle after one 20-second period', () => {
    const { ctx, operations } = recordingContext();
    const painter = createGradientPainter(gradient, { width: 8, height: 8 });

    painter.paint(ctx, 0);
    const start = gradientOf(operations);
    operations.length = 0;
    painter.paint(ctx, 20);

    const afterPeriod = gradientOf(operations);
    expect(afterPeriod.x1).toBeCloseTo(start.x1, 5);
    expect(afterPeriod.y1).toBeCloseTo(start.y1, 5);
  });

  it('stays still when motion is off', () => {
    const { ctx, operations } = recordingContext();
    const painter = createGradientPainter({ ...gradient, motion: false }, { width: 8, height: 8 });

    painter.paint(ctx, 0);
    const start = gradientOf(operations);
    operations.length = 0;
    painter.paint(ctx, 7);

    expect(gradientOf(operations)).toEqual(start);
  });

  it('is ready immediately and can be disposed more than once', () => {
    const painter = createGradientPainter(gradient, { width: 8, height: 8 });

    expect(painter.ready).toBe(true);
    painter.dispose();
    expect(() => painter.dispose()).not.toThrow();
  });

  it('refuses a colour or a size it cannot paint', () => {
    expect(() => createGradientPainter({ ...gradient, from: 'blue' }, { width: 8, height: 8 })).toThrow(
      /colour|color/i,
    );
    expect(() => createGradientPainter(gradient, { width: 0, height: 8 })).toThrow(/width|size/i);
  });
});

describe('createImagePainter', () => {
  it('covers the frame without distorting the picture', () => {
    const { ctx, operations } = recordingContext();
    const bitmap = { width: 100, height: 50, close: vi.fn() } as unknown as ImageBitmap;

    createImagePainter(bitmap, { width: 8, height: 8 }).paint(ctx, 0);

    // 100×50 scaled by 0.16 becomes 16×8: exactly as tall as the frame, wider,
    // so 4 px overflow on each side.
    expect(operations.find((operation) => operation.op === 'drawImage')?.args).toEqual([
      bitmap,
      -4,
      0,
      16,
      8,
    ]);
  });

  it('covers a tall frame from the top and bottom the same way', () => {
    const { ctx, operations } = recordingContext();
    const bitmap = { width: 50, height: 100, close: vi.fn() } as unknown as ImageBitmap;

    createImagePainter(bitmap, { width: 8, height: 8 }).paint(ctx, 0);

    expect(operations.find((operation) => operation.op === 'drawImage')?.args).toEqual([
      bitmap,
      0,
      -4,
      8,
      16,
    ]);
  });

  it('paints the same picture at any time, then frees it when disposed', () => {
    const { ctx, operations } = recordingContext();
    const close = vi.fn();
    const bitmap = { width: 100, height: 50, close } as unknown as ImageBitmap;
    const painter = createImagePainter(bitmap, { width: 8, height: 8 });

    painter.paint(ctx, 0);
    const atZero = operations.filter((operation) => operation.op === 'drawImage');
    operations.length = 0;
    painter.paint(ctx, 9);

    expect(operations.filter((operation) => operation.op === 'drawImage')).toEqual(atZero);
    painter.dispose();
    expect(close).toHaveBeenCalledOnce();
  });
});
