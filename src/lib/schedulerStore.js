import { ScheduledTask } from './data';
import { normalizeScheduledTaskMindStorageProfile } from './mindEntityContext';

/**
 * Try to enqueue the task on the server-side scheduler (SQLite). Returns true on success.
 */
async function tryServerEnqueue(taskType, scheduledAt, options) {
  try {
    const res = await fetch('/api/scheduler/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskType,
        scheduledAt,
        inputText: options.input_text,
        reason: options.reason,
        mindStorageProfile: normalizeScheduledTaskMindStorageProfile(options.mind_storage_profile),
        scheduledBy: options.scheduled_by || 'client',
        recurrence: options.recurrence,
        recurrenceInterval: options.recurrence_interval,
        recurrenceUnit: options.recurrence_unit,
        recurrenceEndDate: options.recurrence_end_date,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      return !!data?.ok;
    }
  } catch { /* server unreachable — fall through to local */ }
  return false;
}

/**
 * Persist a scheduled job. Tries the server-side scheduler first (24/7 operation);
 * falls back to local IndexedDB when the server is unreachable.
 * @param {string} taskType
 * @param {number} delayMinutes minutes until first run (minimum 1)
 * @param {object} [options]
 * @param {string} [options.mind_storage_profile] `primary` (default) or `playgroundMirror` (System B) \u2014 which mind\u2019s stores the run uses.
 */
export async function scheduleTask(taskType, delayMinutes, options = {}) {
  let scheduledAt;
  if (options.scheduled_at && typeof options.scheduled_at === 'string') {
    scheduledAt = options.scheduled_at;
  } else {
    const n = Number(delayMinutes);
    const delay =
      Number.isFinite(n) && n >= 0 ? Math.max(1, Math.floor(n)) : Math.max(1, Math.floor(Number(delayMinutes) || 5));
    scheduledAt = new Date(Date.now() + delay * 60_000).toISOString();
  }

  const serverOk = await tryServerEnqueue(taskType, scheduledAt, options);
  if (serverOk) return;

  return ScheduledTask.create({
    task_type: taskType,
    status: 'pending',
    scheduled_at: scheduledAt,
    scheduled_by: options.scheduled_by || 'user',
    reason: options.reason,
    input_text: options.input_text,
    target_curiosity_id: options.target_curiosity_id || undefined,
    target_goal_id: options.target_goal_id || undefined,
    recurrence: options.recurrence || 'once',
    recurrence_end_date: options.recurrence_end_date || undefined,
    recurrence_interval: options.recurrence_interval,
    recurrence_unit: options.recurrence_unit,
    mind_phase: options.mind_phase,
    mind_arousal: options.mind_arousal,
    metacognition_rerun_attachment_ids: options.metacognition_rerun_attachment_ids,
    metacognition_rerun_slim_shared_memory: options.metacognition_rerun_slim_shared_memory,
    metacognition_rerun_pipeline_options: options.metacognition_rerun_pipeline_options,
    metacognition_rerun_curiosity_pursuit_context: options.metacognition_rerun_curiosity_pursuit_context,
    metacognition_rerun_goal_pursuit_context: options.metacognition_rerun_goal_pursuit_context,
    metacognition_rerun_graph_session_id: options.metacognition_rerun_graph_session_id,
    metacognition_max_reruns_override: options.metacognition_max_reruns_override,
    metacognition_rerun_delay_minutes_override: options.metacognition_rerun_delay_minutes_override,
    mind_storage_profile: normalizeScheduledTaskMindStorageProfile(options.mind_storage_profile),
  });
}
