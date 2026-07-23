import { getKvSync, removeKvSync, setKvSync } from './browserStorage';

const INTERRUPTED_RESUME_SID_KEY = 'mybrain_graph_interrupted_resume_graph_session_id';

/**
 * Remember which graph session had a recoverable (transient) interrupt so Resume / silent reconnect
 * can re-bind the graph session before replay — e.g. System A (`playground-dual-a`) after navigation
 * left scope on System B.
 */
export function rememberInterruptedRunGraphSessionId(sessionId) {
  if (typeof window === 'undefined') return;
  const s = sessionId != null && String(sessionId).trim() ? String(sessionId).trim() : '';
  if (!s) return;
  try {
    setKvSync(INTERRUPTED_RESUME_SID_KEY, JSON.stringify({ sid: s, savedAt: Date.now() }));
  } catch {
    /* quota */
  }
}

export function clearInterruptedRunGraphSessionId() {
  if (typeof window === 'undefined') return;
  try {
    removeKvSync(INTERRUPTED_RESUME_SID_KEY);
  } catch {
    /* ignore */
  }
}

/** @returns {string | null} */
export function peekInterruptedRunGraphSessionId() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = getKvSync(INTERRUPTED_RESUME_SID_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    const sid = typeof p.sid === 'string' ? p.sid.trim() : '';
    return sid || null;
  } catch {
    return null;
  }
}
