/**
 * Periodic upload of mind snapshot to the Express host when a sync token is saved (Dashboard).
 * Requires the app tab to stay open on the machine doing the push.
 */
import { getMindSnapshotSyncToken, pushMindSnapshotToServer } from './mindSnapshotSync';

const INTERVAL_MS = 10 * 60 * 1000;

let inFlight = false;

async function tick() {
  if (!getMindSnapshotSyncToken().trim()) return;
  if (inFlight) return;
  inFlight = true;
  try {
    const r = await pushMindSnapshotToServer();
    if (!r.ok) {
      console.warn('[mindSnapshotAutoPush]', r.error);
    }
  } finally {
    inFlight = false;
  }
}

/**
 * Starts a 10-minute interval. No-op without a saved token (each tick skips).
 * @returns {() => void} cleanup — clear interval
 */
export function startMindSnapshotAutoPush() {
  if (typeof window === 'undefined') return () => {};
  const id = window.setInterval(() => {
    void tick();
  }, INTERVAL_MS);
  return () => window.clearInterval(id);
}
