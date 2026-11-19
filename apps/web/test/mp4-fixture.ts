/**
 * A minimal MP4 an import check can read: `ftyp`, an `mvhd` and one H.264
 * track whose sample table describes `sampleCount` frames of 1001/30 000 s.
 *
 * The bytes carry no picture data. The point is the metadata the studio reads
 * before it copies anything to the device.
 */

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];

const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

function box(type: string, payload: number[]): number[] {
  return [...u32(8 + payload.length), ...ascii(type), ...payload];
}

/** A box with a version and three flags, which is what a `stsd` or `stts` is. */
function fullBox(type: string, payload: number[]): number[] {
  return box(type, [...u32(0), ...payload]);
}

/** A visual sample entry: six reserved bytes, the data reference, then the size. */
function videoEntry(width: number, height: number): number[] {
  return box('avc1', [
    0, 0, 0, 0, 0, 0,
    ...u16(1),
    ...new Array(16).fill(0),
    ...u16(width),
    ...u16(height),
    0, 0, 0, 0,
  ]);
}

export function hdMovie(
  sampleCount: number,
  width = 1080,
  height = 1920,
): Uint8Array<ArrayBuffer> {
  const timescale = 30_000;
  const delta = 1001;

  const stsd = fullBox('stsd', [...u32(1), ...videoEntry(width, height)]);
  const stts = fullBox('stts', [...u32(1), ...u32(sampleCount), ...u32(delta)]);
  const stbl = box('stbl', [...stsd, ...stts]);
  const mdhd = fullBox('mdhd', [
    ...u32(0),
    ...u32(0),
    ...u32(timescale),
    ...u32(sampleCount * delta),
    0, 0, 0, 0,
  ]);
  const trak = box('trak', box('mdia', [...mdhd, ...box('minf', stbl)]));
  // The movie header only has to be readable by the duration check, which
  // expects a version 0 box of 108 bytes with its timescale at +16.
  const mvhd = box('mvhd', [
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...u32(1000),
    ...u32(sampleCount * 33),
    ...new Array(80).fill(0),
  ]);

  const ftyp = box('ftyp', [...ascii('isom'), ...u32(0), ...ascii('mp41')]);
  return new Uint8Array([...ftyp, ...box('moov', [...mvhd, ...trak])]);
}
