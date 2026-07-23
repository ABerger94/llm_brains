import {
  backendModuleNameToUiId,
  getModule,
  getServerExecutionLayers,
  mergeModuleOutputsPreferLonger,
  normalizeModuleOutputsFromServer,
  sseModuleCompleteOutputText,
} from './cognitiveModules';
import { computePipelineMinimapSnapshot } from './consciousnessStreamPipelineMinimap';
import { appendRateLimitRecoveryHint } from './pipelineSse';
import { formatPipelineSseErrorPayload } from './pipelineRunErrorFormat';
import {
  applyModuleStartToStatuses,
  reconcileCompleteStatusesFromOutputs,
} from './pipelineModuleStatusUi';
import { getRuntimeSettings, resolveMetacognitionRerunDelayMinutes } from './runtimeSettings';
import { PIPELINE_LIVE_STATUS_PREFIX } from './activePipelineStatusLabels';

/** @typedef {{ time: number, msg: string, detail?: string }} CuriosityPipelineLogEntry */

/**
 * @returns {{
 *   executionLog: CuriosityPipelineLogEntry[],
 *   moduleStatuses: Record<string, string>,
 *   moduleOutputs: Record<string, string>,
 *   loopCount: number,
 *   finalOutput: string,
 *   metacognitionMaxReruns: number | null,
 *   metacognitionRerunDelayMinutes: number | null,
 * }}
 */
export function initialCuriosityPipelineUi() {
  return {
    executionLog: [],
    moduleStatuses: {},
    moduleOutputs: {},
    loopCount: 0,
    finalOutput: '',
    metacognitionMaxReruns: null,
    metacognitionRerunDelayMinutes: null,
  };
}

/**
 * Clears run-scoped pipeline UI for a new full graph leg but keeps per-pursuit metacognition limits
 * (goal pipeline re-exports this as the same helper).
 * @param {Partial<ReturnType<typeof initialCuriosityPipelineUi>> | null | undefined} prevUi
 */
/**
 * Carousel / header should only show live minimap, neural highlight, and execution.log when the pursuit
 * is actively running, cooperatively paused (resume path), or reload-interrupted — not when idle with stale KV.
 * @param {{ running?: boolean, cooperativePaused?: boolean, interruptedByReload?: boolean } | null | undefined} entry
 */
export function pursuitShowsLivePipelineChrome(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return Boolean(entry.running || entry.cooperativePaused || entry.interruptedByReload);
}

export function freshPursuitPipelineUiForNewGraphRun(prevUi) {
  const base = initialCuriosityPipelineUi();
  if (!prevUi || typeof prevUi !== 'object') return base;
  let maxR = null;
  let delayM = null;
  if (prevUi.metacognitionMaxReruns != null && Number.isFinite(Number(prevUi.metacognitionMaxReruns))) {
    maxR = Math.min(20, Math.max(0, Math.floor(Number(prevUi.metacognitionMaxReruns))));
  }
  if (prevUi.metacognitionRerunDelayMinutes != null && Number.isFinite(Number(prevUi.metacognitionRerunDelayMinutes))) {
    delayM = Math.min(120, Math.max(0, Math.floor(Number(prevUi.metacognitionRerunDelayMinutes))));
  }
  return {
    ...base,
    metacognitionMaxReruns: maxR,
    metacognitionRerunDelayMinutes: delayM,
  };
}

const MAX_PURSUIT_PIPELINE_LOG_LINES = 40;

function pushLog(state, msg, detail) {
  const trimmed = detail != null && String(detail).trim() ? String(detail).trim().slice(0, 12_000) : undefined;
  const m = String(msg || '').slice(0, 4000);
  return {
    ...state,
    executionLog: [
      ...(state.executionLog || []),
      { time: Date.now(), msg: m, ...(trimmed ? { detail: trimmed } : {}) },
    ].slice(-MAX_PURSUIT_PIPELINE_LOG_LINES),
  };
}

/**
 * Apply one SSE event to curiosity page-local pipeline UI (mirrors graphPipelineRunner semantics).
 * @param {ReturnType<typeof initialCuriosityPipelineUi>} state
 * @param {object} evt
 */
export function reduceCuriosityPipelineSse(state, evt) {
  if (!evt || typeof evt !== 'object') return state;

  if (evt.type === 'module_start') {
    const uiId = backendModuleNameToUiId(evt.moduleName);
    if (!uiId) {
      return pushLog(state, `→ ${evt.moduleName} started (${evt.layer})`);
    }
    return pushLog(
      { ...state, moduleStatuses: applyModuleStartToStatuses(state.moduleStatuses, uiId) },
      `→ ${evt.moduleName} started (${evt.layer})`
    );
  }

  if (evt.type === 'module_complete') {
    const uiId = backendModuleNameToUiId(evt.moduleName);
    const ms = { ...state.moduleStatuses };
    const mo = { ...state.moduleOutputs };
    const pieceStr = sseModuleCompleteOutputText(evt);
    if (uiId) {
      ms[uiId] = 'complete';
      if (pieceStr !== null) mo[uiId] = pieceStr;
    }
    const prov = evt.provider && evt.model ? ` · ${evt.provider}/${evt.model}` : '';
    const partialTag = evt.outputPartialBySoftTimeout ? ' (partial · time budget)' : '';
    const thought = (pieceStr ?? '').trim();
    return pushLog(
      { ...state, moduleStatuses: ms, moduleOutputs: mo },
      `✓ ${evt.moduleName} complete${partialTag}${prov}`,
      thought || undefined
    );
  }

  if (evt.type === 'rerun') {
    const next = {
      ...state,
      loopCount: Number(evt.rerunsUsed) || 0,
    };
    return pushLog(next, `↻ Supervisor rerun #${evt.rerunsUsed}: ${evt.reason || ''}`);
  }

  if (evt.type === 'would_rerun') {
    const sup = evt.supervisor || 'Supervisor';
    const kind = evt.kind === 'heuristic' ? 'heuristic' : 'model';
    const r = String(evt.reason || '').trim();
    const clip = r.length > 420 ? `${r.slice(0, 420)}…` : r;
    return pushLog(
      state,
      `⏭ Rerun not executed (${sup}, ${kind} — max reruns 0 or cap reached): ${clip || '(no reason)'}`
    );
  }

  if (evt.type === 'pipeline_continuation') {
    const sup = String(evt.supervisor || '').trim() || 'Supervisor';
    const r = String(evt.reason || '').trim();
    return pushLog(
      state,
      `↪ Continuation (${sup}) — next HTTP leg from layer 1…`,
      r || undefined
    );
  }

  if (evt.type === 'module_progress') {
    const mod = evt.moduleName || 'module';
    let detail = '';
    if (evt.phase === 'chunked_ingest') detail = `large context → ${evt.totalChunks} ingest chunk(s)`;
    else if (evt.phase === 'map_chunk') detail = `ingest map ${evt.chunkIndex}/${evt.totalChunks}`;
    else if (evt.phase === 'ingest_shrink') detail = `shrinking ingest (pass ${evt.tier}/${evt.maxTier})`;
    else if (evt.phase === 'reduce') detail = 'reduce step (single LLM call)';
    else detail = evt.phase || 'working';
    return pushLog(state, `… ${mod}: ${detail}`);
  }

  if (evt.type === 'web_fetch') {
    const st = evt.ok ? '✓' : '✗';
    return pushLog(
      state,
      `${st} Web ${evt.kind} (${evt.moduleName || '?'})`,
      evt.preview || evt.error || undefined
    );
  }

  if (evt.type === 'complete') {
    const raw = evt.sharedMemory?.moduleOutputs || {};
    const normalized = normalizeModuleOutputsFromServer(raw);
    const mergedMo = mergeModuleOutputsPreferLonger(state.moduleOutputs || {}, normalized);
    const voice = String(evt.voiceOutput || '').trim();
    const reruns = Number(evt.rerunsUsed) || 0;
    const msDone = reconcileCompleteStatusesFromOutputs(state.moduleStatuses, mergedMo);
    const next = {
      ...state,
      moduleOutputs: mergedMo,
      moduleStatuses: msDone,
      finalOutput: voice,
      loopCount: reruns,
    };
    const pendingMeta = evt.metacognitionRerunPending;
    const partialLeg = evt.partial === true;
    let logMsg = `Pipeline complete${reruns > 0 ? ` (${reruns} metacognitive rerun(s))` : ''}`;
    if (partialLeg && pendingMeta) {
      const delayMin = resolveMetacognitionRerunDelayMinutes(getRuntimeSettings());
      const sup = String(pendingMeta.supervisor || '').trim() || 'Supervisor';
      const why = String(pendingMeta.reason || '').trim().slice(0, 160);
      logMsg = `Supervisor RERUN scheduled (~${delayMin} min) — Voice pending; continues from Perception. ${sup}${why ? `: ${why}` : ''}`;
    }
    return pushLog(next, logMsg, voice || undefined);
  }

  if (evt.type === 'error') {
    const full = formatPipelineSseErrorPayload(evt);
    const withHint = appendRateLimitRecoveryHint(full);
    return pushLog(state, `Error: ${withHint}`);
  }

  if (evt.type === 'attachments' && Array.isArray(evt.attachments) && evt.attachments.length) {
    return pushLog(state, `Attachments echoed: ${evt.attachments.length}`);
  }

  return state;
}

/**
 * Map curiosity page `moduleStatuses` into the same minimap snapshot shape as the consciousness stream.
 * @param {Record<string, string>} moduleStatuses
 * @param {boolean} isProcessing
 * @param {string} [statusPrefix] - defaults to shared strip label; override only for tests.
 */
export function computeCuriosityPipelineMinimapSnapshot(
  moduleStatuses,
  isProcessing,
  statusPrefix = PIPELINE_LIVE_STATUS_PREFIX
) {
  const ms = moduleStatuses && typeof moduleStatuses === 'object' ? moduleStatuses : {};
  const layers = getServerExecutionLayers();
  const entries = [];
  for (const row of layers) {
    for (const moduleId of row.moduleIds) {
      const st = ms[moduleId];
      if (st === 'complete') {
        const mod = getModule(moduleId);
        entries.push({
          type: 'module-complete',
          moduleId,
          moduleName: mod?.name ?? moduleId,
        });
      } else if (st === 'processing') {
        const mod = getModule(moduleId);
        entries.push({
          type: 'module-start',
          moduleId,
          moduleName: mod?.name ?? moduleId,
        });
        return computePipelineMinimapSnapshot(entries, isProcessing, { statusPrefix });
      }
      /* Skip not-yet-started / idle slots so a later processing module still produces a correct snapshot
         (sparse maps without backfilled completes — e.g. rehydrate lag). */
    }
  }
  return computePipelineMinimapSnapshot(entries, isProcessing, { statusPrefix });
}
