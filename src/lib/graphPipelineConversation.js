import { DEFAULT_GRAPH_SESSION_ID } from './graphPipelineSessionScope';

/**
 * Whether a conversation row belongs to a graph pipeline session for transcript + continuation.
 * Legacy rows (no graph_session_id) count only for the `default` session.
 * @param {{ graph_session_id?: string | null }} row
 * @param {string} sessionId
 */
export function conversationRowBelongsToGraphSession(row, sessionId) {
  const sid = sessionId || DEFAULT_GRAPH_SESSION_ID;
  const tag = row?.graph_session_id;
  if (tag != null && String(tag).trim()) {
    return String(tag).trim() === sid;
  }
  return sid === DEFAULT_GRAPH_SESSION_ID;
}

/**
 * @param {object[]} rows
 * @param {string} sessionId
 */
export function filterConversationRowsForGraphSession(rows, sessionId) {
  return (rows || []).filter((r) => conversationRowBelongsToGraphSession(r, sessionId));
}

/**
 * @param {object[]} rows
 * @param {string} sessionId
 */
export function filterPipelineRunsForGraphSession(rows, sessionId) {
  return (rows || []).filter((r) => conversationRowBelongsToGraphSession(r, sessionId));
}
