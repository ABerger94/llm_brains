import { normalizeExecutionResume } from '../../shared/pipelineExecutionResume.mjs';
import { PipelineRun } from './data';
import { inferExecutionResumeFromPausedPipelineRun, isCheckpointPipelineRun } from './pipelineRunCheckpoint';

/**
 * If the item's last graph pursuit ended in a cooperative pause, return seeds for `runGraphPipelineOneShot`.
 * @param {{ last_pursuit_pipeline_run_id?: string | null }} item
 * @returns {Promise<{ initialFullSharedMemory?: object, executionResume?: object }>}
 */
export async function resolvePursuitResumeFromLastPipelineRun(item) {
  const rid = item?.last_pursuit_pipeline_run_id;
  if (!rid) return {};
  let run;
  try {
    run = await PipelineRun.retrieve(String(rid));
  } catch {
    return {};
  }
  if (!run || !isCheckpointPipelineRun(run)) return {};
  const executionResume =
    normalizeExecutionResume(run.execution_resume) || inferExecutionResumeFromPausedPipelineRun(run);
  if (!executionResume) return {};
  const sm = run.shared_memory;
  if (!sm || typeof sm !== 'object') return {};
  return {
    initialFullSharedMemory: sm,
    executionResume,
  };
}
