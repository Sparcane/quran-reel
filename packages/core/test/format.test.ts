import { describe, expect, it } from 'vitest';
import { clamp, formatDuration, pad3 } from '../src/format';

describe('pad3', () => {
  it('pads to three digits', () => {
    expect(pad3(7)).toBe('007');
  });

  it('leaves three digits alone', () => {
    expect(pad3(114)).toBe('114');
  });

  it('keeps longer numbers', () => {
    expect(pad3(1234)).toBe('1234');
  });
});

describe('formatDuration', () => {
  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats a minute and fifteen seconds', () => {
    expect(formatDuration(75)).toBe('1:15');
  });

  it('formats fifteen minutes', () => {
    expect(formatDuration(900)).toBe('15:00');
  });
});

describe('clamp', () => {
  it('clamps above the max', () => {
    expect(clamp(150, 24, 120)).toBe(120);
  });

  it('clamps below the min', () => {
    expect(clamp(3, 24, 120)).toBe(24);
  });

  it('leaves a value inside the range alone', () => {
    expect(clamp(48, 24, 120)).toBe(48);
  });
});
