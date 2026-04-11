/**
 * Shrink re-encoded images before multipart upload (non-images are passed through unchanged).
 */

const DEFAULT_MAX_DIM = 1920;
const DEFAULT_JPEG_QUALITY = 0.84;

/**
 * @param {File} file
 * @returns {Promise<ImageBitmap | HTMLImageElement>}
 */
async function decodeImageFile(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* HEIC or unsupported — try <img> */
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

/**
 * @param {ImageBitmap | HTMLImageElement} source
 */
function releaseDecoded(source) {
  if (source && typeof source.close === 'function') source.close();
}

/**
 * @param {File} file
 * @param {{ maxDimension?: number, jpegQuality?: number, skipBelowBytes?: number }} [options]
 * @returns {Promise<File>}
 */
export async function prepareImageFileForUpload(file, options = {}) {
  const maxDim = options.maxDimension ?? DEFAULT_MAX_DIM;
  const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const skipBelowBytes = options.skipBelowBytes ?? 450 * 1024;

  if (!file || !file.type.startsWith('image/')) return file;
  if (file.type === 'image/svg+xml') return file;

  let decoded;
  try {
    decoded = await decodeImageFile(file);
  } catch {
    return file;
  }

  try {
    const iw = decoded.width;
    const ih = decoded.height;
    if (!(iw > 0 && ih > 0)) return file;

    const needsShrink = iw > maxDim || ih > maxDim;
    const largeFile = file.size > skipBelowBytes;
    if (!needsShrink && !largeFile) {
      return file;
    }

    let w = iw;
    let h = ih;
    if (needsShrink) {
      if (w >= h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(decoded, 0, 0, w, h);

    const blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', jpegQuality);
    });
    if (!blob || blob.size === 0) return file;

    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    releaseDecoded(decoded);
  }
}

/**
 * @param {File[]} files
 * @returns {Promise<File[]>}
 */
export async function prepareImageFilesForUpload(files) {
  if (!files?.length) return [];
  return Promise.all(files.map((f) => prepareImageFileForUpload(f)));
}

/** Alias: same pipeline for mixed photo + document picks before upload. */
export const prepareFilesForUpload = prepareImageFilesForUpload;
