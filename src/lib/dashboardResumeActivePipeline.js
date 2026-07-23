import { setCooperativePauseAllExternalHold } from './cooperativePauseAllExternalHold';
import { graphSessionIdFromActiveWorkRowHref } from './dashboardAbortActivePipeline';
import { syncDashboardScheduledRunningFromDb } from './dashboardScheduledRunningSync';
import { healGraphRegistryWhenPersistSaysIdle } from './graphSessionStaleRunningHeal';
import { notifyMindStorageChanged } from './mindStorageEvents';
import { getActiveConsciousnessStreamGraphSessionId } from './consciousnessStreamRunner';
import { getLastOpenedGraphPipelineSessionId } from './graphPipelineSessionRegistry';
import { DEFAULT_GRAPH_SESSION_ID, getGraphPipelineSessionId } from './graphPipelineSessionScope';
import { resumeCooperativeGraphCheckpointForSession } from './reconnectRecovery';
import {
  runOneInterruptedCuriosityRerun,
  runOneInterruptedGoalRerun,
} from './reloadInterruptedPipelineWork';
import { resumePausedScheduledPipelineTask } from './scheduledTaskRunner';

function resolveGraphSessionIdForRow(row) {
  return (
    graphSessionIdFromActiveWorkRowHref(row) ||
    getGraphPipelineSessionId() ||
    getActiveConsciousnessStreamGraphSessionId() ||
    getLastOpenedGraphPipelineSessionId() ||
    DEFAULT_GRAPH_SESSION_ID
  );
}

/**
 * Resume one cooperative-pause / saved-checkpoint row from the Dashboard active-pipeline list.
 *
 * @param {{ key: string, variant?: string, href?: string }} row
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function resumeDashboardActivePipelineRow(row) {
  const key = String(row?.key || '');
  if (!key) return { ok: false, message: 'Nothing to resume.' };

  setCooperativePauseAllExternalHold(false);

  try {
    if (key === 'graph-pipeline-checkpoint') {
      const sid = resolveGraphSessionIdForRow(row);
      const r = await resumeCooperativeGraphCheckpointForSession(sid);
      return r.ok ? r : { ok: false, message: r.message || 'Could not resume graph checkpoint.' };
    }

    if (key.startsWith('curiosity-')) {
      const id = key.slice('curiosity-'.length);
      const r = await runOneInterruptedCuriosityRerun(id);
      if (r.ok) return { ok: true, message: 'Curiosity pursuit resumed from checkpoint.' };
      return { ok: false, message: r.error || 'Could not resume curiosity pursuit.' };
    }

    if (key.startsWith('goal-')) {
      const id = key.slice('goal-'.length);
      const r = await runOneInterruptedGoalRerun(id);
      if (r.ok) return { ok: true, message: 'Goal pursuit resumed from checkpoint.' };
      return { ok: false, message: r.error || 'Could not resume goal pursuit.' };
    }

    if (key.startsWith('scheduler-task-')) {
      const taskId = key.slice('scheduler-task-'.length).trim();
      if (!taskId) return { ok: false, message: 'Invalid scheduler row.' };
      await resumePausedScheduledPipelineTask(taskId);
      return { ok: true, message: 'Scheduler pipeline resumed from checkpoint.' };
    }

    return { ok: false, message: 'This row does not support resume from here.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    healGraphRegistryWhenPersistSaysIdle();
    void syncDashboardScheduledRunningFromDb();
    notifyMindStorageChanged({ source: 'dashboard-resume-one' });
  }
}
