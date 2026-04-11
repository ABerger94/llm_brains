import { MODULES, PIPELINE_LAYERS } from '../../shared/pipelineModules.mjs';
import { normalizeExecutionResume } from '../../shared/pipelineExecutionResume.mjs';

const CANONICAL_MODULE_NAMES = new Set(MODULES.map((m) => m.name));

function phaseForCanonicalModuleName(name) {
  if (PIPELINE_LAYERS.layer5.includes(name)) return 'layer5';
  if (PIPELINE_LAYERS.layer6.includes(name)) return 'layer6';
  for (const lk of ['layer1', 'layer2', 'layer3', 'layer4']) {
    if (PIPELINE_LAYERS[lk].includes(name)) return 'layer14';
  }
  return null;
}

/**
 * Legacy paused runs (before `execution_resume` on the row) still store `(Paused before ModuleName)` in
 * `final_output` — infer a v1 cursor so import + Resume all can continue after Perception.
 * @param {object | null | undefined} row
 * @returns {{ v: number, phase: string, nextModuleName: string } | null}
 */
export function inferExecutionResumeFromPausedPipelineRun(row) {
  if (!row || typeof row !== 'object' || !isCheckpointPipelineRun(row)) return null;
  if (normalizeExecutionResume(row.execution_resume)) return null;
  const fo = String(row.final_output || '');
  const m = fo.match(/Paused before ([^)]+)\)/);
  if (!m) return null;
  const nextModuleName = m[1].trim();
  if (!nextModuleName || nextModuleName === 'next module') return null;
  if (!CANONICAL_MODULE_NAMES.has(nextModuleName)) return null;
  const phase = phaseForCanonicalModuleName(nextModuleName);
  if (!phase) return null;
  return normalizeExecutionResume({ v: 1, phase, nextModuleName });
}

/**
 * Checkpoint / paused pipeline runs must not become the default continuation seed for new graphs.
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isCheckpointPipelineRun(row) {
  if (!row || typeof row !== 'object') return false;
  const st = String(row.run_status || '').trim().toLowerCase();
  if (st === 'paused' || st === 'checkpoint') return true;
  if (row.pipeline_checkpoint === true) return true;
  return false;
}

/**
 * Cooperative-pause rows store this in `final_output` even when checkpoint flags are missing (legacy imports).
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isPausedBeforePlaceholderOutput(row) {
  const fo = String(row?.final_output || '').trim();
  return /^\(Paused before\b/i.test(fo);
}

/**
 * Metacognition deferred Voice to a later supervisor_pipeline_rerun; `final_output` is a placeholder, not Voice text.
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isSupervisorRerunPendingFinalOutput(row) {
  const fo = String(row?.final_output || '').trim();
  return /^\(Supervisor RERUN scheduled/i.test(fo);
}

/**
 * Raw Voice module text from persisted `module_outputs` (canonical server key `Voice`).
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function getVoiceModuleOutputTextFromPipelineRun(row) {
  if (!row || typeof row !== 'object') return '';
  const mo = row.module_outputs && typeof row.module_outputs === 'object' ? row.module_outputs : {};
  const alt = row.moduleOutputs && typeof row.moduleOutputs === 'object' ? row.moduleOutputs : {};
  return String(mo.Voice ?? mo.voice ?? alt.Voice ?? alt.voice ?? '').trim();
}

/**
 * Newest-first: first run with non-empty Voice module output. Skips checkpoints, pause placeholders,
 * and supervisor-RERUN-pending rows (Voice not completed in that save).
 * @param {object[] | null | undefined} runs
 * @returns {object | null}
 */
export function pickLatestPipelineRunWithVoiceModuleOutput(runs) {
  if (!Array.isArray(runs)) return null;
  for (const r of runs) {
    if (!r || isCheckpointPipelineRun(r) || isPausedBeforePlaceholderOutput(r)) continue;
    if (isSupervisorRerunPendingFinalOutput(r)) continue;
    if (!getVoiceModuleOutputTextFromPipelineRun(r)) continue;
    return r;
  }
  return null;
}

/**
 * First non-checkpoint run in a list already sorted newest-first (e.g. PipelineRun.list('-created_date', n)).
 * Skips paused-placeholder `final_output` lines so the dashboard can show the last real Voice line.
 * @param {object[] | null | undefined} runs
 * @returns {object | null}
 */
export function pickLatestNonCheckpointPipelineRun(runs) {
  if (!Array.isArray(runs)) return null;
  for (const r of runs) {
    if (r && !isCheckpointPipelineRun(r) && !isPausedBeforePlaceholderOutput(r)) return r;
  }
  return null;
}

/** Newest-first lists: drop cooperative-pause checkpoint rows and legacy `(Paused before …)` placeholders. */
export function excludeCheckpointPipelineRuns(runs) {
  if (!Array.isArray(runs)) return [];
  return runs.filter((r) => !isCheckpointPipelineRun(r) && !isPausedBeforePlaceholderOutput(r));
}
