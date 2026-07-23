import { graphPipelineStore } from './graphPipelineStore';
import { getDashboardActiveWorkSnapshot, subscribeDashboardActiveWork } from './dashboardActiveWork';
import { getSchedulerPipelineUiSnapshot } from './schedulerPipelineUiStore';

/** Cached snapshot so useSyncExternalStore getSnapshot stays referentially stable when data is unchanged. */
let cachedConnectivitySnapshot = {
  pipelineActive: false,
  lastLlmProvider: null,
  lastLlmModel: null,
};
let cachedConnectivityKey = '';

/**
 * Live graph/stream activity for Dashboard header when /api/health is slow or unavailable.
 * @returns {{ pipelineActive: boolean, lastLlmProvider: string|null, lastLlmModel: string|null }}
 */
export function getDashboardConnectivitySnapshot() {
  const gp = graphPipelineStore.getState();
  const prov = gp.lastLlmProvider != null && String(gp.lastLlmProvider).trim() ? String(gp.lastLlmProvider).trim() : null;
  const mod = gp.lastLlmModel != null && String(gp.lastLlmModel).trim() ? String(gp.lastLlmModel).trim() : null;
  const { rows } = getDashboardActiveWorkSnapshot();
  const schedUi = getSchedulerPipelineUiSnapshot();
  const pipelineActive =
    rows.some((r) => !r.interrupted) || Boolean(schedUi.running);
  const key = `${pipelineActive ? '1' : '0'}\x00${prov ?? ''}\x00${mod ?? ''}`;
  if (key === cachedConnectivityKey) return cachedConnectivitySnapshot;
  cachedConnectivityKey = key;
  cachedConnectivitySnapshot = {
    pipelineActive,
    lastLlmProvider: prov,
    lastLlmModel: mod,
  };
  return cachedConnectivitySnapshot;
}

/** Re-render Dashboard when any store that affects active work or graph last-LLM hint changes. */
export function subscribeDashboardConnectivity(onStoreChange) {
  return subscribeDashboardActiveWork(onStoreChange);
}
