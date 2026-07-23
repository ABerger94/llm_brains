import { MirrorPipelineRun, PipelineRun } from './data';
import { filterPipelineRunsForGraphSession } from './graphPipelineConversation';
import { PLAYGROUND_GRAPH_SESSION_B } from './playgroundDualGraphRunner';
import {
  getVoiceModuleOutputTextFromPipelineRun,
  isCheckpointPipelineRun,
  isPausedBeforePlaceholderOutput,
} from './pipelineRunCheckpoint';
import { graphPipelineStore, validCooperativePipelineCheckpoint } from './graphPipelineStore';

/**
 * Only **successful-looking** full runs should invalidate a cooperative pause. Failed runs, empty
 * rows, or mid-stack abandons must not clear the checkpoint (common after mind import when history
 * includes many non-checkpoint rows newer than `savedAt`).
 */
function pipelineRunLooksLikeSuccessfulFullCompletion(row) {
  if (!row || typeof row !== 'object') return false;
  const voice = getVoiceModuleOutputTextFromPipelineRun(row);
  if (voice.length >= 8) return true;
  const st = String(row.run_status || '')
    .trim()
    .toLowerCase();
  if (st === 'complete' || st === 'completed' || st === 'success') return true;
  return false;
}

/**
 * True when a **successfully completed** (non-checkpoint) pipeline run for this graph session is newer than the
 * checkpoint's `savedAt`, so resuming the checkpoint would redo work that already finished.
 */
export async function isGraphCheckpointSupersededByCompletedRun(sessionId, checkpointSavedAt) {
  try {
    const sid = String(sessionId || '').trim();
    const ckAt = Number(checkpointSavedAt);
    if (!sid || !Number.isFinite(ckAt) || ckAt <= 0) return false;
    let runs = [];
    try {
      const Run = sid === PLAYGROUND_GRAPH_SESSION_B ? MirrorPipelineRun : PipelineRun;
      runs = await Run.list('-created_date', 64);
    } catch {
      return false;
    }
    const forSession = filterPipelineRunsForGraphSession(runs, sid);
    for (const r of forSession) {
      if (!r) continue;
      if (isCheckpointPipelineRun(r) || isPausedBeforePlaceholderOutput(r)) continue;
      if (!pipelineRunLooksLikeSuccessfulFullCompletion(r)) continue;
      const t = Date.parse(String(r.created_date || ''));
      if (!Number.isFinite(t)) continue;
      if (t > ckAt) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * If the current graph store has a checkpoint that is stale vs PipelineRun history, clear it from KV.
 * @returns {Promise<boolean>} true if stale and cleared
 */
export async function clearStaleGraphPipelineCheckpointIfSuperseded(sessionId) {
  try {
    const ck = validCooperativePipelineCheckpoint(graphPipelineStore.getState().pipelineCheckpoint);
    if (!ck) return false;
    const savedAt = Number(ck.savedAt);
    if (!Number.isFinite(savedAt) || savedAt <= 0) return false;
    const stale = await isGraphCheckpointSupersededByCompletedRun(sessionId, savedAt);
    if (!stale) return false;
    graphPipelineStore.patch({ pipelineCheckpoint: null });
    graphPipelineStore.flushPersist();
    return true;
  } catch (e) {
    console.warn('[graphCheckpointStale] clear stale checkpoint skipped:', e?.message || e);
    return false;
  }
}
