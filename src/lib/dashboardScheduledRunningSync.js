import { ScheduledTask } from './data';

/** Task types that represent a full or continuation graph-style run from the scheduler. */
export const SCHEDULER_DASHBOARD_PIPELINE_TASK_TYPES = new Set([
  'metacognition_pipeline_rerun',
  'supervisor_pipeline_rerun',
  'pipeline_run',
  'pipeline_classic',
  'consciousness_stream',
  'diagnostic',
  'metacognition_review',
  'belief_tension_review',
  'curiosity_pursuit',
  'goal_pursuit',
]);

/** Paused tasks that can be resumed from a cooperative checkpoint (keep in sync with resume switch in scheduledTaskRunner). */
export const RESUMABLE_PAUSED_GRAPH_TYPES = new Set([
  'pipeline_run',
  'pipeline_classic',
  'consciousness_stream',
  'supervisor_pipeline_rerun',
  'metacognition_pipeline_rerun',
  'metacognition_review',
  'belief_tension_review',
  'diagnostic',
  'curiosity_pursuit',
  'goal_pursuit',
]);

const listeners = new Set();

/**
 * @type {Array<{
 *   id: string,
 *   task_type: string,
 *   reason: string,
 *   input_text: string,
 *   run_started_at: string,
 *   target_curiosity_id: string,
 *   target_goal_id: string,
 *   mind_storage_profile: string,
 * }>}
 */
let cachedRunningPipelineTasks = [];

/**
 * @type {Array<{
 *   id: string,
 *   task_type: string,
 *   reason: string,
 *   input_text: string,
 *   run_started_at: string,
 *   target_curiosity_id: string,
 *   target_goal_id: string,
 *   mind_storage_profile: string,
 * }>}
 */
let cachedPausedPipelineTasks = [];

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeDashboardScheduledRunningSync(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Synchronous read for {@link buildDashboardActiveWorkRows} / useSyncExternalStore — all running pipeline-shaped tasks. */
export function getDashboardScheduledRunningFromDbCache() {
  return cachedRunningPipelineTasks;
}

/** Synchronous read — paused cooperative-checkpoint pipeline tasks (still shown under Active pipelines). */
export function getDashboardScheduledPausedFromDbCache() {
  return cachedPausedPipelineTasks;
}

function normalizedStatus(st) {
  const s = String(st ?? '')
    .trim()
    .toLowerCase();
  if (!s) return 'pending';
  if (s === 'canceled') return 'cancelled';
  return s;
}

function isPipelineSchedulerType(taskType) {
  const k = String(taskType ?? '')
    .trim()
    .toLowerCase();
  return SCHEDULER_DASHBOARD_PIPELINE_TASK_TYPES.has(k);
}

function rowSnapshot(t) {
  const tc = t.target_curiosity_id;
  const tg = t.target_goal_id;
  return {
    id: String(t.id),
    task_type: String(t.task_type || ''),
    reason: typeof t.reason === 'string' ? t.reason : '',
    input_text: typeof t.input_text === 'string' ? t.input_text : '',
    run_started_at: typeof t.run_started_at === 'string' ? t.run_started_at : '',
    target_curiosity_id: typeof tc === 'string' ? tc.trim() : '',
    target_goal_id: typeof tg === 'string' ? tg.trim() : '',
    mind_storage_profile: typeof t.mind_storage_profile === 'string' ? t.mind_storage_profile : '',
  };
}

function runningRowsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.task_type !== y.task_type ||
      x.reason !== y.reason ||
      x.input_text !== y.input_text ||
      x.run_started_at !== y.run_started_at ||
      x.target_curiosity_id !== y.target_curiosity_id ||
      x.target_goal_id !== y.target_goal_id ||
      x.mind_storage_profile !== y.mind_storage_profile
    ) {
      return false;
    }
  }
  return true;
}

function pausedRowsEqual(a, b) {
  return runningRowsEqual(a, b);
}

/**
 * Re-read IndexedDB and refresh cached **running** pipeline-shaped scheduled tasks for the dashboard.
 * Call after any ScheduledTask status transition the dashboard should reflect.
 * @returns {Promise<void>}
 */
export async function syncDashboardScheduledRunningFromDb() {
  try {
    const all = await ScheduledTask.listAll('-created_date');
    const nextRunning = all
      .filter((t) => normalizedStatus(t.status) === 'running' && isPipelineSchedulerType(t.task_type))
      .map(rowSnapshot)
      .sort((a, b) => a.run_started_at.localeCompare(b.run_started_at) || a.id.localeCompare(b.id));

    const nextPaused = all
      .filter(
        (t) =>
          normalizedStatus(t.status) === 'paused' &&
          RESUMABLE_PAUSED_GRAPH_TYPES.has(String(t.task_type || ''))
      )
      .map(rowSnapshot)
      .sort((a, b) => a.run_started_at.localeCompare(b.run_started_at) || a.id.localeCompare(b.id));

    if (
      runningRowsEqual(nextRunning, cachedRunningPipelineTasks) &&
      pausedRowsEqual(nextPaused, cachedPausedPipelineTasks)
    ) {
      return;
    }

    cachedRunningPipelineTasks = nextRunning;
    cachedPausedPipelineTasks = nextPaused;
    emit();
  } catch (e) {
    console.warn('[dashboardScheduledRunningSync] sync failed', e);
  }
}
