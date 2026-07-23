import { getKvSync, snapshotKvCache } from './browserStorage';
import {
  DEFAULT_GRAPH_SESSION_ID,
  graphPipelineUiLegacyFallbackKeyForSessionId,
  graphPipelineUiStorageKeyForSessionId,
} from './graphPipelineSessionScope';
import { repairCooperativePipelineCheckpoint } from './graphPipelineStore';
import { getGraphPipelineSessionRegistry, getLastOpenedGraphPipelineSessionId } from './graphPipelineSessionRegistry';

const GRAPH_UI_V2_SESSION_PREFIX = 'mybrain_graph_pipeline_ui_v2__s_';
const GRAPH_UI_V1_SESSION_PREFIX = 'mybrain_graph_pipeline_ui_v1__s_';

/**
 * Session ids that have a persisted graph UI blob in KV (`__s_<id>` keys), including sessions **not**
 * listed in the graph registry (e.g. after import or cleared registry). Without this, Resume all
 * never scans those blobs and cooperative checkpoints are invisible.
 * @returns {string[]}
 */
export function listGraphSessionIdsFromGraphUiKvKeys() {
  if (typeof window === 'undefined') return [];
  const out = new Set();
  try {
    const snap = snapshotKvCache();
    for (const k of Object.keys(snap)) {
      if (k.startsWith(GRAPH_UI_V2_SESSION_PREFIX)) {
        const id = k.slice(GRAPH_UI_V2_SESSION_PREFIX.length).trim();
        if (id) out.add(id);
      } else if (k.startsWith(GRAPH_UI_V1_SESSION_PREFIX)) {
        const id = k.slice(GRAPH_UI_V1_SESSION_PREFIX.length).trim();
        if (id) out.add(id);
      }
    }
  } catch {
    /* ignore */
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Same candidate ordering as legacy single-session discovery (registry + default). */
export function listGraphSessionIdsForCheckpointScan() {
  if (typeof window === 'undefined') return [];

  const seen = new Set();
  /** @type {string[]} */
  const candidates = [];

  const last = getLastOpenedGraphPipelineSessionId();
  if (last) {
    candidates.push(last);
    seen.add(last);
  }

  for (const row of getGraphPipelineSessionRegistry()) {
    const id = String(row?.id || '').trim();
    if (!id || seen.has(id)) continue;
    candidates.push(id);
    seen.add(id);
  }

  for (const id of listGraphSessionIdsFromGraphUiKvKeys()) {
    if (!id || seen.has(id)) continue;
    candidates.push(id);
    seen.add(id);
  }

  if (!seen.has(DEFAULT_GRAPH_SESSION_ID)) {
    candidates.push(DEFAULT_GRAPH_SESSION_ID);
  }

  return candidates;
}

/**
 * All graph session ids whose persisted graph UI KV contains a repairable cooperative-pause checkpoint.
 * Sorted by checkpoint.savedAt descending (newest first); missing savedAt treated as 0.
 * @returns {string[]}
 */
export function listGraphSessionIdsWithPersistedCooperativeCheckpoints() {
  if (typeof window === 'undefined') return [];

  /** @type {{ sessionId: string, savedAt: number }[]} */
  const found = [];

  for (const sessionId of listGraphSessionIdsForCheckpointScan()) {
    const pk = graphPipelineUiStorageKeyForSessionId(sessionId);
    if (!pk) continue;
    let raw = getKvSync(pk);
    const fk = graphPipelineUiLegacyFallbackKeyForSessionId(sessionId);
    if (!raw && fk && fk !== pk) raw = getKvSync(fk);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const ck = repairCooperativePipelineCheckpoint(parsed?.pipelineCheckpoint, parsed?.lastSharedMemory);
      if (!ck) continue;
      const savedAt = Number(ck.savedAt);
      found.push({
        sessionId,
        savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0,
      });
    } catch {
      /* ignore */
    }
  }

  found.sort((a, b) => b.savedAt - a.savedAt);
  return found.map((x) => x.sessionId);
}

/**
 * Find a graph session id whose persisted graph UI KV contains a valid cooperative-pause checkpoint.
 * Returns the newest checkpoint first (see {@link listGraphSessionIdsWithPersistedCooperativeCheckpoints}).
 * @returns {string | null}
 */
export function findGraphSessionIdWithPersistedCooperativeCheckpoint() {
  const all = listGraphSessionIdsWithPersistedCooperativeCheckpoints();
  return all[0] ?? null;
}
