/**
 * Tracks in-flight pipeline POST tokens for cooperative pause ({@link requestCooperativePauseForToken}).
 * Each interactive / background stream should register its `pauseToken` until the run ends.
 */

import { graphPipelineStore } from './graphPipelineStore.js';
import {
  peekConsciousnessStreamDraftForSession,
  peekGraphPipelineUiPersisted,
} from './graphPipelineCrossSessionPeek.js';
import { getGraphPipelineSessionRegistry } from './graphPipelineSessionRegistry.js';

/** @type {Map<string, { kind: string, id?: string, taskId?: string }>} */
const byToken = new Map();

/**
 * Same-origin mirror so any tab can POST pause for runs started elsewhere.
 * Per-token keys avoid lost-update races: the legacy single JSON array could drop entries when many
 * tabs registered concurrently (read–modify–write; last writer wins).
 */
const COOPERATIVE_PAUSE_TOKEN_KEY_PREFIX = 'mybrain_coop_pt_v1_';
/** @deprecated Migrated once to {@link COOPERATIVE_PAUSE_TOKEN_KEY_PREFIX} keys */
const COOPERATIVE_PAUSE_SHARED_STORAGE_KEY = 'mybrain_coop_pause_tokens_v1';

let legacyPauseTokenMirrorMigrated = false;

function migrateLegacySharedPauseTokenListOnce() {
  if (typeof window === 'undefined' || legacyPauseTokenMirrorMigrated) return;
  legacyPauseTokenMirrorMigrated = true;
  try {
    const raw = window.localStorage?.getItem(COOPERATIVE_PAUSE_SHARED_STORAGE_KEY);
    if (!raw) return;
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      window.localStorage?.removeItem(COOPERATIVE_PAUSE_SHARED_STORAGE_KEY);
      return;
    }
    if (!Array.isArray(arr)) {
      window.localStorage?.removeItem(COOPERATIVE_PAUSE_SHARED_STORAGE_KEY);
      return;
    }
    for (const x of arr) {
      const tok = String(x || '').trim();
      if (tok) {
        try {
          window.localStorage?.setItem(COOPERATIVE_PAUSE_TOKEN_KEY_PREFIX + tok, '1');
        } catch {
          /* quota */
        }
      }
    }
    window.localStorage?.removeItem(COOPERATIVE_PAUSE_SHARED_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function addSharedPauseToken(t) {
  const k = String(t || '').trim();
  if (!k) return;
  migrateLegacySharedPauseTokenListOnce();
  try {
    window.localStorage?.setItem(COOPERATIVE_PAUSE_TOKEN_KEY_PREFIX + k, '1');
  } catch {
    /* quota / private mode */
  }
}

function removeSharedPauseToken(t) {
  const k = String(t || '').trim();
  if (!k) return;
  migrateLegacySharedPauseTokenListOnce();
  try {
    window.localStorage?.removeItem(COOPERATIVE_PAUSE_TOKEN_KEY_PREFIX + k);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} token
 * @param {{ kind: string, id?: string, taskId?: string }} meta
 */
export function registerPipelinePauseToken(token, meta = { kind: 'unknown' }) {
  const t = String(token || '').trim();
  if (!t) return;
  byToken.set(t, { kind: meta.kind || 'unknown', id: meta.id, taskId: meta.taskId });
  addSharedPauseToken(t);
}

/**
 * @param {string} token
 */
export function unregisterPipelinePauseToken(token) {
  const t = String(token || '').trim();
  if (!t) return;
  byToken.delete(t);
  removeSharedPauseToken(t);
}

/** @returns {string[]} */
export function getRegisteredPipelinePauseTokens() {
  return [...byToken.keys()];
}

/**
 * Clear in-memory pause tokens and same-origin localStorage mirrors (e.g. after mind archive import).
 * Does not affect server-side streams.
 */
export function clearCooperativePauseRegistryAndMirror() {
  if (typeof window === 'undefined') return;
  byToken.clear();
  try {
    const ls = window.localStorage;
    if (!ls) return;
    const toRemove = [];
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (key && key.startsWith(COOPERATIVE_PAUSE_TOKEN_KEY_PREFIX)) toRemove.push(key);
    }
    for (const k of toRemove) {
      try {
        ls.removeItem(k);
      } catch {
        /* ignore */
      }
    }
    try {
      ls.removeItem(COOPERATIVE_PAUSE_SHARED_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

function sessionPeekLooksActiveForPause(s, peek, draft) {
  if (!peek) return false;
  return Boolean(s.isProcessing || peek.isRunning || draft.inFlight);
}

/**
 * Tokens to POST for cooperative pause in **this** tab: in-memory registry, current graph store when running,
 * and persisted cooperative tokens for **registry sessions that look active** (KV peek + draft).
 *
 * We intentionally do **not** union every `localStorage` mirror key here — that accumulated stale tokens from
 * finished runs (unregister missed) and inflated counts (e.g. connection-limit toasts showing “6” hooks for 3 rows).
 * Other tabs still POST their own hooks via {@link broadcastCooperativePauseAll}; mirrors remain until `unregisterPipelinePauseToken` removes them.
 * @returns {string[]}
 */
export function getCooperativePauseTokensForPauseRequests() {
  const tokens = new Set(getRegisteredPipelinePauseTokens());
  if (typeof window === 'undefined') return [...tokens];

  try {
    const gp = graphPipelineStore.getState();
    if (gp.isRunning && gp.cooperativePauseToken) {
      const t = String(gp.cooperativePauseToken).trim();
      if (t) tokens.add(t);
    }
  } catch {
    /* ignore */
  }

  try {
    const reg = getGraphPipelineSessionRegistry();
    for (const s of reg) {
      const sid = String(s?.id || '').trim();
      if (!sid) continue;
      const peek = peekGraphPipelineUiPersisted(sid);
      if (!peek) continue;
      const draft = peekConsciousnessStreamDraftForSession(sid);
      if (!sessionPeekLooksActiveForPause(s, peek, draft)) continue;
      const t = typeof peek.cooperativePauseToken === 'string' ? peek.cooperativePauseToken.trim() : '';
      if (t) tokens.add(t);
    }
  } catch {
    /* ignore */
  }

  return [...tokens];
}

/** Avoid browser / proxy connection caps when many pipelines are active at once (legacy per-token path). */
const PAUSE_REQUEST_BATCH_SIZE = 8;

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} pauseToken
 * @returns {Promise<{ ok: boolean, err?: string }>}
 */
async function postSinglePauseRequest(fetchImpl, pauseToken) {
  try {
    const res = await fetchImpl('/api/pipeline/pause-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ pauseToken }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return {
        ok: false,
        err: `HTTP ${res.status}: ${t.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One round-trip for all tokens (avoids HTTP/1.1 per-host connection limits with many concurrent SSE streams).
 * @param {typeof fetch} fetchImpl
 * @param {string[]} tokens
 * @returns {Promise<{ okCount: number, failCount: number, errors: string[] } | null>} null if bulk is unavailable or failed
 */
async function postBulkPauseRequest(fetchImpl, tokens) {
  try {
    const res = await fetchImpl('/api/pipeline/pause-request-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ pauseTokens: tokens }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) return null;
    const okCount = Number(data.okCount);
    const failCount = Number(data.failCount);
    if (!Number.isFinite(okCount) || !Number.isFinite(failCount)) return null;
    const errors = Array.isArray(data.errors) ? data.errors.map((e) => String(e || '')) : [];
    return { okCount, failCount, errors };
  } catch {
    return null;
  }
}

/**
 * POST /api/pipeline/pause-request for every registered token (deduped). Batched + one retry round so
 * large numbers of concurrent pipelines still get a pause flag reliably.
 * @param {typeof fetch} fetchImpl
 * @param {string[]} tokens
 */
async function requestCooperativePauseForAllRegisteredTokensLegacy(fetchImpl, tokens) {
  const tokenCount = tokens.length;

  /** @type {{ ok: boolean, err?: string }[]} */
  const results = new Array(tokenCount);
  for (let i = 0; i < tokenCount; i += PAUSE_REQUEST_BATCH_SIZE) {
    const batch = tokens.slice(i, i + PAUSE_REQUEST_BATCH_SIZE);
    const batchOut = await Promise.all(batch.map((pt) => postSinglePauseRequest(fetchImpl, pt)));
    for (let k = 0; k < batchOut.length; k += 1) {
      results[i + k] = batchOut[k];
    }
  }

  const failedIndices = [];
  for (let i = 0; i < tokenCount; i += 1) {
    if (!results[i]?.ok) failedIndices.push(i);
  }

  if (failedIndices.length > 0) {
    await new Promise((r) => setTimeout(r, 150));
    for (const idx of failedIndices) {
      const again = await postSinglePauseRequest(fetchImpl, tokens[idx]);
      if (again.ok) results[idx] = again;
    }
  }

  const okCount = results.filter((r) => r?.ok).length;
  const failCount = tokenCount - okCount;
  const errors = results.filter((r) => !r?.ok).map((r) => r?.err || 'unknown error');

  return { tokenCount, okCount, failCount, errors };
}

/**
 * Browsers allow ~6 HTTP/1.1 connections per origin. When every slot is held by a long-lived
 * SSE pipeline stream, a new POST is queued indefinitely — deadlock. Race the fetch against a
 * timeout; on timeout fire {@link navigator.sendBeacon} (stays browser-queued and will deliver
 * once any SSE closes) and return an optimistic result so the UI proceeds immediately.
 */
/** Slightly generous so slow bulk `/pause-request-bulk` on a busy tab is not mistaken for connection deadlock. */
const PAUSE_FETCH_TIMEOUT_MS = 8000;

/**
 * Prefer POST /api/pipeline/pause-request-bulk (single connection); fall back to batched single-token POSTs
 * when the server does not expose bulk (older backend).
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ tokenCount: number, okCount: number, failCount: number, errors: string[], connectionLimited?: boolean }>}
 */
export async function requestCooperativePauseForAllRegisteredTokens(fetchImpl = fetch) {
  const tokens = getCooperativePauseTokensForPauseRequests();
  const tokenCount = tokens.length;
  if (tokenCount === 0) {
    return { tokenCount: 0, okCount: 0, failCount: 0, errors: [] };
  }

  const fetchResult = await Promise.race([
    (async () => {
      const bulk = await postBulkPauseRequest(fetchImpl, tokens);
      if (bulk !== null) {
        return {
          tokenCount,
          okCount: bulk.okCount,
          failCount: bulk.failCount,
          errors: bulk.errors,
        };
      }
      return requestCooperativePauseForAllRegisteredTokensLegacy(fetchImpl, tokens);
    })(),
    new Promise((resolve) =>
      setTimeout(() => {
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          try {
            navigator.sendBeacon(
              '/api/pipeline/pause-request-bulk',
              new Blob([JSON.stringify({ pauseTokens: tokens })], { type: 'application/json' })
            );
          } catch { /* ignore */ }
        }
        resolve({
          tokenCount,
          okCount: tokenCount,
          failCount: 0,
          errors: [],
          connectionLimited: true,
        });
      }, PAUSE_FETCH_TIMEOUT_MS)
    ),
  ]);

  return fetchResult;
}
