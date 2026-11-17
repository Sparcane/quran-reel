/**
 * Sharing a finished video, with an honest fallback.
 *
 * On a phone the Web Share API hands the file to whatever the user likes. On a
 * desktop browser that cannot share files — and inside Electron, where the Web
 * Share sheet is absent — the file is offered as a download instead. Electron's
 * packaging plan can install a `revealInFolder` bridge so the saved file is
 * shown where it lives; until then, a plain download is still a real result.
 *
 * Every collaborator is a seam. The pure decision logic takes an environment,
 * so the capability check, the share call, the download and the native bridge
 * can all be exercised without a real share sheet or a real device.
 */

import type { RenderedVideo } from '@quran/render';

export type ShareResult = 'shared' | 'downloaded' | 'cancelled';

/** Data passed to the platform share sheet. */
export interface SharePayload {
  files: File[];
  title: string;
}

/** The fully resolved collaborators `shareVideo` uses. */
export interface ShareEnvironment {
  canShare(file: File): boolean;
  share(payload: SharePayload): Promise<void>;
  download(file: File, title: string): void;
  electron: boolean;
  /** Installed by the Electron preload bridge; absent on web and in tests. */
  revealInFolder?: (file: File) => void;
}

/**
 * Test-friendly controls layered over the environment. `canShare` and
 * `shareThrows` mirror the plan's short option form; the other keys replace a
 * collaborator outright.
 */
export interface ShareOptions extends Partial<Omit<ShareEnvironment, 'canShare'>> {
  canShare?: boolean | ((file: File) => boolean);
  /** Force the share call to reject with an error of this name. */
  shareThrows?: string;
}

function errorNamed(name: string): Error {
  const error = new Error(`share: ${name}`);
  error.name = name;
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function defaultCanShare(file: File): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const canShare = (nav as { canShare?: (data: { files: File[] }) => boolean } | undefined)
    ?.canShare;
  return typeof canShare === 'function' && canShare({ files: [file] });
}

async function defaultShare(payload: SharePayload): Promise<void> {
  const share = (navigator as Navigator & { share?: (data: SharePayload) => Promise<void> }).share;
  if (typeof share !== 'function') throw errorNamed('AbortError');
  await share(payload);
}

function defaultDownload(file: File, _title: string): void {
  if (typeof document === 'undefined') return;
  const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
  const anchor = document.createElement('a');
  anchor.download = file.name;
  if (url) anchor.href = url;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (url) {
    // Let the browser start the download before the blob URL disappears.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function detectElectron(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } };
  if (/electron/i.test(nav.userAgent)) return true;
  return (nav.userAgentData?.brands ?? []).some((brand) => /electron/i.test(brand.brand));
}

function nativeRevealInFolder(): ((file: File) => void) | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as Window & {
    quranStudio?: { revealInFolder?: (file: File) => void };
  }).quranStudio?.revealInFolder;
  return typeof bridge === 'function' ? bridge : undefined;
}

function resolve(options: ShareOptions): ShareEnvironment {
  const canShare = (file: File): boolean => {
    if (typeof options.canShare === 'function') return options.canShare(file);
    if (typeof options.canShare === 'boolean') return options.canShare;
    return defaultCanShare(file);
  };

  const share = options.shareThrows
    ? async (_payload: SharePayload): Promise<void> => {
        throw errorNamed(options.shareThrows as string);
      }
    : (options.share ?? defaultShare);

  return {
    canShare,
    share,
    download: options.download ?? defaultDownload,
    electron: options.electron ?? detectElectron(),
    revealInFolder: options.revealInFolder ?? nativeRevealInFolder(),
  };
}

/**
 * Shares a file, downloads it when sharing is not possible, and stays quiet
 * when the user dismisses the share sheet. A genuine share error is not
 * reported as success: the file is downloaded and `'downloaded'` is returned.
 */
export async function shareVideo(
  file: File,
  title: string,
  options: ShareOptions = {},
): Promise<ShareResult> {
  const environment = resolve(options);

  // Electron has no file share sheet; show the saved file in its folder.
  if (environment.electron) {
    if (environment.revealInFolder) {
      environment.revealInFolder(file);
      return 'shared';
    }
    // The packaging bridge is not installed yet: a download is still honest.
    environment.download(file, title);
    return 'downloaded';
  }

  if (!environment.canShare(file)) {
    environment.download(file, title);
    return 'downloaded';
  }

  try {
    await environment.share({ files: [file], title });
    return 'shared';
  } catch (error) {
    if (isAbortError(error)) return 'cancelled';
    environment.download(file, title);
    return 'downloaded';
  }
}

/** Wraps the renderer's blob into a named file the share sheet can accept. */
export function videoToFile(video: RenderedVideo, id: string): File {
  return new File([video.blob], `quran-${id}.${video.container}`, {
    type: video.blob.type || (video.container === 'mp4' ? 'video/mp4' : 'video/webm'),
  });
}
