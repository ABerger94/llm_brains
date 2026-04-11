/**
 * Origin Private File System — large binary staging (100+ MB capable via streaming writes).
 */

const MYBRAIN_DIR = 'mybrain';
const OPFS_DIR = 'opfs';

/** Files at or above this size use OPFS staging before upload when supported. */
export const OPFS_UPLOAD_STAGING_THRESHOLD_BYTES = 16 * 1024 * 1024;

export function isOpfsAvailable() {
  return (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

/**
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function getMybrainOpfsRoot() {
  const root = await navigator.storage.getDirectory();
  const mybrain = await root.getDirectoryHandle(MYBRAIN_DIR, { create: true });
  return mybrain.getDirectoryHandle(OPFS_DIR, { create: true });
}

/**
 * @param {string[]} pathSegments directory path under mybrain/opfs
 * @param {string} fileName
 * @returns {Promise<FileSystemFileHandle>}
 */
async function getOrCreateFile(pathSegments, fileName) {
  let dir = await getMybrainOpfsRoot();
  for (const seg of pathSegments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir.getFileHandle(fileName, { create: true });
}

/**
 * Stream a Blob into OPFS (avoids loading entire blob into a single ArrayBuffer when possible).
 * @param {string[]} pathSegments
 * @param {string} fileName
 * @param {Blob} blob
 */
export async function writeBlobToOpfs(pathSegments, fileName, blob) {
  const fh = await getOrCreateFile(pathSegments, fileName);
  const writable = await fh.createWritable();
  await blob.stream().pipeTo(writable);
}

/**
 * @param {string[]} pathSegments
 * @param {string} fileName
 * @returns {Promise<File>}
 */
export async function getFileFromOpfs(pathSegments, fileName) {
  let dir = await getMybrainOpfsRoot();
  for (const seg of pathSegments) {
    dir = await dir.getDirectoryHandle(seg);
  }
  const fh = await dir.getFileHandle(fileName);
  return fh.getFile();
}

/**
 * @param {string[]} pathSegments
 * @param {string} fileName
 */
export async function deleteOpfsFile(pathSegments, fileName) {
  try {
    let dir = await getMybrainOpfsRoot();
    for (const seg of pathSegments) {
      dir = await dir.getDirectoryHandle(seg);
    }
    await dir.removeEntry(fileName);
  } catch {
    /* missing */
  }
}

/**
 * @param {File} file
 * @returns {Promise<{ pathSegments: string[], fileName: string } | null>}
 */
export async function stageLargeFileForUpload(file) {
  if (!isOpfsAvailable() || !file || file.size < OPFS_UPLOAD_STAGING_THRESHOLD_BYTES) {
    return null;
  }
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  const fileName = `${id}_${file.name.replace(/[/\\?%*:|"<>]/g, '_')}`;
  const pathSegments = ['uploads', 'staging'];
  await writeBlobToOpfs(pathSegments, fileName, file);
  return { pathSegments, fileName };
}

/**
 * @param {{ pathSegments: string[], fileName: string }} staged
 * @returns {Promise<File>}
 */
export async function fileFromStagedOpfs(staged) {
  const f = await getFileFromOpfs(staged.pathSegments, staged.fileName);
  return f;
}

/**
 * @param {{ pathSegments: string[], fileName: string }} staged
 */
export async function removeStagedUpload(staged) {
  await deleteOpfsFile(staged.pathSegments, staged.fileName);
}

/**
 * Delete all files under `mybrain/opfs` (call on full mind wipe).
 */
export async function wipeMybrainOpfsSubtree() {
  if (!isOpfsAvailable()) return;
  try {
    const root = await navigator.storage.getDirectory();
    let mybrain;
    try {
      mybrain = await root.getDirectoryHandle(MYBRAIN_DIR);
    } catch {
      return;
    }
    try {
      await mybrain.removeEntry(OPFS_DIR, { recursive: true });
    } catch {
      /* absent */
    }
  } catch {
    /* ignore */
  }
}
