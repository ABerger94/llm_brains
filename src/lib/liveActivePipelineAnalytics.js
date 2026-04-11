import { graphPipelineStore } from './graphPipelineStore';
import { consciousnessStreamStore } from './consciousnessStreamStore';
import { peekConsciousnessStreamDraftForSession, peekGraphPipelineUiPersisted } from './graphPipelineCrossSessionPeek';
import {
  getCuriosityPagePursuitSnapshot,
} from './curiosityPagePursuitStore';
import { getGoalPagePursuitSnapshot } from './goalPagePursuitStore';
import { getSchedulerPipelineUiSnapshot } from './schedulerPipelineUiStore';
import { hasKnownPipelineModuleProcessing, countKnownPipelineModulesProcessing } from './cognitiveModules';
import {
  buildDashboardActiveWorkRows,
  isGraphPeekPipelineEffectivelyComplete,
  subscribeDashboardActiveWork,
} from './dashboardActiveWork';
import { initialCuriosityPipelineUi } from './curiosityPipelineSseUi';
import { initialGoalPipelineUi } from './goalPipelineSseUi';
import { computeLiveIdentityStabilityFromSources } from './liveMindSnapshotDerived';

/**
 * @param {{
 *   moduleOutputs?: Record<string, string>,
 *   moduleStatuses?: Record<string, string>,
 *   finalOutput?: string,
 *   executionLog?: unknown[],
 *   runError?: unknown,
 * }} src
 */
function fingerprintSource(src) {
  if (!src) return '';
  const mo = src.moduleOutputs && typeof src.moduleOutputs === 'object' ? src.moduleOutputs : {};
  const ms = src.moduleStatuses && typeof src.moduleStatuses === 'object' ? src.moduleStatuses : {};
  const moPart = Object.keys(mo)
    .sort()
    .map((k) => `${k}:${String(mo[k] ?? '').length}`)
    .join('|');
  const msPart = Object.keys(ms)
    .sort()
    .map((k) => `${k}:${ms[k]}`)
    .join('|');
  const logLen = Array.isArray(src.executionLog) ? src.executionLog.length : 0;
  const err = src.runError != null && String(src.runError).trim() ? String(src.runError) : '';
  return `${moPart}#${msPart}#${String(src.finalOutput ?? '').length}#${logLen}#${err.length}:${err.slice(0, 64)}`;
}

/** @param {{ key: string, interrupted?: boolean }} row */
function buildLiveSourceForRow(row) {
  const gp = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();

  if (row.key === 'graph-pipeline' || row.key === 'graph-pipeline-interrupted') {
    const interrupted = row.key === 'graph-pipeline-interrupted';
    return {
      kind: 'graph',
      moduleOutputs: gp.moduleOutputs && typeof gp.moduleOutputs === 'object' ? gp.moduleOutputs : {},
      moduleStatuses: gp.moduleStatuses && typeof gp.moduleStatuses === 'object' ? gp.moduleStatuses : {},
      finalOutput: typeof gp.finalOutput === 'string' ? gp.finalOutput : '',
      executionLog: Array.isArray(gp.executionLog) ? gp.executionLog : [],
      loopCount: Number(gp.loopCount) || 0,
      isProcessing: Boolean(gp.isRunning || cs.isProcessing) && !interrupted,
      runError: typeof gp.runError === 'string' ? gp.runError : null,
    };
  }

  if (row.key === 'graph-pipeline-checkpoint') {
    return {
      kind: 'graph',
      moduleOutputs: gp.moduleOutputs && typeof gp.moduleOutputs === 'object' ? gp.moduleOutputs : {},
      moduleStatuses: gp.moduleStatuses && typeof gp.moduleStatuses === 'object' ? gp.moduleStatuses : {},
      finalOutput: typeof gp.finalOutput === 'string' ? gp.finalOutput : '',
      executionLog: Array.isArray(gp.executionLog) ? gp.executionLog : [],
      loopCount: Number(gp.loopCount) || 0,
      isProcessing: false,
      runError: typeof gp.runError === 'string' ? gp.runError : null,
    };
  }

  if (row.key.startsWith('graph-pipeline-session-')) {
    const sessionId = row.key.slice('graph-pipeline-session-'.length).trim();
    const peek = sessionId ? peekGraphPipelineUiPersisted(sessionId) : null;
    const draft = peekConsciousnessStreamDraftForSession(sessionId);
    const mo = peek?.moduleOutputs && typeof peek.moduleOutputs === 'object' ? peek.moduleOutputs : {};
    const ms = peek?.moduleStatuses && typeof peek.moduleStatuses === 'object' ? peek.moduleStatuses : {};
    const completeEffective = isGraphPeekPipelineEffectivelyComplete(peek, draft);
    const looksRunning =
      !completeEffective &&
      (Boolean(peek?.isRunning) ||
        Boolean(draft.inFlight) ||
        hasKnownPipelineModuleProcessing(ms));
    return {
      kind: 'graph',
      sessionId,
      moduleOutputs: mo,
      moduleStatuses: ms,
      finalOutput: typeof peek?.finalOutput === 'string' ? peek.finalOutput : '',
      executionLog: Array.isArray(peek?.executionLog) ? peek.executionLog : [],
      loopCount: Number(peek?.loopCount) || 0,
      isProcessing: looksRunning,
      runError: typeof peek?.runError === 'string' ? peek.runError : null,
    };
  }

  if (row.key.startsWith('scheduler-task-')) {
    const taskId = row.key.slice('scheduler-task-'.length);
    const ent = getSchedulerPipelineUiSnapshot().byTaskId[taskId];
    const ui = ent?.ui && typeof ent.ui === 'object' ? ent.ui : initialCuriosityPipelineUi();
    return {
      kind: 'scheduler',
      taskId,
      moduleOutputs: ui.moduleOutputs && typeof ui.moduleOutputs === 'object' ? ui.moduleOutputs : {},
      moduleStatuses: ui.moduleStatuses && typeof ui.moduleStatuses === 'object' ? ui.moduleStatuses : {},
      finalOutput: typeof ui.finalOutput === 'string' ? ui.finalOutput : '',
      executionLog: Array.isArray(ui.executionLog) ? ui.executionLog : [],
      loopCount: Number(ui.loopCount) || 0,
      isProcessing: true,
      runError: typeof ui.runError === 'string' ? ui.runError : null,
    };
  }

  if (row.key.startsWith('curiosity-')) {
    const id = row.key.slice('curiosity-'.length);
    const p = getCuriosityPagePursuitSnapshot().pursuits?.[id];
    const ui =
      p?.curiosityPipelineUi && typeof p.curiosityPipelineUi === 'object'
        ? p.curiosityPipelineUi
        : initialCuriosityPipelineUi();
    return {
      kind: 'curiosity',
      pursuitId: id,
      moduleOutputs: ui.moduleOutputs && typeof ui.moduleOutputs === 'object' ? ui.moduleOutputs : {},
      moduleStatuses: ui.moduleStatuses && typeof ui.moduleStatuses === 'object' ? ui.moduleStatuses : {},
      finalOutput: typeof ui.finalOutput === 'string' ? ui.finalOutput : '',
      executionLog: Array.isArray(ui.executionLog) ? ui.executionLog : [],
      loopCount: Number(ui.loopCount) || 0,
      isProcessing: Boolean(p?.running),
      runError: null,
    };
  }

  if (row.key.startsWith('goal-')) {
    const id = row.key.slice('goal-'.length);
    const p = getGoalPagePursuitSnapshot().pursuits?.[id];
    const ui =
      p?.goalPipelineUi && typeof p.goalPipelineUi === 'object'
        ? p.goalPipelineUi
        : initialGoalPipelineUi();
    return {
      kind: 'goal',
      pursuitId: id,
      moduleOutputs: ui.moduleOutputs && typeof ui.moduleOutputs === 'object' ? ui.moduleOutputs : {},
      moduleStatuses: ui.moduleStatuses && typeof ui.moduleStatuses === 'object' ? ui.moduleStatuses : {},
      finalOutput: typeof ui.finalOutput === 'string' ? ui.finalOutput : '',
      executionLog: Array.isArray(ui.executionLog) ? ui.executionLog : [],
      loopCount: Number(ui.loopCount) || 0,
      isProcessing: Boolean(p?.running),
      runError: null,
    };
  }

  return {
    kind: 'unknown',
    moduleOutputs: {},
    moduleStatuses: {},
    finalOutput: '',
    executionLog: [],
    loopCount: 0,
    isProcessing: false,
    runError: null,
  };
}

/** @param {ReturnType<typeof buildDashboardActiveWorkRows>} rows */
function computeSnapshotKey(rows, sources) {
  const rowPart = rows
    .map(
      (r) =>
        `${r.key}\x00${r.title}\x00${r.detail}\x00${r.pipelineProgress ?? ''}\x00${r.interrupted ? 1 : 0}\x00${r.variant}`
    )
    .join('\x01');
  const srcPart = sources.map((s) => fingerprintSource(s)).join('\x02');
  const gp = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();
  const gMeta = `${gp.isRunning ? 1 : 0}${cs.isProcessing ? 1 : 0}${Number(gp.loopCount) || 0}${gp.uploading ? 1 : 0}`;
  const sm = gp.lastSharedMemory;
  const smKey =
    sm && typeof sm === 'object'
      ? `${String(sm.sessionId || '')}|${String(sm.userStancePrediction?.expectUserWants || '').length}|${String(sm.originalInput || '').length}|${String(sm.phenomenalNow?.line || '').length}`
      : '';
  return `${rowPart}\x03${srcPart}\x03${gMeta}\x04${smKey}`;
}

/** @param {ReturnType<typeof buildDashboardActiveWorkRows>} rows */
function computeLiveMetrics(rows, sources, stanceAlignmentPercent) {
  let processingModules = 0;
  let nonEmptyModuleOutputs = 0;
  for (const s of sources) {
    if (!s) continue;
    const ms = s.moduleStatuses || {};
    processingModules += countKnownPipelineModulesProcessing(ms);
    const mo = s.moduleOutputs || {};
    for (const v of Object.values(mo)) {
      if (String(v || '').trim()) nonEmptyModuleOutputs += 1;
    }
  }
  return {
    activePipelines: rows.length,
    processingModules,
    nonEmptyModuleOutputs,
    stanceAlignmentPercent,
  };
}

/** @type {{ rows: object[], sources: unknown[], metrics: object, graphLastSharedMemory: object|null } | null} */
let cachedLiveSnapshot = null;
let cachedLiveKey = '';

/** Live pipelines + module outputs from this tab's stores (see {@link buildDashboardActiveWorkRows}). */
export function getLiveActivePipelineAnalyticsSnapshot() {
  const rows = buildDashboardActiveWorkRows();
  const sources = rows.map((r) => buildLiveSourceForRow(r));
  const gp = graphPipelineStore.getState();
  const graphLastSharedMemory =
    gp.lastSharedMemory && typeof gp.lastSharedMemory === 'object' ? gp.lastSharedMemory : null;
  const stability = computeLiveIdentityStabilityFromSources(sources, graphLastSharedMemory);
  const stabPart =
    typeof stability.overlap === 'number' && Number.isFinite(stability.overlap)
      ? stability.overlap.toFixed(5)
      : `n:${stability.tier}`;
  const key = `${computeSnapshotKey(rows, sources)}\x05${stabPart}`;
  if (key === cachedLiveKey && cachedLiveSnapshot) return cachedLiveSnapshot;
  cachedLiveKey = key;
  const overlap = stability.overlap;
  const stanceAlignmentPercent =
    typeof overlap === 'number' && Number.isFinite(overlap) ? Math.round(overlap * 100) : null;
  const metrics = computeLiveMetrics(rows, sources, stanceAlignmentPercent);
  cachedLiveSnapshot = { rows, sources, metrics, graphLastSharedMemory };
  return cachedLiveSnapshot;
}

/** Same subscriptions as the Dashboard active-work strip so Live Analytics updates in lockstep. */
export function subscribeLiveActivePipelineAnalytics(onStoreChange) {
  return subscribeDashboardActiveWork(onStoreChange);
}
