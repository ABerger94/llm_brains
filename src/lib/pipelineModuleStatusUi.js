import { getExecutionPlan } from './cognitiveModules';

/** Server run order (flat); stable for one bundle load. */
const PIPELINE_MODULE_ORDER = getExecutionPlan().flat();

/**
 * When module `uiId` starts, every prior module in server order should show complete
 * (covers missed SSE, continuation legs, and minimap progress).
 * @param {Record<string, string>} prevStatuses
 * @param {string} uiId
 * @returns {Record<string, string>}
 */
export function applyModuleStartToStatuses(prevStatuses, uiId) {
  const ms = { ...(prevStatuses || {}) };
  const idx = PIPELINE_MODULE_ORDER.indexOf(uiId);
  if (idx >= 0) {
    for (let i = 0; i < idx; i += 1) {
      const prior = PIPELINE_MODULE_ORDER[i];
      if (ms[prior] !== 'error') ms[prior] = 'complete';
    }
  }
  ms[uiId] = 'processing';
  return ms;
}

/**
 * Mark every module with a string output in `normalizedUiOutputs` as complete, and clear any stray `processing`.
 * Matches graph pipeline `complete` SSE reconciliation.
 * @param {Record<string, string>} prevStatuses
 * @param {Record<string, string>} normalizedUiOutputs
 * @returns {Record<string, string>}
 */
export function reconcileCompleteStatusesFromOutputs(prevStatuses, normalizedUiOutputs) {
  const msDone = { ...(prevStatuses || {}) };
  const norm = normalizedUiOutputs && typeof normalizedUiOutputs === 'object' ? normalizedUiOutputs : {};
  for (const id of Object.keys(norm)) {
    if (typeof norm[id] === 'string') msDone[id] = 'complete';
  }
  for (const id of Object.keys(msDone)) {
    if (msDone[id] === 'processing') msDone[id] = 'complete';
  }
  return msDone;
}
