import { CuriosityItem, GoalItem } from './data';
import { stopScheduledTaskRunFromUi } from './scheduledTaskRunner';
import {
  abortActiveConsciousnessStreamRun,
  getActiveConsciousnessStreamGraphSessionId,
} from './consciousnessStreamRunner';
import { clearGraphSessionStaleRunningState } from './graphSessionStaleRunningHeal';
import { consciousnessStreamStore } from './consciousnessStreamStore';
import { graphPipelineStore } from './graphPipelineStore';
import {
  getLastOpenedGraphPipelineSessionId,
} from './graphPipelineSessionRegistry';
import {
  DEFAULT_GRAPH_SESSION_ID,
  getGraphPipelineSessionId,
} from './graphPipelineSessionScope';
import {
  abortRegisteredCuriosityPursuitGraph,
  abortRegisteredGoalPursuitGraph,
} from './pursuitGraphPipelineAbortRegistry';
import { removeCuriosityPursuit } from './curiosityPagePursuitStore';
import { removeGoalPursuit } from './goalPagePursuitStore';

function isAbortError(e) {
  if (!e) return false;
  if (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') return true;
  if (e instanceof Error && e.name === 'AbortError') return true;
  const m = String(e.message || '').toLowerCase();
  return m.includes('aborted') || m.includes('abort');
}

export { isAbortError };

/** @param {{ href?: string }} row */
function graphSessionIdFromActiveWorkRowHref(row) {
  const href = String(row?.href || '');
  const m = href.match(/\/graph-pipeline\/([^/?#]+)/);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Dashboard “Stop” for one row from {@link getDashboardActiveWorkSnapshot}.rows[].
 * @param {{ key: string, variant: string, href?: string }} row
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function abortDashboardActivePipelineRow(row) {
  const key = String(row?.key || '');
  if (!key) return { ok: false, message: 'Nothing to stop.' };

  if (key === 'graph-pipeline') {
    const gp = graphPipelineStore.getState();
    const cs = consciousnessStreamStore.getState();
    const wasBusy = Boolean(gp.isRunning || cs.isProcessing);
    abortActiveConsciousnessStreamRun();
    const sid =
      graphSessionIdFromActiveWorkRowHref(row) ||
      getGraphPipelineSessionId() ||
      getActiveConsciousnessStreamGraphSessionId() ||
      getLastOpenedGraphPipelineSessionId() ||
      DEFAULT_GRAPH_SESSION_ID;
    clearGraphSessionStaleRunningState(sid, { force: true });
    return {
      ok: true,
      message: wasBusy
        ? 'Graph pipeline stopped and state cleared.'
        : 'Cleared stale running state for this workspace.',
    };
  }

  if (key === 'graph-pipeline-interrupted') {
    consciousnessStreamStore.dismissInterrupted();
    const sid =
      graphSessionIdFromActiveWorkRowHref(row) ||
      getGraphPipelineSessionId() ||
      getActiveConsciousnessStreamGraphSessionId() ||
      getLastOpenedGraphPipelineSessionId() ||
      DEFAULT_GRAPH_SESSION_ID;
    clearGraphSessionStaleRunningState(sid, { force: true });
    return { ok: true, message: 'Interrupted notice cleared.' };
  }

  if (key === 'graph-pipeline-checkpoint') {
    graphPipelineStore.clearPipelineCheckpoint();
    consciousnessStreamStore.dismissInterrupted();
    const sid =
      graphSessionIdFromActiveWorkRowHref(row) ||
      getGraphPipelineSessionId() ||
      getActiveConsciousnessStreamGraphSessionId() ||
      getLastOpenedGraphPipelineSessionId() ||
      DEFAULT_GRAPH_SESSION_ID;
    clearGraphSessionStaleRunningState(sid, { force: true });
    return { ok: true, message: 'Checkpoint discarded. Use Resume all if you still need to resume other paused work.' };
  }

  if (key.startsWith('graph-pipeline-session-')) {
    let sid = key.slice('graph-pipeline-session-'.length).trim();
    if (!sid) return { ok: false, message: 'Invalid graph session row.' };
    try {
      sid = decodeURIComponent(sid);
    } catch {
      /* keep raw */
    }
    if (getActiveConsciousnessStreamGraphSessionId() === sid) {
      abortActiveConsciousnessStreamRun();
      return { ok: true, message: 'Graph pipeline stop requested.' };
    }
    clearGraphSessionStaleRunningState(sid, { force: true });
    return {
      ok: true,
      message:
        'Cleared stale “running” flags for this workspace (e.g. after a reload). No live pipeline was attached in this tab.',
    };
  }

  if (key.startsWith('curiosity-')) {
    const id = key.slice('curiosity-'.length);
    abortRegisteredCuriosityPursuitGraph(id);
    removeCuriosityPursuit(id);
    try {
      await CuriosityItem.update(id, { status: 'open' });
    } catch {
      /* ignore */
    }
    return { ok: true, message: 'Curiosity pursuit stopped.' };
  }

  if (key.startsWith('scheduler-task-')) {
    const taskId = key.slice('scheduler-task-'.length).trim();
    if (!taskId) return { ok: false, message: 'Invalid scheduler row.' };
    return stopScheduledTaskRunFromUi(taskId, { resultSummary: 'Stopped from dashboard.' });
  }

  if (key.startsWith('goal-')) {
    const id = key.slice('goal-'.length);
    abortRegisteredGoalPursuitGraph(id);
    removeGoalPursuit(id);
    try {
      await GoalItem.update(id, { status: 'open' });
    } catch {
      /* ignore */
    }
    return { ok: true, message: 'Goal pursuit stopped.' };
  }

  return { ok: false, message: 'Unknown pipeline row.' };
}
