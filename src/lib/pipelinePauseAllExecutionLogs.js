import { consciousnessStreamStore } from './consciousnessStreamStore';
import { appendCuriosityPursuitExecutionLogLineAllRunning } from './curiosityPagePursuitStore';
import { appendGoalPursuitExecutionLogLineAllRunning } from './goalPagePursuitStore';
import { graphPipelineStore } from './graphPipelineStore';
import { appendSchedulerPipelineExecutionLogLineAllTasks } from './schedulerPipelineUiStore';
import { hasKnownPipelineModuleProcessing } from './cognitiveModules';

/** Shown in graph, curiosity, goal, and scheduler pipeline execution logs after Pause & save all succeeds in this tab. */
export const COOPERATIVE_PAUSE_ALL_LOG_MSG =
  'Pause & save all — cooperative pause requested (pipeline stops after the current module).';

/**
 * @param {{ failCount: number, okCount: number }} r
 * @returns {boolean}
 */
export function cooperativePauseAllRequestsSucceeded(r) {
  return r.failCount === 0 && r.okCount > 0;
}

/** True if at least one pause-request POST succeeded (append logs + dashboard ack even if others failed). */
export function cooperativePauseAnyRequestOk(r) {
  return Number(r?.okCount) > 0;
}

function graphPipelineExecutionLooksActive() {
  const gp = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();
  if (cs.isProcessing || gp.isRunning) return true;
  const ms = gp.moduleStatuses && typeof gp.moduleStatuses === 'object' ? gp.moduleStatuses : {};
  return hasKnownPipelineModuleProcessing(ms);
}

/**
 * Append {@link COOPERATIVE_PAUSE_ALL_LOG_MSG} to every in-tab pipeline execution log when
 * pause-request POSTs succeeded for registered tokens in this browser tab.
 */
export function appendCooperativePauseAllRequestedToExecutionLogs() {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const line = { time: now, msg: COOPERATIVE_PAUSE_ALL_LOG_MSG };

  if (graphPipelineExecutionLooksActive()) {
    const prev = graphPipelineStore.getState().executionLog || [];
    graphPipelineStore.patch({ executionLog: [...prev, line].slice(-40) });
  }

  appendCuriosityPursuitExecutionLogLineAllRunning(line);
  appendGoalPursuitExecutionLogLineAllRunning(line);

  appendSchedulerPipelineExecutionLogLineAllTasks(line);
}
