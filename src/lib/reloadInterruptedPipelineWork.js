import { CuriosityItem, GoalItem, PipelineRun, ScheduledTask } from './data';
import {
  inferExecutionResumeFromPausedPipelineRun,
  isCheckpointPipelineRun,
} from './pipelineRunCheckpoint';
import { normalizeExecutionResume } from '../../shared/pipelineExecutionResume.mjs';
import {
  flushCuriosityPursuitsPersistNow,
  reloadCuriosityPursuitsFromPersistedDisk,
  getCuriosityPagePursuitSnapshot,
  upsertCuriosityPursuit,
  patchCuriosityPursuitEntry,
  updateCuriosityPursuitPipelineUiForId,
  removeCuriosityPursuit,
} from './curiosityPagePursuitStore';
import {
  flushGoalPursuitsPersistNow,
  reloadGoalPursuitsFromPersistedDisk,
  getGoalPagePursuitSnapshot,
  upsertGoalPursuit,
  patchGoalPagePursuitEntry,
  updateGoalPagePursuitPipelineUiForId,
  removeGoalPursuit,
} from './goalPagePursuitStore';
import { setCooperativePauseAllExternalHold } from './cooperativePauseAllExternalHold';
import {
  flushSchedulerDueTasksNow,
  listPausedScheduledGraphTasks,
  resumePausedScheduledPipelineTask,
} from './scheduledTaskRunner';
import { resumeInterruptedGraphPipelineManual } from './reconnectRecovery';
import { notifyMindStorageChanged } from './mindStorageEvents';
import { runCuriosityDeepPursuitChain } from './curiosityPursuit';
import { runGoalDeepPursuitChain } from './goalPursuit';
import {
  clearCuriosityPursuitGraphAbort,
  clearGoalPursuitGraphAbort,
  registerCuriosityPursuitGraphAbort,
  registerGoalPursuitGraphAbort,
} from './pursuitGraphPipelineAbortRegistry';
import { initialCuriosityPipelineUi, reduceCuriosityPipelineSse } from './curiosityPipelineSseUi';
import { initialGoalPipelineUi, reduceGoalPipelineSse } from './goalPipelineSseUi';
import { healGraphRegistryWhenPersistSaysIdle } from './graphSessionStaleRunningHeal';
import { syncDashboardScheduledRunningFromDb } from './dashboardScheduledRunningSync';

async function collectCuriosityIdsWithPausedLastGraphRun() {
  let items = [];
  try {
    items = await CuriosityItem.list('-created_date', 200);
  } catch {
    return [];
  }
  const ids = [];
  for (const item of items) {
    const rid = item.last_pursuit_pipeline_run_id;
    if (!rid) continue;
    let run;
    try {
      run = await PipelineRun.retrieve(String(rid));
    } catch {
      continue;
    }
    if (!run || !isCheckpointPipelineRun(run)) continue;
    const er =
      normalizeExecutionResume(run.execution_resume) || inferExecutionResumeFromPausedPipelineRun(run);
    if (!er) continue;
    ids.push(String(item.id));
  }
  return ids;
}

async function collectGoalIdsWithPausedLastGraphRun() {
  let items = [];
  try {
    items = await GoalItem.list('-created_date', 200);
  } catch {
    return [];
  }
  const ids = [];
  for (const item of items) {
    const rid = item.last_pursuit_pipeline_run_id;
    if (!rid) continue;
    let run;
    try {
      run = await PipelineRun.retrieve(String(rid));
    } catch {
      continue;
    }
    if (!run || !isCheckpointPipelineRun(run)) continue;
    const er =
      normalizeExecutionResume(run.execution_resume) || inferExecutionResumeFromPausedPipelineRun(run);
    if (!er) continue;
    ids.push(String(item.id));
  }
  return ids;
}

async function rerunInterruptedCuriosityPursuit(item) {
  const cid = item.id;
  const ac = new AbortController();
  registerCuriosityPursuitGraphAbort(cid, ac);
  upsertCuriosityPursuit(cid, {
    running: true,
    interruptedByReload: false,
    cooperativePaused: false,
    pursuitProgress: 'Starting…',
    curiosityPipelineUi: initialCuriosityPipelineUi(),
    question: String(item.question || '').trim() || undefined,
  });
  let pipelinePaused = false;
  try {
    const { pipelinePaused: didPause } = await runCuriosityDeepPursuitChain(item, {
      signal: ac.signal,
      onProgress: (label) => {
        patchCuriosityPursuitEntry(cid, { pursuitProgress: label });
        updateCuriosityPursuitPipelineUiForId(cid, (prev) => ({
          ...prev,
          moduleStatuses: {},
          moduleOutputs: {},
          loopCount: 0,
          finalOutput: '',
          executionLog: [...prev.executionLog, { time: Date.now(), msg: `── ${label} ──` }],
        }));
      },
      onPipelineSse: (evt) => {
        updateCuriosityPursuitPipelineUiForId(cid, (prev) => reduceCuriosityPipelineSse(prev, evt));
      },
    });
    pipelinePaused = Boolean(didPause);
    notifyMindStorageChanged({ source: 'curiosity' });
  } catch (e) {
    console.error('[rerun-interrupted] curiosity pursuit failed', cid, e);
    try {
      await CuriosityItem.update(item.id, { status: 'open' });
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    clearCuriosityPursuitGraphAbort(cid);
    if (pipelinePaused) {
      patchCuriosityPursuitEntry(cid, {
        running: false,
        interruptedByReload: false,
        cooperativePaused: true,
        pursuitProgress: 'Paused — cooperative checkpoint saved. Open Curiosity to continue.',
      });
      flushCuriosityPursuitsPersistNow();
    } else {
      patchCuriosityPursuitEntry(cid, {
        running: false,
        pursuitProgress: null,
        interruptedByReload: false,
        cooperativePaused: false,
      });
    }
  }
}

async function rerunInterruptedGoalPursuit(item) {
  const gid = item.id;
  const ac = new AbortController();
  registerGoalPursuitGraphAbort(gid, ac);
  upsertGoalPursuit(gid, {
    running: true,
    interruptedByReload: false,
    cooperativePaused: false,
    pursuitProgress: 'Starting…',
    goalPipelineUi: initialGoalPipelineUi(),
    goalStatement: String(item.goal_statement || '').trim() || undefined,
  });
  let pipelinePaused = false;
  try {
    const { pipelinePaused: didPause } = await runGoalDeepPursuitChain(item, {
      signal: ac.signal,
      onProgress: (label) => {
        patchGoalPagePursuitEntry(gid, { pursuitProgress: label });
        updateGoalPagePursuitPipelineUiForId(gid, (prev) => ({
          ...prev,
          moduleStatuses: {},
          moduleOutputs: {},
          loopCount: 0,
          finalOutput: '',
          executionLog: [...prev.executionLog, { time: Date.now(), msg: `── ${label} ──` }],
        }));
      },
      onPipelineSse: (evt) => {
        updateGoalPagePursuitPipelineUiForId(gid, (prev) => reduceGoalPipelineSse(prev, evt));
      },
    });
    pipelinePaused = Boolean(didPause);
    notifyMindStorageChanged({ source: 'goals' });
  } catch (e) {
    console.error('[rerun-interrupted] goal pursuit failed', gid, e);
    try {
      await GoalItem.update(item.id, { status: 'open' });
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    clearGoalPursuitGraphAbort(gid);
    if (pipelinePaused) {
      patchGoalPagePursuitEntry(gid, {
        running: false,
        interruptedByReload: false,
        cooperativePaused: true,
        pursuitProgress: 'Paused — cooperative checkpoint saved. Open Goals to continue.',
      });
      flushGoalPursuitsPersistNow();
    } else {
      patchGoalPagePursuitEntry(gid, {
        running: false,
        pursuitProgress: null,
        interruptedByReload: false,
        cooperativePaused: false,
      });
    }
  }
}

async function runOneInterruptedCuriosityRerun(id) {
  let item;
  try {
    item = await CuriosityItem.retrieve(id);
  } catch {
    return { id, ok: false, error: 'retrieve_failed' };
  }
  if (!item) {
    return { id, ok: false, permanent: true, error: 'not_found' };
  }
  try {
    await rerunInterruptedCuriosityPursuit(item);
    return { id, ok: true };
  } catch (e) {
    return {
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runOneInterruptedGoalRerun(id) {
  let item;
  try {
    item = await GoalItem.retrieve(id);
  } catch {
    return { id, ok: false, error: 'retrieve_failed' };
  }
  if (!item) {
    return { id, ok: false, permanent: true, error: 'not_found' };
  }
  try {
    await rerunInterruptedGoalPursuit(item);
    return { id, ok: true };
  } catch (e) {
    return {
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * @typedef {'resume_all' | 'rerun_interrupted'} ReloadInterruptedPipelineMode
 */

/**
 * Dashboard recovery: clears the pause hold, merges pursuit slots from disk, then either:
 *
 * - **`resume_all`** (default): {@link resumeInterruptedGraphPipelineManual} for the interactive graph/stream
 *   (cooperative checkpoints + reconnect resume), then resumes paused **scheduler** graph tasks, then reruns
 *   interrupted / paused-checkpoint curiosity and goal pursuits in parallel.
 *
 * - **`rerun_interrupted`**: **does not** start the interactive graph — use **Resume all** for that saved state.
 *   Still resumes every paused scheduler graph task, reruns the same curiosity/goal interrupted set, and runs
 *   {@link flushSchedulerDueTasksNow} so **due queued** pending tasks start without waiting for the poll interval.
 *
 * Clears the cross-tab “Pause & save all” scheduler hold first. Does not wait for already in-flight background jobs.
 *
 * @param {{ mode?: ReloadInterruptedPipelineMode }} [opts]
 */
export async function reloadInterruptedPipelineWorkFromDashboard(opts = {}) {
  const mode = opts.mode === 'rerun_interrupted' ? 'rerun_interrupted' : 'resume_all';

  setCooperativePauseAllExternalHold(false);
  healGraphRegistryWhenPersistSaysIdle();
  const curiosityMerged = reloadCuriosityPursuitsFromPersistedDisk();
  const goalMerged = reloadGoalPursuitsFromPersistedDisk();

  const graph =
    mode === 'resume_all'
      ? await resumeInterruptedGraphPipelineManual()
      : {
          graphStarted: false,
          graphReason: 'skipped_rerun_interrupted_mode',
          otherGraphCheckpointSessions: 0,
        };

  /** @type {{ id: string, ok: boolean, error?: string }[]} */
  let scheduledPausedResumes = [];
  try {
    const pausedRows = await listPausedScheduledGraphTasks();
    for (const t of pausedRows) {
      const id = String(t?.id || '').trim();
      if (!id) {
        scheduledPausedResumes.push({ id: '?', ok: false, error: 'missing id' });
        continue;
      }

      const hasCk =
        t.pipeline_checkpoint_shared_memory &&
        typeof t.pipeline_checkpoint_shared_memory === 'object' &&
        t.pipeline_checkpoint_execution_resume &&
        typeof t.pipeline_checkpoint_execution_resume === 'object';

      if (hasCk) {
        // Fire-and-forget: resumePausedScheduledPipelineTask runs the full pipeline
        // inline (SSE stream + persist), which can take minutes. Don't block the
        // rest of the resume-all flow waiting for it.
        void resumePausedScheduledPipelineTask(id).catch((e) => {
          console.warn('[reload-interrupted] background resume paused task error', id, e);
        });
        scheduledPausedResumes.push({ id, ok: true });
        continue;
      }

      // No checkpoint — re-queue as pending so the scheduler picks it up on the next tick.
      try {
        await ScheduledTask.update(id, {
          status: 'pending',
          scheduled_at: new Date().toISOString(),
          pipeline_checkpoint_shared_memory: null,
          pipeline_checkpoint_execution_resume: null,
          pipeline_checkpoint_pipeline_run_id: null,
        });
        scheduledPausedResumes.push({ id, ok: true });
      } catch (e) {
        scheduledPausedResumes.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    console.warn('[reload-interrupted] scheduled paused batch', e);
  }

  // Flush due scheduler tasks immediately so they don't wait for the next poll interval.
  try {
    await flushSchedulerDueTasksNow();
  } catch (e) {
    console.warn('[reload-interrupted] scheduler due flush', e);
  }

  const snapC = getCuriosityPagePursuitSnapshot();
  const curiosityFromReload = Object.keys(snapC.pursuits).filter((id) => snapC.pursuits[id]?.interruptedByReload);
  const curiosityFromPaused = await collectCuriosityIdsWithPausedLastGraphRun();
  const curiosityIds = [...new Set([...curiosityFromReload, ...curiosityFromPaused])].sort();

  const snapG = getGoalPagePursuitSnapshot();
  const goalFromReload = Object.keys(snapG.pursuits).filter((id) => snapG.pursuits[id]?.interruptedByReload);
  const goalFromPaused = await collectGoalIdsWithPausedLastGraphRun();
  const goalIds = [...new Set([...goalFromReload, ...goalFromPaused])].sort();

  const curiosityWave =
    curiosityIds.length === 0
      ? Promise.resolve([])
      : Promise.all(curiosityIds.map((id) => runOneInterruptedCuriosityRerun(id)));

  const goalWave =
    goalIds.length === 0
      ? Promise.resolve([])
      : Promise.all(goalIds.map((id) => runOneInterruptedGoalRerun(id)));

  const [curiosityReruns, goalReruns] = await Promise.all([curiosityWave, goalWave]);

  for (const r of curiosityReruns) {
    if (!r.ok && r.permanent) removeCuriosityPursuit(r.id);
  }
  for (const r of goalReruns) {
    if (!r.ok && r.permanent) removeGoalPursuit(r.id);
  }

  // Clear stale graph session flags (isRunning stuck in KV, registry isProcessing stuck)
  // so old/finished graph pipelines drop out of the active pipelines list.
  healGraphRegistryWhenPersistSaysIdle();
  void syncDashboardScheduledRunningFromDb();

  notifyMindStorageChanged({ source: 'reload-interrupted-pipelines' });

  return {
    mode,
    curiosityMerged,
    goalMerged,
    graph,
    scheduledPausedResumes,
    curiosityReruns,
    goalReruns,
  };
}
