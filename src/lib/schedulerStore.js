import { ScheduledTask } from './data';

/**
 * Persist a scheduled job in local storage (execution is not wired yet — same as prior Scheduler).
 * @param {string} taskType
 * @param {number} delayMinutes minutes until first run (minimum 1)
 * @param {object} [options]
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
    metacognition_max_reruns_override: options.metacognition_max_reruns_override,
    metacognition_rerun_delay_minutes_override: options.metacognition_rerun_delay_minutes_override,
  });
}
