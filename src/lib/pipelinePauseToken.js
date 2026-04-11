/**
 * Client-generated token for cooperative pause: must match POST /api/pipeline/pause-request
 * and the same token on POST /api/pipeline/stream (top-level pauseToken + pauseSupport, and in options).
 */
export function createPipelinePauseToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pt_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}
