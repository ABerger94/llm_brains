/**
 * Legacy: scheduled “headless flight” used to persist across reloads for re-queue UX.
 * That flow is removed — this module only clears old keys and keeps a stable no-op API.
 */

import { getKvSync, removeKvSync } from './browserStorage';

const STORAGE_KEY = 'mybrain_scheduler_headless_flight_v1';

const listeners = new Set();

/** @type {{ interrupted: null }} */
let snapshot = { interrupted: null };

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeSchedulerHeadlessFlight(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSchedulerHeadlessFlightSnapshot() {
  return snapshot;
}

export function clearPersistedSchedulerHeadlessFlight() {
  if (typeof window === 'undefined') return;
  try {
    removeKvSync(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function clearPersistedSchedulerHeadlessFlightIfMatches(taskId) {
  if (typeof window === 'undefined') return;
  try {
    const raw = getKvSync(STORAGE_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (String(p?.taskId) === String(taskId)) {
      removeKvSync(STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function clearSchedulerHeadlessInterruptedUiOnly() {
  snapshot = { interrupted: null };
  emit();
}

/** @deprecated No-op: flight is no longer persisted or hydrated. Clears legacy KV key. */
export function persistSchedulerHeadlessFlight() {
  /* intentionally empty */
}

/** Clears any legacy persisted flight and ensures UI snapshot stays empty. */
export async function hydrateSchedulerHeadlessFlightFromDb() {
  if (typeof window === 'undefined') return;
  clearPersistedSchedulerHeadlessFlight();
  if (snapshot.interrupted) {
    snapshot = { interrupted: null };
    emit();
  }
}

/** @deprecated No-op: use Scheduler “Run again” on failed/cancelled tasks instead. */
export async function requeueInterruptedHeadlessScheduledTask() {
  await hydrateSchedulerHeadlessFlightFromDb();
}
