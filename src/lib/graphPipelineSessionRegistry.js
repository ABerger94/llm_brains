import { flushKvWrites, getKvSync, kvRefreshKeysFromDb, removeKvSync, setKvSync } from './browserStorage';
import { DEFAULT_GRAPH_SESSION_ID } from './graphPipelineSessionScope';

const LAST_OPENED_SESSION_KEY = 'mybrain_graph_last_session_v1';

const REGISTRY_KEY = 'mybrain_graph_pipeline_sessions_v1';
const CHANNEL_NAME = 'mybrain-graph-sessions';

/** Same-tab subscribers — KV uses IndexedDB + cache, so `storage` events do not fire here. */
const registrySubscribers = new Set();

/** Subscribers for last-opened session id (Resume link, header). */
const lastOpenedSubscribers = new Set();

function notifyLastOpenedSubscribers() {
  for (const fn of lastOpenedSubscribers) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Default display label for a freshly created `/graph-pipeline/:id` workspace (before first run renames it).
 * Kept in sync with {@link isGenericGraphSessionLabel}.
 */
export const NEW_GRAPH_PIPELINE_SESSION_LABEL = 'Untitled workspace';

/**
 * New workspace session id for `/graph-pipeline/:id`. Prefer `crypto.randomUUID` when available
 * (requires secure context in some browsers); otherwise a unique URL-safe string.
 * @returns {string}
 */
export function createGraphPipelineSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `gs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Subscribe to changes for {@link getLastOpenedGraphPipelineSessionId} (same-tab).
 * @param {() => void} listener
 * @returns {() => void}
 */
export function subscribeGraphPipelineLastOpened(listener) {
  if (typeof window === 'undefined') return () => {};
  lastOpenedSubscribers.add(listener);
  return () => lastOpenedSubscribers.delete(listener);
}

/** Legacy `default` row for scheduled links and older data. Idempotent. */
export function ensureDefaultGraphPipelineSessionInRegistry() {
  upsertGraphPipelineSession({
    id: DEFAULT_GRAPH_SESSION_ID,
    label: 'Default',
    isProcessing: false,
  });
}

/**
 * Create a new session id, add it to the registry, set last-opened, and return the id.
 * Caller should navigate to `/graph-pipeline/${encodeURIComponent(id)}`.
 * @returns {string}
 */
export function prepareNewGraphPipelineSession() {
  const id = createGraphPipelineSessionId();
  upsertGraphPipelineSession({
    id,
    label: NEW_GRAPH_PIPELINE_SESSION_LABEL,
    isProcessing: false,
  });
  setLastOpenedGraphPipelineSessionId(id);
  return id;
}

/**
 * Call when opening `/graph-pipeline/:id`: updates last-opened and ensures the id exists in the registry
 * **only if missing** (does not bump `updatedAt` on every visit — avoids list reorder thrash).
 * @param {string} sessionId
 */
export function registerOpenGraphPipelineWorkspace(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  setLastOpenedGraphPipelineSessionId(sid);
  const rows = readRegistryRaw();
  const exists = rows.some((r) => r && String(r.id).trim() === sid);
  if (exists) return;
  const label = sid === DEFAULT_GRAPH_SESSION_ID ? 'Default' : NEW_GRAPH_PIPELINE_SESSION_LABEL;
  upsertGraphPipelineSession({ id: sid, label, isProcessing: false });
}

function notifyRegistrySubscribers() {
  for (const fn of registrySubscribers) {
    try {
      fn();
    } catch {
      /* ignore subscriber errors */
    }
  }
}

/** Generic list labels — do not use as “first thread” anchor when seeding threadRootLabel. */
const GENERIC_SESSION_LABELS = new Set([
  'Graph session',
  'New graph session',
  NEW_GRAPH_PIPELINE_SESSION_LABEL,
  'Default',
  'Default (legacy transcript)',
]);

/**
 * @param {string} lab
 * @returns {boolean}
 */
export function isGenericGraphSessionLabel(lab) {
  return GENERIC_SESSION_LABELS.has(String(lab || '').trim());
}

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   threadRootLabel?: string,
 *   createdAt: number,
 *   updatedAt: number,
 *   isProcessing?: boolean
 * }} GraphSessionRow */

/** Stable empty list for SSR and empty registry — `useSyncExternalStore` requires referentially stable snapshots when data is unchanged. */
const EMPTY_REGISTRY_SNAPSHOT = Object.freeze([]);

/** @type {string | null | undefined} */
let registrySnapshotKvKey;
/** @type {typeof EMPTY_REGISTRY_SNAPSHOT | GraphSessionRow[]} */
let registrySnapshotCache;

function readRegistryRaw() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = getKvSync(REGISTRY_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function writeRegistry(rows) {
  if (typeof window === 'undefined') return;
  try {
    setKvSync(REGISTRY_KEY, JSON.stringify(rows));
  } catch {
    /* quota */
  }
  registrySnapshotKvKey = undefined;
  registrySnapshotCache = undefined;
  notifyRegistrySubscribers();
  try {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    ch.postMessage({ type: 'registry-updated' });
    ch.close();
  } catch {
    /* BroadcastChannel unsupported */
  }
}

/** @returns {GraphSessionRow[]} */
export function getGraphPipelineSessionRegistry() {
  if (typeof window === 'undefined') {
    return EMPTY_REGISTRY_SNAPSHOT;
  }
  const kvRaw = getKvSync(REGISTRY_KEY) ?? null;
  if (kvRaw === registrySnapshotKvKey && registrySnapshotCache) {
    return registrySnapshotCache;
  }
  registrySnapshotKvKey = kvRaw;
  const rows = readRegistryRaw()
    .filter((r) => r && typeof r.id === 'string' && r.id.trim())
    .map((r) => ({
      id: String(r.id).trim(),
      label: typeof r.label === 'string' ? r.label : 'Graph session',
      threadRootLabel: typeof r.threadRootLabel === 'string' ? r.threadRootLabel : '',
      createdAt: Number(r.createdAt) || 0,
      updatedAt: Number(r.updatedAt) || 0,
      isProcessing: Boolean(r.isProcessing),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  registrySnapshotCache = rows.length ? rows : EMPTY_REGISTRY_SNAPSHOT;
  return registrySnapshotCache;
}

/**
 * Upsert session row (merge by id).
 * @param {Partial<GraphSessionRow> & { id: string, seedFirstThreadLabel?: boolean }} partial
 */
export function upsertGraphPipelineSession(partial) {
  const id = String(partial.id || '').trim();
  if (!id) return;
  const rows = readRegistryRaw();
  const now = Date.now();
  const idx = rows.findIndex((r) => r && String(r.id).trim() === id);
  const prev = idx >= 0 ? rows[idx] : {};
  const prevLabel =
    typeof prev.label === 'string' ? prev.label : id === DEFAULT_GRAPH_SESSION_ID ? 'Default' : 'Graph session';
  const nextLabel = typeof partial.label === 'string' ? partial.label : prevLabel;
  const prevTrRaw = typeof prev.threadRootLabel === 'string' ? String(prev.threadRootLabel).trim() : '';
  let threadRootLabel = prevTrRaw;
  if (typeof partial.threadRootLabel === 'string') {
    threadRootLabel = partial.threadRootLabel.trim().slice(0, 160);
  } else if (partial.seedFirstThreadLabel === true) {
    const lab = String(nextLabel || '').trim();
    if (!prevTrRaw && lab && !isGenericGraphSessionLabel(lab)) {
      threadRootLabel = lab.slice(0, 160);
    }
  }
  const next = {
    id,
    label: nextLabel,
    threadRootLabel,
    createdAt: Number(prev.createdAt) || now,
    updatedAt: now,
    isProcessing: typeof partial.isProcessing === 'boolean' ? partial.isProcessing : Boolean(prev.isProcessing),
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push({ ...next, createdAt: now });
  writeRegistry(rows);
}

/**
 * Merge into an existing registry row only. Used when a session was removed from the list and must not reappear
 * (e.g. abort/stale-heal after the user deleted the workspace from the registry).
 * @param {Partial<GraphSessionRow> & { id: string, seedFirstThreadLabel?: boolean }} partial
 * @returns {boolean} true if a row was updated
 */
export function patchGraphPipelineSessionIfInRegistry(partial) {
  const id = String(partial.id || '').trim();
  if (!id) return false;
  const rows = readRegistryRaw();
  const idx = rows.findIndex((r) => r && String(r.id).trim() === id);
  if (idx < 0) return false;
  const prev = rows[idx];
  const now = Date.now();
  const prevLabel =
    typeof prev.label === 'string' ? prev.label : id === DEFAULT_GRAPH_SESSION_ID ? 'Default' : 'Graph session';
  const nextLabel = typeof partial.label === 'string' ? partial.label : prevLabel;
  const prevTrRaw = typeof prev.threadRootLabel === 'string' ? String(prev.threadRootLabel).trim() : '';
  let threadRootLabel = prevTrRaw;
  if (typeof partial.threadRootLabel === 'string') {
    threadRootLabel = partial.threadRootLabel.trim().slice(0, 160);
  } else if (partial.seedFirstThreadLabel === true) {
    const lab = String(nextLabel || '').trim();
    if (!prevTrRaw && lab && !isGenericGraphSessionLabel(lab)) {
      threadRootLabel = lab.slice(0, 160);
    }
  }
  const next = {
    id,
    label: nextLabel,
    threadRootLabel,
    createdAt: Number(prev.createdAt) || now,
    updatedAt: now,
    isProcessing: typeof partial.isProcessing === 'boolean' ? partial.isProcessing : Boolean(prev.isProcessing),
  };
  rows[idx] = next;
  writeRegistry(rows);
  return true;
}

export function removeGraphPipelineSession(id) {
  const sid = String(id || '').trim();
  if (!sid) return;
  const rows = readRegistryRaw().filter((r) => String(r?.id || '').trim() !== sid);
  writeRegistry(rows);
  void flushKvWrites().catch(() => {
    /* ignore */
  });
  try {
    const last = getLastOpenedGraphPipelineSessionId();
    if (last === sid) {
      removeKvSync(LAST_OPENED_SESSION_KEY);
      notifyLastOpenedSubscribers();
    }
  } catch {
    /* ignore */
  }
}

export function subscribeGraphPipelineRegistry(listener) {
  if (typeof window === 'undefined') return () => {};
  registrySubscribers.add(listener);
  const onStorage = (e) => {
    if (e.key === REGISTRY_KEY || e.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  let ch = null;
  try {
    ch = new BroadcastChannel(CHANNEL_NAME);
    ch.onmessage = () => {
      void kvRefreshKeysFromDb([REGISTRY_KEY]).then(() => {
        registrySnapshotKvKey = undefined;
        listener();
      });
    };
  } catch {
    /* ignore */
  }
  return () => {
    registrySubscribers.delete(listener);
    window.removeEventListener('storage', onStorage);
    if (ch) {
      try {
        ch.close();
      } catch {
        /* ignore */
      }
    }
  };
}

export const GRAPH_PIPELINE_REGISTRY_KV_KEY = REGISTRY_KEY;

/** Last graph session opened in-app (for `/graph-pipeline` redirect). */
export function getLastOpenedGraphPipelineSessionId() {
  if (typeof window === 'undefined') return null;
  try {
    const v = getKvSync(LAST_OPENED_SESSION_KEY);
    return v && String(v).trim() ? String(v).trim() : null;
  } catch {
    return null;
  }
}

export function setLastOpenedGraphPipelineSessionId(id) {
  if (typeof window === 'undefined') return;
  const s = String(id || '').trim();
  if (!s) return;
  try {
    setKvSync(LAST_OPENED_SESSION_KEY, s);
  } catch {
    /* quota */
  }
  notifyLastOpenedSubscribers();
}
