import { graphPipelineStore, subscribeGraphPipeline } from './graphPipelineStore';
import { consciousnessStreamStore, subscribeConsciousnessStream } from './consciousnessStreamStore';
import { getRuntimeSettings } from './runtimeSettings';

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
 * Resolves when {@link isInteractiveGraphOrStreamActive} is false (graph + consciousness stream idle).
 * System Chat chains multiple full-graph legs; if the user starts the next leg while stores still show
 * `isRunning` / `isProcessing`, {@link startConsciousnessStreamRun} would no-op — waiting here avoids that.
 * @param {{ timeoutMs?: number, pollIntervalMs?: number }} [options]
 * @returns {Promise<void>}
 */
export function waitUntilInteractiveGraphOrStreamIdle({ timeoutMs = 90_000, pollIntervalMs = 32 } = {}) {
  if (!isInteractiveGraphOrStreamActive()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const started = Date.now();
    let pollId = /** @type {ReturnType<typeof setInterval> | null} */ (null);
    let unsub = () => {};

    const cleanup = () => {
      if (pollId != null) {
        clearInterval(pollId);
        pollId = null;
      }
      try {
        unsub();
      } catch {
        /* ignore */
      }
    };

    const check = () => {
      if (!isInteractiveGraphOrStreamActive()) {
        cleanup();
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        cleanup();
        reject(
          new Error('Pipeline is still busy. Wait for the current run to finish, then try again.')
        );
      }
    };

    unsub = subscribeInteractiveGraphOrStreamActivity(check);
    pollId = setInterval(check, pollIntervalMs);
    check();
  });
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

/**
 * Resolves when background cognitive depth is below the `schedulerMaxConcurrentBackgroundRuns` limit.
 * Unlike {@link waitUntilInteractiveGraphOrStreamIdle}, this does NOT wait for interactive
 * graph/stream runs — so scheduled work can proceed while the user is using the Playground.
 * @param {{ timeoutMs?: number, pollIntervalMs?: number }} [options]
 * @returns {Promise<void>}
 */
export function waitUntilScheduledSlotAvailable({ timeoutMs = 120_000, pollIntervalMs = 500 } = {}) {
  const rt = getRuntimeSettings();
  const maxBg = Math.max(1, Math.min(32, Math.floor(Number(rt.schedulerMaxConcurrentBackgroundRuns) || 2)));
  if (backgroundCognitiveDepth < maxBg) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const pollId = setInterval(() => {
      if (backgroundCognitiveDepth < maxBg) {
        clearInterval(pollId);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(pollId);
        reject(new Error(`Scheduled slot unavailable after ${timeoutMs}ms (background depth: ${backgroundCognitiveDepth}, max: ${maxBg})`));
      }
    }, pollIntervalMs);
  });
}
