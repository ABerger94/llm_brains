import {
  backgroundCurrentInteractiveRun,
  getActiveConsciousnessStreamGraphSessionId,
  isBackgroundedRunAliveForSession,
  isInteractiveStreamFetchAlive,
} from './consciousnessStreamRunner';
import { setGraphPipelineSessionId } from './graphPipelineSessionScope';
import { graphPipelineStore } from './graphPipelineStore';
import { consciousnessStreamStore } from './consciousnessStreamStore';
import {
  isPlaygroundDualOrchestrationActive,
  PLAYGROUND_GRAPH_SESSION_A,
  PLAYGROUND_GRAPH_SESSION_B,
} from './playgroundDualGraphRunner';

/**
 * True when the *specific* session has a live pipeline run:
 *  1. The attached interactive SSE is alive AND matches this session.
 *  2. A backgrounded SSE is still completing for this session.
 *
 * Global store flags (`isRunning` / `isProcessing`) are NOT checked because they
 * belong to whichever session is currently bound to the stores—not necessarily
 * the session being queried.
 */
export function isSessionPipelineLive(sessionId) {
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

  /**
   * Do not switch workspace KV or background the fetch while System Chat still owns the interactive
   * SSE for playground-dual-a / playground-dual-b (covers orchestration gaps where depth is 0).
   */
  if (
    streamAlive &&
    streamSid &&
    (streamSid === PLAYGROUND_GRAPH_SESSION_A || streamSid === PLAYGROUND_GRAPH_SESSION_B) &&
    id !== streamSid
  ) {
    return;
  }

  /** Ditto while a backgrounded playground leg is still finishing. */
  if (
    (isBackgroundedRunAliveForSession(PLAYGROUND_GRAPH_SESSION_A) ||
      isBackgroundedRunAliveForSession(PLAYGROUND_GRAPH_SESSION_B)) &&
    id !== PLAYGROUND_GRAPH_SESSION_A &&
    id !== PLAYGROUND_GRAPH_SESSION_B
  ) {
    return;
  }

  /** Avoid backgrounding System Chat’s interactive SSE when navigating to another workspace URL mid-run. */
  if (
    isPlaygroundDualOrchestrationActive() &&
    id !== PLAYGROUND_GRAPH_SESSION_A &&
    id !== PLAYGROUND_GRAPH_SESSION_B
  ) {
    return;
  }

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

  if (isPlaygroundDualOrchestrationActive()) return;

  /** URL workspace id may differ from playground A/B while System Chat still runs. */
  if (isSessionPipelineLive(PLAYGROUND_GRAPH_SESSION_A)) return;
  if (isSessionPipelineLive(PLAYGROUND_GRAPH_SESSION_B)) return;

  if (isSessionPipelineLive(sid)) return;

  resetGraphPipelineSessionStoresForLobby();
}

/**
 * System Chat (`/playground`) runs two graph sessions (A then B). Leaving the page or React Strict Mode
 * remount must not clear in-memory stores while **either** session still has a live or backgrounded SSE,
 * or the B leg appears to "crash" after A finishes (cleanup only checked A).
 */
export function resetPlaygroundDualGraphStoresAfterLeavingWorkspace() {
  if (isPlaygroundDualOrchestrationActive()) return;
  if (isSessionPipelineLive(PLAYGROUND_GRAPH_SESSION_A)) return;
  if (isSessionPipelineLive(PLAYGROUND_GRAPH_SESSION_B)) return;
  const gp = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();
  if (gp.isRunning || cs.isProcessing) return;
  resetGraphPipelineSessionStoresForLobby();
}
