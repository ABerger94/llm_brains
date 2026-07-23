import { CuriosityItem, GoalItem, ScheduledTask } from './data';
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
  abortRegisteredCuriosityPursuitGraph,
  abortRegisteredGoalPursuitGraph,
  clearCuriosityPursuitGraphAbort,
  clearGoalPursuitGraphAbort,
  registerCuriosityPursuitGraphAbort,
  registerGoalPursuitGraphAbort,
} from './pursuitGraphPipelineAbortRegistry';
import { initialCuriosityPipelineUi, reduceCuriosityPipelineSse } from './curiosityPipelineSseUi';
import { initialGoalPipelineUi, reduceGoalPipelineSse } from './goalPipelineSseUi';
import { healGraphRegistryWhenPersistSaysIdle } from './graphSessionStaleRunningHeal';
import { syncDashboardScheduledRunningFromDb } from './dashboardScheduledRunningSync';
import { resolvePursuitResumeFromLastPipelineRun } from './pipelinePursuitResume';
import { MIND_STORAGE_PROFILE_PRIMARY } from './mindEntityContext';
import { toast } from '../components/ui';

/**
 * Every idle cooperative-pause slot shown on the Dashboard must be eligible for per-card Resume.
 * The prior implementation required `last_pursuit_pipeline_run_id` to point at a checkpoint-shaped
 * PipelineRun; after import/reload that pointer can be stale while the slot still shows paused.
 * {@link resolvePursuitResumeFromLastPipelineRun} can still find a resumable run via scan.
 */
function collectCuriosityIdsCooperativePausedIdle() {
  const snap = getCuriosityPagePursuitSnapshot();
  const ids = [];
  for (const [id, e] of Object.entries(snap.pursuits || {})) {
    if (!e?.cooperativePaused || e?.running) continue;
    ids.push(id);
  }
  return ids.sort();
}

function collectGoalIdsCooperativePausedIdle() {
  const snap = getGoalPagePursuitSnapshot();
  const ids = [];
  for (const [id, e] of Object.entries(snap.pursuits || {})) {
    if (!e?.cooperativePaused || e?.running) continue;
    ids.push(id);
  }
  return ids.sort();
}

async function rerunInterruptedCuriosityPursuit(item) {
  const cid = item.id;
  abortRegisteredCuriosityPursuitGraph(cid);
  const ac = new AbortController();
  registerCuriosityPursuitGraphAbort(cid, ac);
  const resume = await resolvePursuitResumeFromLastPipelineRun(item);
  const nm = resume?.executionResume?.nextModuleName;
  const progressLabel =
    typeof nm === 'string' && nm.trim() ? `Resuming before ${nm.trim()}…` : 'Starting…';
  const prevCuriosityEntry = getCuriosityPagePursuitSnapshot().pursuits[cid];
  const curiosityReloadProfile = prevCuriosityEntry?.mindStorageProfile || MIND_STORAGE_PROFILE_PRIMARY;
  upsertCuriosityPursuit(cid, {
    running: true,
    interruptedByReload: false,
    cooperativePaused: false,
    pursuitProgress: progressLabel,
    curiosityPipelineUi: initialCuriosityPipelineUi(),
    question: String(item.question || '').trim() || undefined,
    mindStorageProfile: curiosityReloadProfile,
  });
  let pipelinePaused = false;
  try {
    const { pipelinePaused: didPause } = await runCuriosityDeepPursuitChain(item, {
      mindStorageProfile: curiosityReloadProfile,
      signal: ac.signal,
      onProgress: (label) => {
        patchCuriosityPursuitEntry(cid, { pursuitProgress: label });
        updateCuriosityPursuitPipelineUiForId(cid, (prev) => ({
          ...prev,
          moduleStatuses: {},
          moduleOutputs: {},
          loopCount: 0,
          finalOutput: '',
          executionLog: [...(prev.executionLog || []), { time: Date.now(), msg: `── ${label} ──` }].slice(-40),
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
  abortRegisteredGoalPursuitGraph(gid);
  const ac = new AbortController();
  registerGoalPursuitGraphAbort(gid, ac);
  const resume = await resolvePursuitResumeFromLastPipelineRun(item);
  const nm = resume?.executionResume?.nextModuleName;
  const progressLabel =
    typeof nm === 'string' && nm.trim() ? `Resuming before ${nm.trim()}…` : 'Starting…';
  const prevGoalEntry = getGoalPagePursuitSnapshot().pursuits[gid];
  const goalReloadProfile = prevGoalEntry?.mindStorageProfile || MIND_STORAGE_PROFILE_PRIMARY;
  upsertGoalPursuit(gid, {
    running: true,
    interruptedByReload: false,
    cooperativePaused: false,
    pursuitProgress: progressLabel,
    goalPipelineUi: initialGoalPipelineUi(),
    goalStatement: String(item.goal_statement || '').trim() || undefined,
    mindStorageProfile: goalReloadProfile,
  });
  let pipelinePaused = false;
  try {
    const { pipelinePaused: didPause } = await runGoalDeepPursuitChain(item, {
      mindStorageProfile: goalReloadProfile,
      signal: ac.signal,
      onProgress: (label) => {
        patchGoalPagePursuitEntry(gid, { pursuitProgress: label });
        updateGoalPagePursuitPipelineUiForId(gid, (prev) => ({
          ...prev,
          moduleStatuses: {},
          moduleOutputs: {},
          loopCount: 0,
          finalOutput: '',
          executionLog: [...(prev.executionLog || []), { time: Date.now(), msg: `── ${label} ──` }].slice(-40),
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

export async function runOneInterruptedCuriosityRerun(id) {
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

export async function runOneInterruptedGoalRerun(id) {
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
 * Merge curiosity/goal pursuit slots from persisted storage, heal graph registry flags, and refresh
 * Dashboard scheduled-task caches so cooperative-pause rows appear — without starting pipelines.
 *
 * Use after a reload or when “Load saved” should surface paused work from disk.
 */
export async function loadSavedPausedPipelineStateFromDashboard() {
  healGraphRegistryWhenPersistSaysIdle();
  const curiosityMerged = reloadCuriosityPursuitsFromPersistedDisk();
  const goalMerged = reloadGoalPursuitsFromPersistedDisk();
  await syncDashboardScheduledRunningFromDb();
  notifyMindStorageChanged({ source: 'dashboard-load-saved' });
  return { curiosityMerged, goalMerged };
}

/**
 * @typedef {'resume_all' | 'rerun_interrupted'} ReloadInterruptedPipelineMode
 */

/**
 * Dashboard recovery: clears the pause hold, merges pursuit slots from disk, then either:
 *
 * - **`resume_all`** (default): resumes paused **scheduler** graph tasks and flushes the due queue **first**,
 *   then reruns interrupted / paused-checkpoint **curiosity and goal** pursuits (so they are not blocked
 *   behind a long interactive graph run), then {@link resumeInterruptedGraphPipelineManual} for the
 *   interactive graph/stream (all cooperative checkpoints sequentially, then reconnect resume when eligible).
 *
 * - **`rerun_interrupted`**: **does not** start the interactive graph, **does not** resume scheduler paused
 *   tasks or flush the due-task queue — use **Resume all** for that. Reloads pursuit KV and reruns
 *   interrupted / paused-checkpoint curiosity and goal pursuits, continuing from the latest saved
 *   {@link PipelineRun} checkpoint ({@link resolvePursuitResumeFromLastPipelineRun}) instead of restarting from Perception when possible.
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

  let graph =
    mode === 'resume_all'
      ? null
      : {
          graphStarted: false,
          graphReason: 'skipped_rerun_interrupted_mode',
          otherGraphCheckpointSessions: 0,
        };

  /** @type {{ id: string, ok: boolean, error?: string, background?: boolean }[]} */
  let scheduledPausedResumes = [];
  /** @type {Promise<{ id: string, ok: boolean, error?: string }>[]} */
  const backgroundSchedulerResumes = [];
  if (mode === 'resume_all') {
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
          // resumePausedScheduledPipelineTask runs the full pipeline (SSE + persist); do not block
          // pursuits / graph. Aggregate failures when all background runs settle.
          backgroundSchedulerResumes.push(
            resumePausedScheduledPipelineTask(id).then(
              () => ({ id, ok: true }),
              (e) => ({
                id,
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              })
            )
          );
          scheduledPausedResumes.push({ id, ok: true, background: true });
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

    if (backgroundSchedulerResumes.length > 0) {
      void Promise.all(backgroundSchedulerResumes).then((results) => {
        const bad = results.filter((r) => !r.ok);
        if (bad.length === 0) return;
        const head = bad
          .slice(0, 4)
          .map((r) => `${r.id}: ${r.error || 'failed'}`)
          .join(' · ');
        console.warn('[reload-interrupted] scheduler resume failures', bad);
        toast({
          title: 'Some scheduler resumes failed',
          description:
            bad.length > 4
              ? `${head} · +${bad.length - 4} more (see console)`
              : head,
          variant: 'destructive',
        });
      });
    }

    try {
      await flushSchedulerDueTasksNow();
    } catch (e) {
      console.warn('[reload-interrupted] scheduler due flush', e);
    }
  }

  const snapC = getCuriosityPagePursuitSnapshot();
  const curiosityFromReload = Object.keys(snapC.pursuits).filter((id) => snapC.pursuits[id]?.interruptedByReload);
  const curiosityFromPaused = collectCuriosityIdsCooperativePausedIdle();
  const curiosityIds = [...new Set([...curiosityFromReload, ...curiosityFromPaused])].sort();

  const snapG = getGoalPagePursuitSnapshot();
  const goalFromReload = Object.keys(snapG.pursuits).filter((id) => snapG.pursuits[id]?.interruptedByReload);
  const goalFromPaused = collectGoalIdsCooperativePausedIdle();
  const goalIds = [...new Set([...goalFromReload, ...goalFromPaused])].sort();

  /** @type {{ id: string, ok: boolean, error?: string, permanent?: boolean }[]} */
  const curiosityReruns = [];
  for (const id of curiosityIds) {
    curiosityReruns.push(await runOneInterruptedCuriosityRerun(id));
  }

  /** @type {{ id: string, ok: boolean, error?: string, permanent?: boolean }[]} */
  const goalReruns = [];
  for (const id of goalIds) {
    goalReruns.push(await runOneInterruptedGoalRerun(id));
  }

  for (const r of curiosityReruns) {
    if (!r.ok && r.permanent) removeCuriosityPursuit(r.id);
  }
  for (const r of goalReruns) {
    if (!r.ok && r.permanent) removeGoalPursuit(r.id);
  }

  if (mode === 'resume_all') {
    graph = await resumeInterruptedGraphPipelineManual();
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
