import { MODULE_ID_TO_PIPELINE_LAYER, PIPELINE_STAGE_LABELS, getModule } from './cognitiveModules';
import { PIPELINE_LIVE_STATUS_PREFIX } from './activePipelineStatusLabels';

function resolveModuleDisplayName(entry) {
  if (!entry?.moduleId) return null;
  return entry.moduleName || getModule(entry.moduleId)?.name || entry.moduleId;
}

const MODULE_ENTRY_TYPES = new Set(['module-start', 'module-thought', 'module-complete']);

/**
 * Entries for the current user turn: from the last `user-input` through the end.
 * If there is no `user-input`, the full list is used (orphan prefix).
 * @param {unknown[]} entries
 */
export function sliceCurrentTurn(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let lastUserIdx = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === 'user-input') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return list;
  return list.slice(lastUserIdx);
}

/** Layer key for minimap: known module id map, or `pipelineLayerKey` from SSE when using synthetic ids. */
function layerKeyForStreamEntry(e) {
  if (!e?.moduleId || !MODULE_ENTRY_TYPES.has(e.type)) return null;
  const fromMap = MODULE_ID_TO_PIPELINE_LAYER[e.moduleId];
  if (fromMap) return fromMap;
  const pk = e.pipelineLayerKey;
  if (typeof pk === 'string' && pk && /^layer[1-6]$/.test(pk)) return pk;
  return null;
}

/**
 * @param {unknown[]} entries
 * @param {boolean} isProcessing
 * @param {{ statusPrefix?: string }} [options] Defaults to {@link PIPELINE_LIVE_STATUS_PREFIX}.
 * @returns {{
 *   prep: boolean,
 *   isProcessing: boolean,
 *   activeLayerKey: string | null,
 *   activeModuleName: string | null,
 *   completedLayerKeys: string[],
 *   allStagesCompleteVisual: boolean,
 *   neutralIdle: boolean,
 *   lastCompletedModuleName: string | null,
 *   liveStatus: string,
 * }}
 */
export function computePipelineMinimapSnapshot(entries, isProcessing, options = {}) {
  const statusPrefix = options.statusPrefix ?? PIPELINE_LIVE_STATUS_PREFIX;
  const slice = sliceCurrentTurn(entries);

  const completedLayerKeys = [];
  const seen = new Set();
  for (const e of slice) {
    if (e?.type === 'module-complete' && e.moduleId) {
      const layer = layerKeyForStreamEntry(e);
      if (layer && !seen.has(layer)) {
        seen.add(layer);
        completedLayerKeys.push(layer);
      }
    }
  }

  let anyModuleTagged = false;
  for (const e of slice) {
    if (e?.moduleId && MODULE_ENTRY_TYPES.has(e.type)) {
      anyModuleTagged = true;
      break;
    }
  }

  let activeLayerKey = null;
  let activeModuleName = null;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const e = slice[i];
    const layer = layerKeyForStreamEntry(e);
    if (layer) {
      activeLayerKey = layer;
      activeModuleName = resolveModuleDisplayName(e);
      break;
    }
  }

  let lastCompletedModuleName = null;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const e = slice[i];
    if (e?.type === 'module-complete' && e.moduleId) {
      lastCompletedModuleName = resolveModuleDisplayName(e);
      break;
    }
  }

  const prep = Boolean(isProcessing && !anyModuleTagged);
  const neutralIdle = Boolean(!isProcessing && !anyModuleTagged);
  const allStagesCompleteVisual = Boolean(!isProcessing && anyModuleTagged);

  const runningHighlight = Boolean(isProcessing && !prep);
  const effectiveActive = runningHighlight ? activeLayerKey : null;

  let liveStatus = `${statusPrefix}: idle`;
  if (neutralIdle) {
    liveStatus = `${statusPrefix}: idle`;
  } else if (prep) {
    liveStatus = `${statusPrefix}: starting — waiting for modules`;
  } else if (isProcessing && effectiveActive) {
    const label = PIPELINE_STAGE_LABELS[effectiveActive] || effectiveActive;
    const mod =
      runningHighlight && activeModuleName ? ` — ${activeModuleName}` : '';
    liveStatus = `${statusPrefix}: ${label}${mod}`;
  } else if (isProcessing) {
    liveStatus = `${statusPrefix}: running`;
  } else if (allStagesCompleteVisual) {
    const mod = lastCompletedModuleName ? ` — ${lastCompletedModuleName}` : '';
    liveStatus = `${statusPrefix}: complete${mod}`;
  }

  return {
    prep,
    isProcessing,
    activeLayerKey: effectiveActive,
    activeModuleName: runningHighlight ? activeModuleName : null,
    completedLayerKeys,
    allStagesCompleteVisual,
    neutralIdle,
    lastCompletedModuleName,
    liveStatus,
  };
}
