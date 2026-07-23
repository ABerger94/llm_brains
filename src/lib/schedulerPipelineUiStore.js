import {
  initialCuriosityPipelineUi,
  reduceCuriosityPipelineSse,
} from './curiosityPipelineSseUi';
import { slimSharedMemoryForGraphCheckpoint } from './slimSharedMemory';

const listeners = new Set();

/**
 * @typedef {{
 *   taskId: string,
 *   taskType: string,
 *   runInputText: string,
 *   runReason: string,
 *   ui: ReturnType<typeof initialCuriosityPipelineUi>,
 *   paused?: boolean,
 *   pauseSummary?: string,
 *   pauseNextModule?: string,
 *   lastGraphCheckpoint?: { sharedMemory: object, executionResume: object, pipelineRunId?: string|null },
 * }} SchedulerPipelineUiEntry
 */

/**
 * @typedef {{
 *   byTaskId: Record<string, SchedulerPipelineUiEntry>,
 *   taskIds: string[],
 *   tasks: SchedulerPipelineUiEntry[],
 *   running: boolean,
 *   taskId: string | null,
 *   taskType: string,
 *   ui: ReturnType<typeof initialCuriosityPipelineUi>,
 * }} SchedulerPipelineUiSnapshot
 */

/** @type {{ byTaskId: Record<string, SchedulerPipelineUiEntry> }} */
let snapshot = { byTaskId: {} };

/**
 * useSyncExternalStore compares getSnapshot() with Object.is. A fresh object every call
 * causes infinite re-renders. Reuse one public object until the store emits.
 * @type {SchedulerPipelineUiSnapshot | null}
 */
let publicSnapshotCache = null;

function buildPublicSnapshot() {
  const byTaskId = snapshot.byTaskId;
  const taskIds = Object.keys(byTaskId).sort();
  const tasks = taskIds.map((id) => byTaskId[id]).filter(Boolean);
  const first = tasks[0];
  return {
    byTaskId,
    taskIds,
    tasks,
    running: tasks.length > 0,
    taskId: first?.taskId ?? null,
    taskType: first?.taskType ?? '',
    ui: first?.ui ?? initialCuriosityPipelineUi(),
  };
}

function emit() {
  publicSnapshotCache = null;
  listeners.forEach((l) => l());
}

export function subscribeSchedulerPipelineUi(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Clear in-memory scheduler pipeline inspector slots after mind archive import. */
export function resetSchedulerPipelineUiAfterImport() {
  snapshot = { byTaskId: {} };
  emit();
}

/** @returns {SchedulerPipelineUiSnapshot} */
export function getSchedulerPipelineUiSnapshot() {
  if (!publicSnapshotCache) {
    publicSnapshotCache = buildPublicSnapshot();
  }
  return publicSnapshotCache;
}

/**
 * @param {{ id: string, task_type?: string, input_text?: string, reason?: string }} task
 */
export function beginSchedulerPipelineUi(task) {
  const id = String(task?.id || '').trim();
  if (!id) return;
  snapshot = {
    byTaskId: {
      ...snapshot.byTaskId,
      [id]: {
        taskId: id,
        taskType: String(task?.task_type || '').trim(),
        runInputText: String(task?.input_text ?? '').trim(),
        runReason: String(task?.reason ?? '').trim(),
        ui: initialCuriosityPipelineUi(),
      },
    },
  };
  emit();
}

/**
 * @param {object} evt
 * @param {string} taskId - must match the task that started this pipeline (parallel runs)
 */
export function applySchedulerPipelineUiSse(evt, taskId) {
  const id = String(taskId || '').trim();
  if (!id) return;
  const cur = snapshot.byTaskId[id];
  if (!cur) return;
  let lastGraphCheckpoint = cur.lastGraphCheckpoint;
  if (
    evt?.type === 'module_complete' &&
    evt.sharedMemory &&
    typeof evt.sharedMemory === 'object' &&
    evt.executionCheckpoint &&
    typeof evt.executionCheckpoint === 'object' &&
    Number(evt.executionCheckpoint.v) === 1
  ) {
    const sm = evt.sharedMemory;
    lastGraphCheckpoint = {
      sharedMemory: slimSharedMemoryForGraphCheckpoint(sm) ?? sm,
      executionResume: evt.executionCheckpoint,
      pipelineRunId: null,
    };
  }
  snapshot = {
    byTaskId: {
      ...snapshot.byTaskId,
      [id]: {
        ...cur,
        lastGraphCheckpoint,
        ui: reduceCuriosityPipelineSse(cur.ui, evt),
      },
    },
  };
  emit();
}

/**
 * Latest module checkpoint seen over SSE for this task (for Stop → cancelled + resume).
 * @param {string} taskId
 * @returns {{ sharedMemory: object, executionResume: object, pipelineRunId?: string|null } | null}
 */
export function getLastGraphCheckpointForSchedulerTask(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return null;
  const ent = snapshot.byTaskId[id];
  const ck = ent?.lastGraphCheckpoint;
  if (!ck?.sharedMemory || typeof ck.sharedMemory !== 'object') return null;
  if (!ck.executionResume || typeof ck.executionResume !== 'object') return null;
  return ck;
}

/**
 * @param {string} expectedTaskId - remove only this task’s live UI slot (parallel runs)
 */
export function endSchedulerPipelineUi(expectedTaskId) {
  const id = String(expectedTaskId ?? '').trim();
  if (!id) return;
  if (!snapshot.byTaskId[id]) return;
  const next = { ...snapshot.byTaskId };
  delete next[id];
  snapshot = { byTaskId: next };
  emit();
}

/**
 * Keep inspector rows after cooperative pause so the user can Continue without relying on SSE alone.
 * @param {string} taskId
 * @param {{ summary?: string, nextModuleName?: string }} [meta]
 */
export function markSchedulerPipelinePausedInUi(taskId, meta = {}) {
  const id = String(taskId || '').trim();
  if (!id) return;
  const cur = snapshot.byTaskId[id];
  if (!cur) return;
  snapshot = {
    byTaskId: {
      ...snapshot.byTaskId,
      [id]: {
        ...cur,
        paused: true,
        pauseSummary: String(meta.summary || '').slice(0, 500),
        pauseNextModule: String(meta.nextModuleName || '').slice(0, 200),
      },
    },
  };
  emit();
}

/**
 * Rehydrate inspector rows for paused tasks after reload (no live SSE).
 * @param {Array<{ id: string, task_type?: string, input_text?: string, reason?: string, result_summary?: string, pipeline_checkpoint_execution_resume?: { nextModuleName?: string } }>} tasks
 */
export function seedSchedulerPipelineUiFromPausedTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  let next = { ...snapshot.byTaskId };
  for (const t of tasks) {
    const id = String(t?.id || '').trim();
    if (!id || next[id]) continue;
    next[id] = {
      taskId: id,
      taskType: String(t.task_type || '').trim(),
      runInputText: String(t.input_text ?? '').trim(),
      runReason: String(t.reason ?? '').trim(),
      ui: initialCuriosityPipelineUi(),
      paused: true,
      pauseSummary: String(t.result_summary || 'Paused — saved checkpoint.').slice(0, 500),
      pauseNextModule: String(t.pipeline_checkpoint_execution_resume?.nextModuleName || '').slice(0, 200),
    };
  }
  snapshot = { byTaskId: next };
  emit();
}

/**
 * Append one line to every active scheduler pipeline UI execution log (Dashboard Pause & save all).
 * @param {{ time: number, msg: string }} line
 */
export function appendSchedulerPipelineExecutionLogLineAllTasks(line) {
  const keys = Object.keys(snapshot.byTaskId);
  if (keys.length === 0) return;
  let next = { ...snapshot.byTaskId };
  for (const id of keys) {
    const cur = next[id];
    if (!cur) continue;
    const prevLog = Array.isArray(cur.ui?.executionLog) ? cur.ui.executionLog : [];
    next[id] = {
      ...cur,
      ui: {
        ...cur.ui,
        executionLog: [...prevLog, line].slice(-40),
      },
    };
  }
  snapshot = { byTaskId: next };
  emit();
}
