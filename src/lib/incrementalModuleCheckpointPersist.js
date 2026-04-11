import { PipelineRun } from './data';
import { persistMindAfterPipeline } from './mindPersistence';
import { runtimeSettingsForPersistence } from './runtimeSettings';
import { getExecutionPlan } from './cognitiveModules';

let checkpointWriteChain = Promise.resolve();

/**
 * Serialize incremental checkpoint DB writes so `last_pursuit_pipeline_run_id` stays ordered.
 * @param {() => Promise<void>} fn
 */
function enqueueIncrementalCheckpointWrite(fn) {
  checkpointWriteChain = checkpointWriteChain.then(fn).catch((e) => {
    console.warn('[incremental checkpoint] persist failed', e);
  });
}

/**
 * After each pipeline module, persist a resumable checkpoint row + link pursuit items (when applicable).
 * Fire-and-forget from SSE handlers; internally serialized.
 *
 * @param {object} opts
 * @param {object} opts.evt - SSE `module_complete` with `sharedMemory` + `executionCheckpoint`
 * @param {string} opts.promptText
 * @param {object} opts.runtimeSettings
 * @param {string} [opts.source]
 * @param {{ parentCuriosityId?: string, rootCuriosityId?: string } | null} [opts.curiosityPursuitContext]
 * @param {{ parentGoalId?: string, rootGoalId?: string } | null} [opts.goalPursuitContext]
 * @param {string | null} [opts.graphSessionIdForPipelineRun]
 */
export function scheduleIncrementalModuleCheckpointPersist({
  evt,
  promptText,
  runtimeSettings,
  source = 'graph-pipeline',
  curiosityPursuitContext = null,
  goalPursuitContext = null,
  graphSessionIdForPipelineRun = null,
}) {
  const sm = evt?.sharedMemory && typeof evt.sharedMemory === 'object' ? evt.sharedMemory : null;
  const ec = evt?.executionCheckpoint && typeof evt.executionCheckpoint === 'object' ? evt.executionCheckpoint : null;
  if (!sm || !ec || Number(ec.v) !== 1) return;

  const completed = String(evt.moduleName || '').trim();
  const nextMod = String(ec.nextModuleName || '').trim();
  const finalLine = `(Module checkpoint after ${completed || '?'} — resume at ${nextMod || 'next'})`;

  enqueueIncrementalCheckpointWrite(async () => {
    const rawOutputs = sm.moduleOutputs || {};
    const graphSidPatch =
      graphSessionIdForPipelineRun != null && String(graphSessionIdForPipelineRun).trim()
        ? { graph_session_id: String(graphSessionIdForPipelineRun).trim() }
        : {};

    const runRow = await PipelineRun.create({
      input: String(promptText || ''),
      module_outputs: rawOutputs,
      shared_memory: sm,
      execution_plan: getExecutionPlan(),
      loop_count: Number(sm.metacognitionRerunsUsed) || 0,
      final_output: finalLine,
      runtime_settings: runtimeSettingsForPersistence(runtimeSettings),
      provider_used: sm.lastProviderUsed ?? null,
      model_used: sm.lastModelUsed ?? null,
      phase: sm.phase,
      arousal: sm.arousal,
      intent: sm.intent,
      phenomenal_now: sm.phenomenalNow || null,
      cognitive_policy: sm.cognitivePolicy || null,
      run_status: 'checkpoint',
      pipeline_checkpoint: true,
      execution_resume: ec,
      ...graphSidPatch,
    });

    const narrativeText = rawOutputs.Narrative || rawOutputs.narrative || '';
    await persistMindAfterPipeline({
      sharedMemory: sm,
      voiceOutput: '',
      narrativeText,
      runtimeSettings,
      source: source || 'pipeline',
      pipelineRunId: runRow?.id || null,
      curiosityPursuitContext,
      goalPursuitContext,
      pipelinePartialCheckpoint: true,
    });
  });
}
