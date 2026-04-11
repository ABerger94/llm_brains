import { describeNetworkOrOfflineError } from './apiReachability';
import {
  fileFromStagedOpfs,
  isOpfsAvailable,
  OPFS_UPLOAD_STAGING_THRESHOLD_BYTES,
  removeStagedUpload,
  stageLargeFileForUpload,
} from './opfsStorage';

const DEFAULT_UPLOAD_TIMEOUT_MS = 180_000;
const BATCH_SIZE = 24;

/**
 * @param {File} file
 * @returns {Promise<{ uploadFile: File, staged: { pathSegments: string[], fileName: string } | null }>}
 */
async function resolveFileForUpload(file) {
  if (!file || file.size < OPFS_UPLOAD_STAGING_THRESHOLD_BYTES || !isOpfsAvailable()) {
    return { uploadFile: file, staged: null };
  }
  const staged = await stageLargeFileForUpload(file);
  if (!staged) return { uploadFile: file, staged: null };
  const uploadFile = await fileFromStagedOpfs(staged);
  return { uploadFile, staged };
}

/**
 * POST one batch of files (max BATCH_SIZE) to the API.
 *
 * @param {File[]} files
 * @param {{ timeoutMs?: number }} [options]
 */
async function postUploadAttachmentsBatch(files, options = {}) {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_UPLOAD_TIMEOUT_MS;

  /** @type {Array<{ pathSegments: string[], fileName: string } | null>} */
  const stagedSlots = [];
  const body = new FormData();
  try {
    for (const f of files) {
      const { uploadFile, staged } = await resolveFileForUpload(f);
      stagedSlots.push(staged);
      body.append('attachments', uploadFile);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let res;
    try {
      res = await fetch('/api/uploads/attachments', { method: 'POST', body, signal: ctrl.signal });
    } catch (e) {
      if (e && typeof e === 'object' && e.name === 'AbortError') {
        throw new Error(
          `Upload timed out after ${Math.round(timeoutMs / 1000)}s. Try fewer files or check your connection.`
        );
      }
      throw new Error(describeNetworkOrOfflineError(e));
    } finally {
      clearTimeout(timer);
    }

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        payload.error || (res.status === 413 ? 'File too large for the server limit (12MB each).' : 'Upload failed.');
      throw new Error(msg);
    }
    const attachments = payload.attachments || [];
    for (const s of stagedSlots) {
      if (s) await removeStagedUpload(s);
    }
    return attachments;
  } catch (err) {
    for (const s of stagedSlots) {
      if (s) await removeStagedUpload(s);
    }
    throw err;
  }
}

/**
 * Upload any files (images are shrunk client-side in FileAttachButton / prepareFilesForUpload).
 * Splits into multiple requests when there are more than 24 files.
 *
 * @param {File[]} files
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Array<{ id: string, filename: string, mimeType: string, size: number, kind?: string }>>}
 */
export async function postUploadAttachments(files, options = {}) {
  if (!files?.length) return [];
  const out = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const slice = files.slice(i, i + BATCH_SIZE);
    out.push(...(await postUploadAttachmentsBatch(slice, options)));
  }
  return out;
}

/** @deprecated Use {@link postUploadAttachments}. */
export async function postUploadImages(files, options = {}) {
  return postUploadAttachments(files, options);
}
