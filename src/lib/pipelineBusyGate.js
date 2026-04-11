import { graphPipelineStore, subscribeGraphPipeline } from './graphPipelineStore';
import { consciousnessStreamStore, subscribeConsciousnessStream } from './consciousnessStreamStore';

/**
 * Depth counter for headless / scheduled work ({@link beginBackgroundCognitiveWork}): scheduler jobs
 * and `runGraphPipelineOneShot` when `acquireGlobalGate` is true. Does not include the interactive
 * graph UI pipeline or graph transcript run — those are tracked in their stores; see
 * {@link isInteractiveGraphOrStreamActive}.
 */
let backgroundCognitiveDepth = 0;

const busyListeners = new Set();

function emitBusyChanged() {
  busyListeners.forEach((l) => l());
}

/** Subscribe to global cognitive-busy changes (depth counters + queue holder). */
export function subscribePipelineBusyFlag(listener) {
  busyListeners.add(listener);
  return () => busyListeners.delete(listener);
}

export function beginBackgroundCognitiveWork() {
  backgroundCognitiveDepth += 1;
  emitBusyChanged();
}

export function endBackgroundCognitiveWork() {
  backgroundCognitiveDepth = Math.max(0, backgroundCognitiveDepth - 1);
  emitBusyChanged();
}

export function isBackgroundCognitiveWorkActive() {
  return backgroundCognitiveDepth > 0;
}

/**
 * Reset leaked {@link backgroundCognitiveDepth} (e.g. tab crash mid-job). Call only when storage
 * shows no `running` scheduled task — see {@link healLeakedBackgroundCognitiveGateIfNoRunningTask}.
 */
export function resetLeakedBackgroundCognitiveGate(reason = 'heal') {
  if (backgroundCognitiveDepth <= 0) return false;
  console.warn('[pipelineBusyGate] resetLeakedBackgroundCognitiveGate', reason, 'depth was', backgroundCognitiveDepth);
  backgroundCognitiveDepth = 0;
  emitBusyChanged();
  return true;
}

/**
 * True while the interactive graph pipeline transcript run is active (same-tab UI).
 * Used to avoid starting a second interactive graph/stream run; does not include the background gate.
 */
export function isInteractiveGraphOrStreamActive() {
  try {
    if (graphPipelineStore.getState().isRunning) return true;
  } catch {
    /* ignore */
  }
  try {
    if (consciousnessStreamStore.getState().isProcessing) return true;
  } catch {
    /* ignore */
  }
  return false;
}

const interactiveActivityListeners = new Set();
let lastInteractiveActivityValue = null;

function bumpInteractiveActivityListeners() {
  const next = isInteractiveGraphOrStreamActive();
  if (next === lastInteractiveActivityValue) return;
  lastInteractiveActivityValue = next;
  for (const l of interactiveActivityListeners) l();
}

/**
 * Subscribe only when {@link isInteractiveGraphOrStreamActive} changes.
 * Graph and stream stores emit on every pipeline SSE tick; this avoids re-rendering pages that
 * only need a busy/idle boolean (e.g. Curiosity schedule / pursue gating).
 */
export function subscribeInteractiveGraphOrStreamActivity(listener) {
  interactiveActivityListeners.add(listener);
  if (interactiveActivityListeners.size === 1) {
    lastInteractiveActivityValue = isInteractiveGraphOrStreamActive();
  }
  const u1 = subscribeGraphPipeline(bumpInteractiveActivityListeners);
  const u2 = subscribeConsciousnessStream(bumpInteractiveActivityListeners);
  return () => {
    u1();
    u2();
    interactiveActivityListeners.delete(listener);
    if (interactiveActivityListeners.size === 0) lastInteractiveActivityValue = null;
  };
}

export function getInteractiveGraphOrStreamActivitySnapshot() {
  return isInteractiveGraphOrStreamActive();
}

/**
 * True while interactive graph/stream **or** background/scheduled cognitive work is active.
 * Use for deferring automated follow-ups (e.g. chained scheduler tasks). For gating interactive
 * starts, prefer {@link isInteractiveGraphOrStreamActive}. Several scheduled jobs may run at once;
 * use {@link isBackgroundCognitiveWorkActive} / {@link waitUntilPipelineIdle} when something must wait
 * until all headless work has finished.
 */
export function isAnyBlockingPipelineActive() {
  return isInteractiveGraphOrStreamActive() || isBackgroundCognitiveWorkActive();
}
