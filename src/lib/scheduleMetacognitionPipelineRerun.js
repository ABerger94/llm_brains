import { scheduleTask } from './schedulerStore';
import { notifyMindStorageChanged } from './mindStorageEvents';

/**
 * Strip request-time flags from a snapshot before persisting or POSTing a deferred rerun. If these stay
 * set on a supervisor continuation task row, the continuation leg can keep deferring and never finish.
 * @param {object|undefined|null} snapshot
 */
export function sanitizeMetacognitionPipelineOptionsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const next = { ...snapshot };
  delete next.deferMetacognitionRerun;
  delete next.pipelineMetacognitionContinuation;
  return next;
}

/**
 * Queue a browser-local continuation of the graph pipeline after a deferred supervisor RERUN (Metacognition or Workspace Metacognition).
 * @param {object} p
 * @param {number} p.delayMinutes
 * @param {string} [p.reason]
 * @param {string} p.inputText - same `input` field as the original POST (not composed server-side)
 * @param {string[]} [p.attachmentIds]
 * @param {object|null} p.slimSharedMemory - output of slimSharedMemoryForPipelinePost(complete.sharedMemory, { continuation: true })
 * @param {object} p.pipelineOptionsSnapshot - pipeline `options` minus continuation/defer flags
 * @param {string} [p.mindPhase]
 * @param {number} [p.mindArousal]
 * @param {{ parentCuriosityId: string, rootCuriosityId: string } | null} [p.curiosityPursuitContext]
 * @param {{ parentGoalId: string, rootGoalId: string } | null} [p.goalPursuitContext]
 */
export async function enqueueMetacognitionPipelineRerunSchedule({
  delayMinutes,
  reason,
  inputText,
  attachmentIds = [],
  slimSharedMemory,
  pipelineOptionsSnapshot,
  mindPhase,
  mindArousal,
  curiosityPursuitContext = null,
  goalPursuitContext = null,
}) {
  const cctx = curiosityPursuitContext && typeof curiosityPursuitContext === 'object' ? curiosityPursuitContext : null;
  const gctx = goalPursuitContext && typeof goalPursuitContext === 'object' ? goalPursuitContext : null;

  await scheduleTask('supervisor_pipeline_rerun', delayMinutes, {
    scheduled_by: 'pipeline',
    reason: reason || 'Supervisor RERUN (pipeline continuation)',
    input_text: inputText,
    mind_phase: mindPhase,
    mind_arousal: mindArousal,
    target_curiosity_id: cctx?.parentCuriosityId || undefined,
    target_goal_id: gctx?.parentGoalId || undefined,
    metacognition_rerun_attachment_ids: attachmentIds,
    metacognition_rerun_slim_shared_memory: slimSharedMemory,
    metacognition_rerun_pipeline_options: sanitizeMetacognitionPipelineOptionsSnapshot(pipelineOptionsSnapshot),
    metacognition_rerun_curiosity_pursuit_context: cctx || undefined,
    metacognition_rerun_goal_pursuit_context: gctx || undefined,
  });
  notifyMindStorageChanged({ source: 'scheduled-tasks' });
}
