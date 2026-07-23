/**
 * Polls server snapshot metadata; if another device pushed a newer blob, pulls and reloads.
 * Requires saved sync token + at least one prior successful pull/push on this browser (see shouldAutoPullRemoteSnapshot).
 */
import { toast } from '../components/ui';
import {
  fetchMindSnapshotMeta,
  getMindSnapshotSyncToken,
  pullMindSnapshotFromServer,
  shouldAutoPullRemoteSnapshot,
} from './mindSnapshotSync';

const POLL_MS = 15_000;

let pollInFlight = false;
let pullInFlight = false;

async function tick() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (!getMindSnapshotSyncToken().trim()) return;
  if (pollInFlight || pullInFlight) return;
  pollInFlight = true;
  try {
    const meta = await fetchMindSnapshotMeta();
    if (!shouldAutoPullRemoteSnapshot(meta)) return;
    pullInFlight = true;
    try {
      const r = await pullMindSnapshotFromServer();
      if (!r.ok) {
        console.warn('[mindSnapshotRemotePoll] pull failed', r.error);
        return;
      }
      toast({
        title: 'Mind synced from server',
        description: 'Another device updated the snapshot — reloading this tab.',
      });
      window.setTimeout(() => window.location.reload(), 400);
    } finally {
      pullInFlight = false;
    }
  } catch (e) {
    console.warn('[mindSnapshotRemotePoll]', e instanceof Error ? e.message : e);
  } finally {
    pollInFlight = false;
  }
}

/**
 * @returns {() => void} cleanup
 */
export function startMindSnapshotRemotePoll() {
  if (typeof window === 'undefined') return () => {};
  const id = window.setInterval(() => {
    void tick();
  }, POLL_MS);
  const onVis = () => {
    if (document.visibilityState === 'visible') void tick();
  };
  document.addEventListener('visibilitychange', onVis);
  return () => {
    window.clearInterval(id);
    document.removeEventListener('visibilitychange', onVis);
  };
}
