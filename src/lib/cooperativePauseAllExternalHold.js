/**
 * While Dashboard “Pause & save all” is in effect, holds **new** scheduled pipeline work
 * (automatic due-task runs and manual scheduler retries / paused-task resumes) until
 * {@link setCooperativePauseAllExternalHold(false)} runs from Dashboard Resume on a card, “Rerun interrupted”, etc.
 *
 * Persisted in `localStorage` so every open tab’s scheduler respects the same hold (each tab runs its own tick).
 * In-flight runs are not aborted; this only prevents **starting** additional queued work.
 */

const STORAGE_KEY = 'mybrain_cooperative_pause_scheduler_hold_v1';

const listeners = new Set();

function emitAll() {
  for (const l of listeners) l();
}

/** @param {StorageEvent} ev */
function onStorage(ev) {
  if (ev.key !== STORAGE_KEY) return;
  emitAll();
}

export function setCooperativePauseAllExternalHold(value) {
  if (typeof window === 'undefined') return;
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* quota / private mode */
  }
  emitAll();
}

export function isCooperativePauseAllExternalHoldActive() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function subscribeCooperativePauseAllExternalHold(listener) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export const COOPERATIVE_PAUSE_HOLD_SCHEDULER_MESSAGE =
  'Scheduled work is held after Pause & save all — use Dashboard “Load saved” then “Resume” on a pipeline card (or “Rerun interrupted”) to release and continue.';
