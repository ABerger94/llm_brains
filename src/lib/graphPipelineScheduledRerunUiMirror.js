import {
  mergePersistedGraphPipelineUiForSession,
  peekGraphPipelineUiPersisted,
} from './graphPipelineCrossSessionPeek';
import { getGraphPipelineSessionId } from './graphPipelineSessionScope';
import { graphPipelineStore } from './graphPipelineStore';
import { upsertGraphPipelineSession } from './graphPipelineSessionRegistry';
import {
  mergeModuleOutputsPreferLonger,
  normalizeModuleOutputsFromServer,
  resolvePipelineModuleUiIdForStream,
  sseModuleCompleteOutputText,
} from './cognitiveModules';
import { applyModuleStartToStatuses, reconcileCompleteStatusesFromOutputs } from './pipelineModuleStatusUi';
import { resolvePipelineVoiceText } from './pipelineVoiceGate';
import { slimSharedMemoryForGraphCheckpoint } from './slimSharedMemory';
import { scheduleIncrementalModuleCheckpointPersist } from './incrementalModuleCheckpointPersist';

function normalizeSid(graphSessionId) {
  return graphSessionId != null && String(graphSessionId).trim() ? String(graphSessionId).trim() : null;
}

function liveSessionMatches(sid) {
  return typeof window !== 'undefined' && sid != null && getGraphPipelineSessionId() === sid;
}

function appendPersistedLog(sid, msg, detail) {
  const peek = peekGraphPipelineUiPersisted(sid);
  const prev = Array.isArray(peek?.executionLog) ? peek.executionLog : [];
  const entry = { time: Date.now(), msg, ...(detail ? { detail: String(detail).slice(0, 200_000) } : {}) };
  mergePersistedGraphPipelineUiForSession(sid, { executionLog: [...prev, entry] });
  if (liveSessionMatches(sid)) {
    const st = graphPipelineStore.getState();
    const log = Array.isArray(st.executionLog) ? st.executionLog : [];
    graphPipelineStore.patch({ executionLog: [...log, entry] });
  }
}

/**
 * When a deferred `supervisor_pipeline_rerun` runs, the interactive graph page would otherwise stay frozen
 * on the last interactive leg’s module map. Bind SSE progress to the original graph session’s persisted KV
 * (and in-memory store when that session is active).
 */
export function beginGraphSessionSupervisorRerunUi(graphSessionId, opts = {}) {
  const sid = normalizeSid(graphSessionId);
  if (!sid) return;
  const line =
    opts.logLine ||
    'Supervisor RERUN — scheduled continuation (full graph from Perception)…';
  appendPersistedLog(sid, line);
  mergePersistedGraphPipelineUiForSession(sid, { isRunning: true, runError: null });
  upsertGraphPipelineSession({ id: sid, isProcessing: true });
  if (liveSessionMatches(sid)) {
    graphPipelineStore.patch({ isRunning: true, runError: null });
    graphPipelineStore.flushPersist();
  }
}

/**
 * @param {boolean} [opts.clearCheckpoint] - when true, clear cooperative checkpoint (successful full completion)
 */
export function endGraphSessionSupervisorRerunUi(graphSessionId, opts = {}) {
  const sid = normalizeSid(graphSessionId);
  if (!sid) return;
  const { clearCheckpoint = false } = opts;
  const peek = peekGraphPipelineUiPersisted(sid);
  const ms = { ...(peek?.moduleStatuses && typeof peek.moduleStatuses === 'object' ? peek.moduleStatuses : {}) };
  for (const k of Object.keys(ms)) {
    if (ms[k] === 'processing') ms[k] = 'complete';
  }
  /** @type {Record<string, unknown>} */
  const merge = { isRunning: false, cooperativePauseToken: null, moduleStatuses: ms };
  if (clearCheckpoint) merge.pipelineCheckpoint = null;
  mergePersistedGraphPipelineUiForSession(sid, merge);
  upsertGraphPipelineSession({ id: sid, isProcessing: false });
  if (liveSessionMatches(sid)) {
    const liveMs = { ...(graphPipelineStore.getState().moduleStatuses || {}) };
    for (const k of Object.keys(liveMs)) {
      if (liveMs[k] === 'processing') liveMs[k] = 'complete';
    }
    graphPipelineStore.patch({
      isRunning: false,
      cooperativePauseToken: null,
      moduleStatuses: liveMs,
      ...(clearCheckpoint ? { pipelineCheckpoint: null } : {}),
    });
    graphPipelineStore.flushPersist();
  }
}

/**
 * @param {string} graphSessionId
 * @param {object} evt - pipeline SSE event
 * @param {{
 *   promptText: string,
 *   attachmentIds?: string[],
 *   runtimeSettings: object,
 *   mindStorageProfile: string,
 *   pipelineOptionsSnapshot?: object,
 *   curiosityPursuitContext?: object|null,
 *   goalPursuitContext?: object|null,
 * }} ctx
 */
export function applyGraphSessionSupervisorRerunSseEvent(graphSessionId, evt, ctx) {
  const sid = normalizeSid(graphSessionId);
  if (!sid || !evt || typeof evt !== 'object') return;

  const peek = peekGraphPipelineUiPersisted(sid);
  const baseMs = peek?.moduleStatuses && typeof peek.moduleStatuses === 'object' ? { ...peek.moduleStatuses } : {};
  const baseMo = peek?.moduleOutputs && typeof peek.moduleOutputs === 'object' ? { ...peek.moduleOutputs } : {};
  const loopBase = Number(peek?.loopCount) || 0;

  if (evt.type === 'module_start') {
    const uiId = resolvePipelineModuleUiIdForStream(evt.moduleName);
    const ms = applyModuleStartToStatuses(baseMs, uiId);
    mergePersistedGraphPipelineUiForSession(sid, { moduleStatuses: ms });
    if (liveSessionMatches(sid)) {
      const st = graphPipelineStore.getState();
      graphPipelineStore.patch({
        moduleStatuses: applyModuleStartToStatuses(st.moduleStatuses || {}, uiId),
      });
    }
    return;
  }

  if (evt.type === 'module_complete') {
    const uiId = resolvePipelineModuleUiIdForStream(evt.moduleName);
    const pieceStr = sseModuleCompleteOutputText(evt);
    /** @type {Record<string, string>} */
    const ms = { ...baseMs, ...(uiId ? { [uiId]: 'complete' } : {}) };
    /** @type {Record<string, string>} */
    const mo =
      uiId && pieceStr !== null
        ? { ...baseMo, [uiId]: pieceStr }
        : { ...baseMo };
    mergePersistedGraphPipelineUiForSession(sid, { moduleStatuses: ms, moduleOutputs: mo });

    if (
      evt.executionCheckpoint &&
      evt.sharedMemory &&
      ctx.pipelineOptionsSnapshot?.incrementalModuleCheckpoint !== false
    ) {
      const checkpoint = {
        savedAt: Date.now(),
        executionCursor: evt.executionCheckpoint,
        slimSharedMemory: slimSharedMemoryForGraphCheckpoint(evt.sharedMemory),
        moduleOutputsSnapshot: { ...mo },
        moduleStatusesSnapshot: { ...ms },
        userInput: ctx.promptText,
        attachmentIds: Array.isArray(ctx.attachmentIds) ? ctx.attachmentIds : [],
        graphSessionId: sid,
        mindStorageProfile: ctx.mindStorageProfile,
      };
      mergePersistedGraphPipelineUiForSession(sid, { pipelineCheckpoint: checkpoint });
      scheduleIncrementalModuleCheckpointPersist({
        evt,
        promptText: ctx.promptText,
        runtimeSettings: ctx.runtimeSettings,
        source: 'supervisor-rerun-scheduled',
        curiosityPursuitContext: ctx.curiosityPursuitContext ?? null,
        goalPursuitContext: ctx.goalPursuitContext ?? null,
        graphSessionIdForPipelineRun: sid,
        mindStorageProfile: ctx.mindStorageProfile,
      });
    }

    if (liveSessionMatches(sid)) {
      const stMc = graphPipelineStore.getState();
      /** @type {Record<string, unknown>} */
      const graphPatch = {};
      if (uiId) {
        graphPatch.moduleStatuses = { ...(stMc.moduleStatuses || {}), [uiId]: 'complete' };
        graphPatch.moduleOutputs =
          pieceStr !== null
            ? { ...(stMc.moduleOutputs || {}), [uiId]: pieceStr }
            : { ...(stMc.moduleOutputs || {}) };
      }
      if (Object.keys(graphPatch).length) graphPipelineStore.patch(graphPatch);
      const stAfter = graphPipelineStore.getState();
      if (
        evt.executionCheckpoint &&
        evt.sharedMemory &&
        ctx.pipelineOptionsSnapshot?.incrementalModuleCheckpoint !== false
      ) {
        graphPipelineStore.patch({
          pipelineCheckpoint: {
            savedAt: Date.now(),
            executionCursor: evt.executionCheckpoint,
            slimSharedMemory: slimSharedMemoryForGraphCheckpoint(evt.sharedMemory),
            moduleOutputsSnapshot: { ...(stAfter.moduleOutputs || {}) },
            moduleStatusesSnapshot: { ...(stAfter.moduleStatuses || {}) },
            userInput: ctx.promptText,
            attachmentIds: Array.isArray(ctx.attachmentIds) ? ctx.attachmentIds : [],
            graphSessionId: sid,
            mindStorageProfile: ctx.mindStorageProfile,
          },
        });
        graphPipelineStore.flushPersist();
      }
    }
    return;
  }

  if (evt.type === 'rerun') {
    const nextLoop = Number(evt.rerunsUsed) || loopBase;
    mergePersistedGraphPipelineUiForSession(sid, { loopCount: nextLoop });
    if (liveSessionMatches(sid)) graphPipelineStore.patch({ loopCount: nextLoop });
    return;
  }

  if (evt.type === 'pipeline_continuation') {
    const sup = String(evt.supervisor || '').trim() || 'Supervisor';
    const r = String(evt.reason || '').trim();
    const msg = `Continuation (${sup}) — next leg from layer 1…`;
    appendPersistedLog(sid, msg, r || undefined);
    return;
  }

  if (evt.type === 'complete') {
    const raw = evt.sharedMemory?.moduleOutputs || {};
    const normalized = normalizeModuleOutputsFromServer(raw);
    const mergedMo = mergeModuleOutputsPreferLonger(baseMo, normalized);
    const msDone = reconcileCompleteStatusesFromOutputs(baseMs, mergedMo);
    const finalVoiceLine = resolvePipelineVoiceText(
      { voiceOutput: evt.voiceOutput, sharedMemory: evt.sharedMemory },
      mergedMo
    );
    const nextLoop = Number(evt.rerunsUsed) || loopBase;
    const nextArousal =
      typeof evt.arousalEffective === 'number' && Number.isFinite(evt.arousalEffective)
        ? evt.arousalEffective
        : undefined;
    /** @type {Record<string, unknown>} */
    const merge = {
      moduleOutputs: mergedMo,
      moduleStatuses: msDone,
      finalOutput: finalVoiceLine,
      loopCount: nextLoop,
      lastSharedMemory: evt.sharedMemory || null,
    };
    if (nextArousal !== undefined) merge.arousal = nextArousal;
    mergePersistedGraphPipelineUiForSession(sid, merge);
    if (liveSessionMatches(sid)) {
      const stComplete = graphPipelineStore.getState();
      const mergedLiveMo = mergeModuleOutputsPreferLonger(stComplete.moduleOutputs || {}, normalized);
      const msLiveDone = reconcileCompleteStatusesFromOutputs(stComplete.moduleStatuses || {}, mergedLiveMo);
      const arousalLive =
        typeof evt.arousalEffective === 'number' && Number.isFinite(evt.arousalEffective)
          ? evt.arousalEffective
          : stComplete.arousal;
      graphPipelineStore.patch({
        moduleOutputs: mergedLiveMo,
        moduleStatuses: msLiveDone,
        finalOutput: finalVoiceLine,
        loopCount: nextLoop,
        lastSharedMemory: evt.sharedMemory || null,
        arousal: arousalLive,
      });
      graphPipelineStore.flushPersist();
    }
    return;
  }

  if (evt.type === 'paused') {
    const smP = evt.sharedMemory && typeof evt.sharedMemory === 'object' ? evt.sharedMemory : null;
    if (smP) {
      mergePersistedGraphPipelineUiForSession(sid, { lastSharedMemory: smP });
      if (liveSessionMatches(sid)) graphPipelineStore.patch({ lastSharedMemory: smP });
    }
  }
}
