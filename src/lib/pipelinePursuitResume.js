import { normalizeExecutionResume } from '../../shared/pipelineExecutionResume.mjs';
import { getMindEntityStores } from './mindEntityContext';
import {
  inferExecutionResumeFromModuleCheckpointFinalOutput,
  inferExecutionResumeFromPausedPipelineRun,
  isCheckpointPipelineRun,
} from './pipelineRunCheckpoint';

/**
 * Optional IndexedDB fields on {@link PipelineRun} rows from curiosity/goal graph pursuits (for resume discovery).
 * @param {{ parentCuriosityId?: string, rootCuriosityId?: string } | null} curiosityPursuitContext
 * @param {{ parentGoalId?: string, rootGoalId?: string } | null} goalPursuitContext
 * @returns {{ pursuit_parent_curiosity_id?: string, pursuit_parent_goal_id?: string }}
 */
export function pursuitPipelineRunIdPatch(curiosityPursuitContext, goalPursuitContext) {
  const c =
    curiosityPursuitContext && String(curiosityPursuitContext.parentCuriosityId || '').trim()
      ? String(curiosityPursuitContext.parentCuriosityId).trim()
      : '';
  const g =
    goalPursuitContext && String(goalPursuitContext.parentGoalId || '').trim()
      ? String(goalPursuitContext.parentGoalId).trim()
      : '';
  const out = {};
  if (c) out.pursuit_parent_curiosity_id = c;
  if (g) out.pursuit_parent_goal_id = g;
  return out;
}

function executionResumeFromRun(run) {
  return (
    normalizeExecutionResume(run.execution_resume) ||
    inferExecutionResumeFromPausedPipelineRun(run) ||
    inferExecutionResumeFromModuleCheckpointFinalOutput(run)
  );
}

/**
 * @param {object | null | undefined} run - PipelineRun row
 * @returns {{ initialFullSharedMemory: object, executionResume: object } | null}
 */
export function tryPackResumeFromPipelineRun(run) {
  if (!run || !isCheckpointPipelineRun(run)) return null;
  const executionResume = executionResumeFromRun(run);
  if (!executionResume) return null;
  const sm = run.shared_memory;
  if (!sm || typeof sm !== 'object') return null;
  return { initialFullSharedMemory: sm, executionResume };
}

function isGoalLikePursuitItem(item) {
  return (
    item &&
    typeof item === 'object' &&
    typeof item.goal_statement === 'string' &&
    String(item.goal_statement).trim().length > 0
  );
}

function legacyRunMatchesCuriosityPursuit(run, item) {
  const q = String(item.question || '').trim();
  if (q.length < 8) return false;
  const input = String(run.input || '');
  if (!input.includes('[Curiosity pursuit')) return false;
  return input.includes(q.slice(0, Math.min(80, q.length)));
}

function legacyRunMatchesGoalPursuit(run, item) {
  const g = String(item.goal_statement || '').trim();
  if (g.length < 8) return false;
  const input = String(run.input || '');
  if (!input.includes('[Goal pursuit')) return false;
  return input.includes(g.slice(0, Math.min(80, g.length)));
}

/**
 * Newest-first scan: latest resumable checkpoint for this item when `last_pursuit_pipeline_run_id` is not
 * a checkpoint (e.g. points at a completed Voice run after an earlier success).
 * @param {object} item - CuriosityItem or GoalItem
 */
async function findLatestResumableCheckpointForPursuitItem(item) {
  const id = item?.id != null ? String(item.id).trim() : '';
  if (!id) return {};
  const { PipelineRun } = getMindEntityStores();
  let runs = [];
  try {
    runs = await PipelineRun.list('-created_date', 160);
  } catch {
    return {};
  }
  if (!Array.isArray(runs)) return {};
  const isGoal = isGoalLikePursuitItem(item);

  for (const run of runs) {
    const pack = tryPackResumeFromPipelineRun(run);
    if (!pack) continue;
    const cid = run.pursuit_parent_curiosity_id != null ? String(run.pursuit_parent_curiosity_id).trim() : '';
    const gid = run.pursuit_parent_goal_id != null ? String(run.pursuit_parent_goal_id).trim() : '';
    if (!isGoal && cid && cid === id) return pack;
    if (isGoal && gid && gid === id) return pack;
  }

  for (const run of runs) {
    const pack = tryPackResumeFromPipelineRun(run);
    if (!pack) continue;
    if (!isGoal && legacyRunMatchesCuriosityPursuit(run, item)) return pack;
    if (isGoal && legacyRunMatchesGoalPursuit(run, item)) return pack;
  }

  return {};
}

/**
 * If the item's last graph pursuit has a resumable checkpoint (or a newer checkpoint row exists), return seeds
 * for `runGraphPipelineOneShot` so Dashboard &quot;Rerun interrupted&quot; continues from the saved module
 * cursor instead of restarting from Perception.
 * @param {{ id?: string, last_pursuit_pipeline_run_id?: string | null, question?: string, goal_statement?: string } | null} item
 * @returns {Promise<{ initialFullSharedMemory?: object, executionResume?: object }>}
 */
export async function resolvePursuitResumeFromLastPipelineRun(item) {
  const { PipelineRun } = getMindEntityStores();
  const rid = item?.last_pursuit_pipeline_run_id;
  if (rid) {
    try {
      const run = await PipelineRun.retrieve(String(rid));
      const pack = tryPackResumeFromPipelineRun(run);
      if (pack) return pack;
    } catch {
      /* fall through */
    }
  }
  return findLatestResumableCheckpointForPursuitItem(item);
}
