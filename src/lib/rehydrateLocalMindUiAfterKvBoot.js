import { graphPipelineStore } from './graphPipelineStore';
import { consciousnessStreamStore } from './consciousnessStreamStore';
import { reloadCuriosityPursuitsFromPersistedDisk } from './curiosityPagePursuitStore';
import { reloadGoalPursuitsFromPersistedDisk } from './goalPagePursuitStore';
import { syncDashboardScheduledRunningFromDb } from './dashboardScheduledRunningSync';
import { healGraphRegistryWhenPersistSaysIdle } from './graphSessionStaleRunningHeal';

/**
 * IndexedDB KV is loaded asynchronously in main.jsx, after many modules have already evaluated.
 * Those modules read {@link getKvSync} into in-memory stores at load time when the cache was still empty.
 * Call this once the KV cache has been filled so Dashboard pause/resume and active-pipeline rows match disk.
 */
export async function rehydrateLocalMindUiAfterKvBoot() {
  if (typeof window === 'undefined') return;
  graphPipelineStore.rehydrateFromPersisted();
  consciousnessStreamStore.rehydrateFromPersisted();
  reloadCuriosityPursuitsFromPersistedDisk();
  reloadGoalPursuitsFromPersistedDisk();
  healGraphRegistryWhenPersistSaysIdle();
  await syncDashboardScheduledRunningFromDb();
}
