import {
  backgroundCurrentInteractiveRun,
  getActiveConsciousnessStreamGraphSessionId,
  isBackgroundedRunAliveForSession,
  isInteractiveStreamFetchAlive,
} from './consciousnessStreamRunner';
import { setGraphPipelineSessionId } from './graphPipelineSessionScope';
import { graphPipelineStore } from './graphPipelineStore';
import { consciousnessStreamStore } from './consciousnessStreamStore';

/**
 * True when the *specific* session has a live pipeline run:
 *  1. The attached interactive SSE is alive AND matches this session.
 *  2. A backgrounded SSE is still completing for this session.
 *
 * Global store flags (`isRunning` / `isProcessing`) are NOT checked because they
 * belong to whichever session is currently bound to the stores—not necessarily
 * the session being queried.
 */
function isSessionPipelineLive(sessionId) {
  const streamSid = getActiveConsciousnessStreamGraphSessionId();
  if (isInteractiveStreamFetchAlive() && streamSid === sessionId) return true;
  if (isBackgroundedRunAliveForSession(sessionId)) return true;
  return false;
}

/**
 * Bind this window to a graph-run session and load persisted graph + stream
 * draft/UI from KV.
 *
 * When a live pipeline is already running for this session, skip the
 * rehydrate — the in-memory stores are authoritative and KV `readStorage`
 * forces `isRunning=false` (crash-recovery) which would clobber the live state.
 *
 * When rehydrating a *different* session while an SSE is live for the old one,
 * **background** the old run (detach it from the stores without aborting the
 * SSE fetch).  The old pipeline continues to completion, persists its results
 * to IndexedDB, and updates the session registry — it just stops writing to the
 * in-memory stores so it doesn't clobber the newly-active session's UI.
 * @param {string} sessionId
 */
export function rehydrateGraphPipelineSessionStores(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;

  const streamSid = getActiveConsciousnessStreamGraphSessionId();
  const streamAlive = isInteractiveStreamFetchAlive();

  if (isSessionPipelineLive(id) && (!streamAlive || streamSid === id)) {
    setGraphPipelineSessionId(id);
    return;
  }

  if (streamAlive && streamSid && streamSid !== id) {
    graphPipelineStore.flushPersist();
    backgroundCurrentInteractiveRun();
  }

  setGraphPipelineSessionId(id);
  graphPipelineStore.rehydrateFromPersisted();
  consciousnessStreamStore.rehydrateFromPersisted();
}

/** Clear session binding and in-memory graph/stream UI (lobby or leaving run route). */
export function resetGraphPipelineSessionStoresForLobby() {
  setGraphPipelineSessionId(null);
  graphPipelineStore.resetToEmptyInMemory();
  consciousnessStreamStore.resetToEmptyInMemory();
}

/**
 * Leaving `/graph-pipeline/:id` (or session peek) normally clears in-memory
 * stores so the lobby starts fresh.
 *
 * If the session has an attached or backgrounded SSE run in flight, skip the
 * reset entirely so the run can complete and persist.
 * @param {string} sessionId
 */
export function resetGraphPipelineSessionStoresAfterLeavingWorkspace(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;

  if (isSessionPipelineLive(sid)) return;

  resetGraphPipelineSessionStoresForLobby();
}
