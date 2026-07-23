/**
 * Client helpers for PUT/GET mind archive snapshot on the Express host (see server/mindSnapshotSync.js).
 */
import { buildMindArchiveBlob, importMindArchive } from './mindBackup';

/**
 * @typedef {'downloading' | 'decoding' | 'parsing' | 'saving'} MindSnapshotPullProgressPhase
 * @typedef {(phase: MindSnapshotPullProgressPhase, detail?: { bytes?: number, totalBytes?: number, lines?: number }) => void} MindSnapshotPullOnProgress
 */

/**
 * Read GET body. Uses `arrayBuffer()` only — some WebKit / PWA clients misbehave with
 * `response.body.getReader()` + assembly (hang, truncated body, or import failures) while
 * `arrayBuffer()` remains reliable. Progress still reports total from Content-Length when present.
 * @param {Response} res
 * @param {MindSnapshotPullOnProgress} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
async function readSnapshotResponseBody(res, onProgress) {
  const rawLen = res.headers.get('content-length');
  const parsed = rawLen ? parseInt(rawLen, 10) : NaN;
  const totalBytes = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;

  onProgress?.('downloading', { bytes: 0, totalBytes });
  const buf = await res.arrayBuffer();
  onProgress?.('downloading', {
    bytes: buf.byteLength,
    totalBytes: totalBytes ?? buf.byteLength,
  });
  return buf;
}

const LS_TOKEN = 'mind_snapshot_sync_token';
const LS_LAST_REMOTE = 'mind_snapshot_last_remote_updated_at';
const LS_LAST_PUSHED = 'mind_snapshot_last_pushed_at';

export function getMindSnapshotSyncToken() {
  try {
    return localStorage.getItem(LS_TOKEN) || '';
  } catch {
    return '';
  }
}

/** @param {string} token */
export function setMindSnapshotSyncToken(token) {
  try {
    const t = String(token || '').trim();
    if (t) localStorage.setItem(LS_TOKEN, t);
    else localStorage.removeItem(LS_TOKEN);
  } catch {
    /* ignore */
  }
}

function authHeaders() {
  const t = getMindSnapshotSyncToken().trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/**
 * @returns {Promise<{ exists: boolean, updatedAt: string | null, sizeBytes: number, contentSha256?: string }>}
 */
export async function fetchMindSnapshotMeta() {
  const res = await fetch('/api/mind-snapshot/meta', { headers: { ...authHeaders() } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
  }
  return data;
}

/**
 * @returns {Promise<{ ok: true, updatedAt?: string, sizeBytes?: number } | { ok: false, error: string }>}
 */
export async function pushMindSnapshotToServer() {
  try {
    const result = await buildMindArchiveBlob({ includeAppPrefs: false, skipFilePicker: true });
    if (result.kind !== 'blob') {
      return { ok: false, error: 'Export did not produce a blob (try again).' };
    }
    const res = await fetch('/api/mind-snapshot', {
      method: 'PUT',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/octet-stream',
      },
      body: result.blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 413) {
        const sz = typeof result.blob?.size === 'number' ? ` (~${Math.max(1, Math.round(result.blob.size / (1024 * 1024)))} MB)` : '';
        return {
          ok: false,
          error: `HTTP 413: upload too large${sz}. On the PC, set MIND_SNAPSHOT_UPLOAD_LIMIT in .env (e.g. 1gb) and restart; if you use nginx/Caddy, raise its body size limit too.`,
        };
      }
      return { ok: false, error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}` };
    }
    const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
    if (updatedAt) {
      try {
        localStorage.setItem(LS_LAST_PUSHED, updatedAt);
        localStorage.setItem(LS_LAST_REMOTE, updatedAt);
      } catch {
        /* ignore */
      }
    }
    return { ok: true, updatedAt: updatedAt || undefined, sizeBytes: data.sizeBytes };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * @param {{ onProgress?: MindSnapshotPullOnProgress }} [options]
 * @returns {Promise<{ ok: true, keyCount: number } | { ok: false, error: string }>}
 */
export async function pullMindSnapshotFromServer(options = {}) {
  const { onProgress } = options;
  try {
    const res = await fetch('/api/mind-snapshot', { headers: { ...authHeaders() } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `HTTP ${res.status}`,
      };
    }
    const buf = await readSnapshotResponseBody(res, onProgress);
    const importResult = await importMindArchive(buf, { onProgress });
    if (!importResult.ok) {
      return { ok: false, error: importResult.error || 'Import failed' };
    }
    try {
      const meta = await fetchMindSnapshotMeta();
      if (meta.updatedAt) localStorage.setItem(LS_LAST_REMOTE, meta.updatedAt);
    } catch {
      /* ignore */
    }
    return { ok: true, keyCount: importResult.keyCount ?? 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function getMindSnapshotLocalHints() {
  try {
    return {
      lastRemoteUpdatedAt: localStorage.getItem(LS_LAST_REMOTE),
      lastPushedAt: localStorage.getItem(LS_LAST_PUSHED),
    };
  } catch {
    return { lastRemoteUpdatedAt: null, lastPushedAt: null };
  }
}

/**
 * True if server reports a snapshot and its updatedAt is newer than the last time we recorded pulling/pushing.
 * @param {{ exists?: boolean, updatedAt?: string | null }} meta
 */
export function serverSnapshotLooksNewerThanRecorded(meta) {
  if (!meta?.exists || !meta.updatedAt) return false;
  const last = getMindSnapshotLocalHints().lastRemoteUpdatedAt;
  if (!last) return true;
  return new Date(meta.updatedAt).getTime() > new Date(last).getTime();
}

/**
 * For background auto-pull: only if we have a prior pull/push timestamp (avoids overwriting a never-synced browser).
 * @param {{ exists?: boolean, updatedAt?: string | null }} meta
 */
export function shouldAutoPullRemoteSnapshot(meta) {
  if (!meta?.exists || !meta.updatedAt) return false;
  const last = getMindSnapshotLocalHints().lastRemoteUpdatedAt;
  if (!last) return false;
  return new Date(meta.updatedAt).getTime() > new Date(last).getTime();
}
