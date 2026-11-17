/**
 * WCAG 2.1 contrast math, used to keep the interface's muted text readable on
 * the dark background. Keeping it here (rather than trusting an axe check that
 * needs a layout engine) makes the contrast budget testable in any DOM.
 */

/** Relative luminance of an sRGB colour given as `#rgb` or `#rrggbb`. */
function luminance(hex: string): number {
  const raw = hex.trim().replace(/^#/, '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`contrast: invalid hex colour "${hex}"`);
  }

  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Contrast ratio between two sRGB colours, from 1:1 up to 21:1. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
