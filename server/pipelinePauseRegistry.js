/** In-memory cooperative pause flags for POST /api/pipeline/stream (keyed by client pauseToken). */

const pauseRequested = new Map();

/**
 * @param {string} token
 */
export function requestPipelinePause(token) {
  const k = String(token || '').trim();
  if (!k) return;
  pauseRequested.set(k, true);
}

/**
 * Returns true once if pause was requested for this token (consumes the flag).
 * @param {string} token
 * @returns {boolean}
 */
export function consumePipelinePauseIfRequested(token) {
  const k = String(token || '').trim();
  if (!k) return false;
  if (!pauseRequested.get(k)) return false;
  pauseRequested.delete(k);
  return true;
}

/**
 * Peek without consuming (e.g. for debugging).
 * @param {string} token
 */
export function pipelinePausePending(token) {
  const k = String(token || '').trim();
  if (!k) return false;
  return pauseRequested.get(k) === true;
}
