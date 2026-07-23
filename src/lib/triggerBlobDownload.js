import { isIOSDevice } from './mobilePlatform';

/** Reject Web Share on iPhone above this size to avoid WebKit OOM (compressed backup may be smaller). */
export const IOS_MIND_EXPORT_MAX_SHARE_BYTES = 48 * 1024 * 1024;

/**
 * Programmatic file download. Defer click/revoke so WebKit can finish with the blob URL.
 * On iOS this path is unreliable for large files; prefer {@link shareOrDownloadBlob}.
 */
export function triggerBlobDownload(blob, filename) {
  if (typeof window === 'undefined' || !blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  setTimeout(() => {
    try {
      a.click();
    } finally {
      a.remove();
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }, 60_000);
    }
  }, 0);
}

/**
 * iOS WebKit often crashes or no-ops on `<a download>` + blob URLs. Sharing a File opens the
 * system sheet (Save to Files, AirDrop, …). Desktop keeps using a normal download.
 * @returns {'shared' | 'download' | 'cancelled'}
 */
export async function shareOrDownloadBlob(blob, filename, mimeType = 'application/json') {
  if (typeof window === 'undefined' || !blob) return 'download';

  const ios = isIOSDevice();
  const effectiveMime = filename.endsWith('.gz') ? 'application/gzip' : mimeType;
  // Web Share with files requires a secure context (HTTPS or localhost). Plain http:// LAN URLs
  // cannot use this path; download fallback is weaker on iOS WebKit.
  const secureOk = typeof window === 'undefined' || window.isSecureContext;
  const canShareFiles =
    ios &&
    secureOk &&
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof File !== 'undefined';

  if (canShareFiles) {
    try {
      if (typeof blob.size === 'number' && blob.size > IOS_MIND_EXPORT_MAX_SHARE_BYTES) {
        throw new Error(
          `Mind backup is too large (${Math.round(blob.size / (1024 * 1024))} MB) to share on iPhone. Open the app on a desktop browser and use Export backup there, or reduce stored data.`
        );
      }
      // Space work across frames so WebKit can GC / paint before File + share (reduces OOM / watchdog kills).
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => requestAnimationFrame(() => r()));
      await new Promise((r) => requestAnimationFrame(() => r()));
      await new Promise((r) => setTimeout(r, 0));
      const file = new File([blob], filename, { type: effectiveMime, lastModified: Date.now() });
      const data = { files: [file] };
      if (typeof navigator.canShare === 'function' && !navigator.canShare(data)) {
        throw new Error('cannot share this file');
      }
      await navigator.share(data);
      return 'shared';
    } catch (e) {
      if (e && typeof e === 'object' && e.name === 'AbortError') {
        return 'cancelled';
      }
      console.warn('[shareOrDownloadBlob] share failed, falling back to download', e);
    }
  }

  triggerBlobDownload(blob, filename);
  return 'download';
}
