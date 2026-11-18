/**
 * The storable form of a finished video.
 *
 * A Blob is not reliably carried by the structured clone of every WebView, so
 * the two device stores — the render queue and the history — keep the bytes
 * with an explicit MIME type and rebuild the Blob when they read the record
 * back. One definition means adding a field to `RenderedVideo` cannot update
 * one copy of that flattening and forget the other.
 */

import type { RenderedVideo } from './types';

export interface StoredVideo {
  bytes: ArrayBuffer;
  mime: string;
  durationSec: number;
  width: number;
  height: number;
  container: RenderedVideo['container'];
  videoCodec: string;
}

export async function toStoredVideo(video: RenderedVideo): Promise<StoredVideo> {
  return {
    bytes: await video.blob.arrayBuffer(),
    mime: video.blob.type,
    durationSec: video.durationSec,
    width: video.width,
    height: video.height,
    container: video.container,
    videoCodec: video.videoCodec,
  };
}

export function fromStoredVideo(record: StoredVideo): RenderedVideo {
  return {
    blob: new Blob([record.bytes], { type: record.mime }),
    durationSec: record.durationSec,
    width: record.width,
    height: record.height,
    container: record.container,
    videoCodec: record.videoCodec,
  };
}
