/**
 * Active graph pipeline run session (per browser window). Lobby uses `null` (no persisted stream/graph KV).
 * Session `default` keeps legacy un-suffixed KV keys for backward compatibility.
 */

export const DEFAULT_GRAPH_SESSION_ID = 'default';

const LEGACY_DRAFT = 'mybrain_consciousness_stream_draft_v1';
const LEGACY_UI = 'mybrain_consciousness_stream_ui_v1';
const LEGACY_GRAPH_V2 = 'mybrain_graph_pipeline_ui_v2';
const LEGACY_GRAPH_V1 = 'mybrain_graph_pipeline_ui_v1';

/** @type {string | null} */
let currentSessionId = null;

export function getGraphPipelineSessionId() {
  return currentSessionId;
}

/**
 * @param {string | null | undefined} id - null/empty = lobby (no session-bound storage I/O)
 */
export function setGraphPipelineSessionId(id) {
  const s = id != null && String(id).trim() ? String(id).trim() : null;
  currentSessionId = s;
}

export function isDefaultGraphSessionId(sessionId) {
  return sessionId === DEFAULT_GRAPH_SESSION_ID || sessionId == null;
}

/** Draft KV key for the current session, or null if lobby (caller should skip persist). */
export function consciousnessStreamDraftKey() {
  const sid = currentSessionId;
  if (sid == null) return null;
  if (sid === DEFAULT_GRAPH_SESSION_ID) return LEGACY_DRAFT;
  return `${LEGACY_DRAFT}__s_${sid}`;
}

export function consciousnessStreamUiKey() {
  const sid = currentSessionId;
  if (sid == null) return null;
  if (sid === DEFAULT_GRAPH_SESSION_ID) return LEGACY_UI;
  return `${LEGACY_UI}__s_${sid}`;
}

/** Primary graph UI persistence key for the current session. */
export function graphPipelineUiStorageKey() {
  const sid = currentSessionId;
  if (sid == null) return null;
  if (sid === DEFAULT_GRAPH_SESSION_ID) return LEGACY_GRAPH_V2;
  return `${LEGACY_GRAPH_V2}__s_${sid}`;
}

export function graphPipelineUiLegacyFallbackKey() {
  const sid = currentSessionId;
  if (sid == null) return null;
  if (sid === DEFAULT_GRAPH_SESSION_ID) return LEGACY_GRAPH_V1;
  return `${LEGACY_GRAPH_V1}__s_${sid}`;
}

/** KV key for graph pipeline UI for an explicit session id (dashboard / cross-tab peek). */
export function graphPipelineUiStorageKeyForSessionId(sessionId) {
  const sid = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : null;
  if (!sid) return null;
  if (sid === DEFAULT_GRAPH_SESSION_ID) return LEGACY_GRAPH_V2;
  return `${LEGACY_GRAPH_V2}__s_${sid}`;
}

export function graphPipelineUiLegacyFallbackKeyForSessionId(sessionId) {
  const sid = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : null;
  if (!sid) return null;
  if (sid === DEFAULT_GRAPH_SESSION_ID) return LEGACY_GRAPH_V1;
  return `${LEGACY_GRAPH_V1}__s_${sid}`;
}

/** Draft KV key for a session id (peek in-flight stream without binding current scope). */
export function consciousnessStreamDraftKeyForSessionId(sessionId) {
  const sid = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : null;
  if (!sid) return null;
  if (sid === DEFAULT_GRAPH_SESSION_ID) return LEGACY_DRAFT;
  return `${LEGACY_DRAFT}__s_${sid}`;
}

/**
 * Tag written on ConversationMessage / PipelineRun rows for this window's session.
 * @param {string} [explicitSessionId] - URL param when store not set yet
 */
export function getGraphSessionIdForPersistence(explicitSessionId) {
  const fromStore = currentSessionId;
  if (fromStore) return fromStore;
  const e = explicitSessionId != null && String(explicitSessionId).trim() ? String(explicitSessionId).trim() : null;
  return e || DEFAULT_GRAPH_SESSION_ID;
}
