import { ScheduledTask, CuriosityItem } from './data';
import { buildBeliefTensionReviewSchedulePayload } from './beliefTensionScheduleTopic';
import { getRuntimeSettings } from './runtimeSettings';
import { scheduleTask } from './schedulerStore';
import { isAnyBlockingPipelineActive } from './pipelineBusyGate';

async function hasPendingTaskType(taskType) {
  const all = await ScheduledTask.list('-created_date', 120);
  return all.some((t) => t.task_type === taskType && (t.status || 'pending') === 'pending');
}

/**
 * After a graph pipeline completes: optionally queue a Belief Map tension review pass.
 */
export async function maybeQueueBeliefTensionReviewFromPipeline(sharedMemory) {
  const rt = getRuntimeSettings();
  if (rt.autoQueueBeliefTensionReview !== true) return;
  if (!sharedMemory?.followupHints?.beliefTensionReview) return;
  if (await hasPendingTaskType('belief_tension_review')) return;

  const delay = Math.max(1, Number(rt.autoQueueBeliefTensionReviewDelayMinutes) || 3);
  const { input_text, reason } = await buildBeliefTensionReviewSchedulePayload(sharedMemory);
  await scheduleTask('belief_tension_review', delay, {
    scheduled_by: 'followthrough',
    input_text,
    reason,
  });
}

/**
 * After scheduled curiosity generation: optionally queue a single curiosity pursuit.
 */
export async function maybeQueueCuriosityPursuitAfterGeneration() {
  const rt = getRuntimeSettings();
  if (rt.autoQueueCuriosityPursuitAfterGeneration !== true) return;
  if (await hasPendingTaskType('curiosity_pursuit')) return;

  let delay = Math.max(1, Number(rt.autoQueueCuriosityPursuitDelayMinutes) || 2);
  if (isAnyBlockingPipelineActive()) {
    delay += Math.max(1, Number(rt.curiosityPursuitDeferWhenBusyMinutes) || 10);
  }
  /** @type {{ scheduled_by: string, reason: string, input_text?: string }} */
  const opts = {
    scheduled_by: 'followthrough',
    reason: 'Auto-chained after curiosity_generation.',
  };
  try {
    const open = await CuriosityItem.filter({ status: 'open' }, '-created_date', 1);
    const q = String(open[0]?.question || '').trim();
    if (q) opts.input_text = q.slice(0, 400);
  } catch {
    /* ignore */
  }
  await scheduleTask('curiosity_pursuit', delay, opts);
}
