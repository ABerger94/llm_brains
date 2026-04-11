import { subscribePipelineBusyFlag, isBackgroundCognitiveWorkActive } from './pipelineBusyGate';

const DEFAULT_IDLE_TIMEOUT_MS = 86_400_000;

/**
 * Resolves when the background cognitive gate is clear ({@link isBackgroundCognitiveWorkActive}).
 * Use when something must not start until every headless/scheduler-held job has finished (e.g. reload
 * recovery between pursuit phases). Scheduled tasks may run several at once; each increments the gate
 * depth until it completes.
 * @param {{ timeoutMs?: number, pollIntervalMs?: number }} [options]
 */
export function waitUntilPipelineIdle({
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  pollIntervalMs = 400,
} = {}) {
  if (!isBackgroundCognitiveWorkActive()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const started = Date.now();

    const cleanup = () => {
      unsub();
      if (pollId != null) clearInterval(pollId);
    };

    const check = () => {
      if (!isBackgroundCognitiveWorkActive()) {
        cleanup();
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        cleanup();
        reject(new Error(`Background cognitive gate remained busy longer than ${timeoutMs}ms`));
      }
    };

    const unsub = subscribePipelineBusyFlag(check);
    const pollId = setInterval(check, Math.max(16, pollIntervalMs));
    check();
  });
}

/**
 * Start scheduled cognitive work immediately. Multiple jobs may run in parallel; each should wrap
 * execution with {@link beginBackgroundCognitiveWork} / {@link endBackgroundCognitiveWork} so
 * {@link waitUntilPipelineIdle} and dashboard busy state stay accurate.
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<unknown>}
 */
export function enqueueCognitiveWork(fn) {
  return Promise.resolve().then(() => fn());
}
