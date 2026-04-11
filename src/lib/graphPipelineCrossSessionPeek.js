import { getKvSync, setKvSync } from './browserStorage';
import {
  consciousnessStreamDraftKeyForSessionId,
  graphPipelineUiLegacyFallbackKeyForSessionId,
  graphPipelineUiStorageKeyForSessionId,
} from './graphPipelineSessionScope';

/**
 * Read persisted graph pipeline UI for `sessionId` without forcing `isRunning` false (unlike lobby rehydrate).
 * @param {string} sessionId
 * @returns {{
 *   isRunning: boolean,
 *   runContextLabel: string,
 *   input: string,
 *   moduleStatuses: Record<string, string>,
 *   moduleOutputs: Record<string, string>,
 *   loopCount: number,
 *   executionLog: unknown[],
 *   finalOutput: string,
 *   uploading: boolean,
 *   runInterrupted: boolean,
 *   runError: string | null,
 *   cooperativePauseToken: string | null,
 * } | null}
 */
export function peekGraphPipelineUiPersisted(sessionId) {
  if (typeof window === 'undefined') return null;
  const pk = graphPipelineUiStorageKeyForSessionId(sessionId);
  if (!pk) return null;
  let raw = getKvSync(pk);
  const fk = graphPipelineUiLegacyFallbackKeyForSessionId(sessionId);
  if (!raw && fk && fk !== pk) raw = getKvSync(fk);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const coopTok =
      typeof parsed.cooperativePauseToken === 'string' ? String(parsed.cooperativePauseToken).trim() : '';
    return {
      isRunning: Boolean(parsed.isRunning),
      runContextLabel: typeof parsed.runContextLabel === 'string' ? parsed.runContextLabel : '',
      input: typeof parsed.input === 'string' ? parsed.input : '',
      moduleStatuses: parsed.moduleStatuses && typeof parsed.moduleStatuses === 'object' ? parsed.moduleStatuses : {},
      moduleOutputs: parsed.moduleOutputs && typeof parsed.moduleOutputs === 'object' ? parsed.moduleOutputs : {},
      loopCount: Number(parsed.loopCount) || 0,
      executionLog: Array.isArray(parsed.executionLog) ? parsed.executionLog : [],
      finalOutput: typeof parsed.finalOutput === 'string' ? parsed.finalOutput : '',
      uploading: Boolean(parsed.uploading),
      runInterrupted: Boolean(parsed.runInterrupted),
      runError: typeof parsed.runError === 'string' ? parsed.runError : null,
      cooperativePauseToken: coopTok || null,
    };
  } catch {
    return null;
  }
}

/**
 * Shallow-merge into persisted graph pipeline UI for `sessionId` (IndexedDB-backed KV).
 * Used when a background one-shot registers a cooperative pause token but never mounts
 * {@link graphPipelineStore}, so Dashboard “Pause & save” can still resolve the token via
 * {@link peekGraphPipelineUiPersisted} + registry.
 * @param {string} sessionId
 * @param {Record<string, unknown>} patch
 */
export function mergePersistedGraphPipelineUiForSession(sessionId, patch) {
  if (typeof window === 'undefined') return;
  const sid = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : null;
  if (!sid) return;
  const pk = graphPipelineUiStorageKeyForSessionId(sid);
  if (!pk) return;
  let raw = getKvSync(pk);
  const fk = graphPipelineUiLegacyFallbackKeyForSessionId(sid);
  if (!raw && fk && fk !== pk) raw = getKvSync(fk);
  let base = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') base = parsed;
    } catch {
      base = {};
    }
  }
  const next = { ...base, ...patch };
  try {
    setKvSync(pk, JSON.stringify(next));
  } catch {
    /* quota */
  }
}

/**
 * @param {string} sessionId
 * @returns {{ inFlight: boolean, entries: unknown[] }}
 */
export function peekConsciousnessStreamDraftForSession(sessionId) {
  if (typeof window === 'undefined') return { inFlight: false, entries: [] };
  const key = consciousnessStreamDraftKeyForSessionId(sessionId);
  if (!key) return { inFlight: false, entries: [] };
  try {
    const raw = getKvSync(key);
    if (!raw) return { inFlight: false, entries: [] };
    const p = JSON.parse(raw);
    return {
      inFlight: Boolean(p.inFlight),
      entries: Array.isArray(p.entries) ? p.entries : [],
    };
  } catch {
    return { inFlight: false, entries: [] };
  }
}
