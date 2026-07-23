import { ScheduledTask } from './data';
import { buildBeliefTensionReviewSchedulePayload } from './beliefTensionScheduleTopic';
import { getRuntimeSettings } from './runtimeSettings';
import { scheduleTask } from './schedulerStore';
import { isAnyBlockingPipelineActive } from './pipelineBusyGate';
import {
  getActiveMindEntityProfile,
  getMindEntityStores,
  normalizeScheduledTaskMindStorageProfile,
} from './mindEntityContext';

function activeMindStorageProfile() {
  return normalizeScheduledTaskMindStorageProfile(getActiveMindEntityProfile());
}

async function hasPendingTaskType(taskType) {
  const want = activeMindStorageProfile();
  const all = await ScheduledTask.list('-created_date', 120);
  return all.some(
    (t) =>
      t.task_type === taskType &&
      (t.status || 'pending') === 'pending' &&
      normalizeScheduledTaskMindStorageProfile(t.mind_storage_profile) === want
  );
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
    mind_storage_profile: activeMindStorageProfile(),
  });
}

/**
 * After scheduled curiosity generation: optionally queue a single curiosity pursuit.
 */
const META_FOLLOWUP_SCHEDULE_WHITELIST = new Set([
  'pipeline_run',
  'consolidation_pass',
  'belief_extraction',
  'metacognition_review',
  'belief_tension_review',
  'curiosity_pursuit',
  'goal_pursuit',
  'diagnostic',
  'autonomous_consolidation',
  'pending_inbox_digest',
  'exploration_run',
  'dual_dialogue',
]);

/**
 * Supervisor META_ACTIONS: enqueue a whitelisted scheduled task (deduped by pending task_type).
 */
export async function maybeQueueMetaScheduleTaskFromPipeline(sharedMemory) {
  const hint = sharedMemory?.followupHints?.metaScheduleTask;
  if (!hint || typeof hint !== 'object') return;
  const taskType = String(hint.taskType || '').trim();
  if (!taskType || !META_FOLLOWUP_SCHEDULE_WHITELIST.has(taskType)) return;
  if (await hasPendingTaskType(taskType)) return;
  const delayMinutes = Math.min(1440, Math.max(1, Math.floor(Number(hint.delayMinutes) || 5)));
  const reason = String(hint.reason || 'META_ACTIONS scheduleTask').slice(0, 500);
  await scheduleTask(taskType, delayMinutes, {
    scheduled_by: 'meta_actions',
    reason,
    input_text: typeof (hint.inputText ?? hint.input_text) === 'string' ? String(hint.inputText ?? hint.input_text).slice(0, 8000) : undefined,
    mind_storage_profile: activeMindStorageProfile(),
  });
}

/**
 * Supervisor META_ACTIONS: optional chained consolidation pass after the graph run.
 */
export async function maybeQueueBackgroundConsolidationFromPipeline(sharedMemory) {
  if (!sharedMemory?.followupHints?.backgroundConsolidation) return;
  if (await hasPendingTaskType('consolidation_pass')) return;
  const rt = getRuntimeSettings();
  const delay = Math.max(2, Math.floor(Number(rt.metaBackgroundConsolidationDelayMinutes) || 15));
  await scheduleTask('consolidation_pass', delay, {
    scheduled_by: 'meta_actions',
    reason: 'Background consolidation requested by supervisor META_ACTIONS.',
    mind_storage_profile: activeMindStorageProfile(),
  });
}

/** Run all META_ACTIONS follow-through hooks that enqueue IndexedDB scheduler rows. */
export async function maybeQueueMetaFollowupsFromPipeline(sharedMemory) {
  await maybeQueueMetaScheduleTaskFromPipeline(sharedMemory);
  await maybeQueueBackgroundConsolidationFromPipeline(sharedMemory);
}

export async function maybeQueueCuriosityPursuitAfterGeneration() {
  const rt = getRuntimeSettings();
  if (rt.autoQueueCuriosityPursuitAfterGeneration !== true) return;
  if (await hasPendingTaskType('curiosity_pursuit')) return;

  let delay = Math.max(1, Number(rt.autoQueueCuriosityPursuitDelayMinutes) || 2);
  if (isAnyBlockingPipelineActive()) {
    delay += Math.max(1, Number(rt.curiosityPursuitDeferWhenBusyMinutes) || 10);
  }
  /** @type {{ scheduled_by: string, reason: string, input_text?: string, mind_storage_profile: string }} */
  const opts = {
    scheduled_by: 'followthrough',
    reason: 'Auto-chained after curiosity_generation.',
    mind_storage_profile: activeMindStorageProfile(),
  };
  try {
    const { CuriosityItem } = getMindEntityStores();
    const open = await CuriosityItem.filter({ status: 'open' }, '-created_date', 1);
    const q = String(open[0]?.question || '').trim();
    if (q) opts.input_text = q.slice(0, 400);
  } catch {
    /* ignore */
  }
  await scheduleTask('curiosity_pursuit', delay, opts);
}
