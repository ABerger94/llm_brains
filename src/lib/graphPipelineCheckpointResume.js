import { normalizeExecutionResume } from '../../shared/pipelineExecutionResume.mjs';
import {
  ConversationMessage,
  MirrorConversationMessage,
  MirrorPipelineRun,
  PipelineRun,
} from './data';
import {
  inferExecutionResumeFromModuleCheckpointFinalOutput,
  inferExecutionResumeFromPausedPipelineRun,
  isCheckpointPipelineRun,
} from './pipelineRunCheckpoint';
import { normalizeModuleOutputsFromServer } from './cognitiveModules';
import { filterConversationRowsForGraphSession, filterPipelineRunsForGraphSession } from './graphPipelineConversation';
import { isGraphCheckpointSupersededByCompletedRun } from './graphCheckpointStale';
import { reconcileCompleteStatusesFromOutputs } from './pipelineModuleStatusUi';
import { graphPipelineStore, validCooperativePipelineCheckpoint } from './graphPipelineStore';
import { resolveGraphSessionMindStorageProfile } from './graphSessionMindProfile';
import { MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR } from './mindEntityContext';

/**
 * Build a session-KV-shaped cooperative checkpoint from a persisted PipelineRun checkpoint row.
 *
 * @param {object} run
 * @param {string[]} [attachmentIds]
 * @param {string} [sessionIdHint] When {@link run.graph_session_id} is empty (legacy rows), use the session being resumed (e.g. System B mirror).
 * @returns {object | null}
 */
export function buildGraphPipelineCheckpointBlobFromRun(run, attachmentIds = [], sessionIdHint = '') {
  if (!run || !isCheckpointPipelineRun(run)) return null;
  const sm = run.shared_memory && typeof run.shared_memory === 'object' ? run.shared_memory : null;
  if (!sm) return null;
  const ec =
    normalizeExecutionResume(run.execution_resume) ||
    inferExecutionResumeFromPausedPipelineRun(run) ||
    inferExecutionResumeFromModuleCheckpointFinalOutput(run);
  if (!ec || Number(ec.v) !== 1) return null;
  const rawMo = run.module_outputs && typeof run.module_outputs === 'object' ? run.module_outputs : {};
  const normalized = normalizeModuleOutputsFromServer(rawMo);
  const moduleStatusesSnapshot = reconcileCompleteStatusesFromOutputs({}, normalized);
  const savedAt = Date.parse(String(run.created_date || '')) || Date.now();
  const hint = String(sessionIdHint || '').trim();
  const gs = String(run.graph_session_id || '').trim() || hint;
  const mindStorageProfile = resolveGraphSessionMindStorageProfile(gs);
  return {
    savedAt,
    executionCursor: ec,
    slimSharedMemory: sm,
    moduleOutputsSnapshot: normalized,
    moduleStatusesSnapshot,
    userInput: String(run.input || ''),
    attachmentIds: Array.isArray(attachmentIds) ? attachmentIds.map((id) => String(id)).filter(Boolean) : [],
    graphSessionId: gs,
    mindStorageProfile,
  };
}

/**
 * Match the user line for this run so attachment ids match the interactive graph POST.
 *
 * @param {string} graphSessionId
 * @param {string} inputText
 * @returns {Promise<string[]>}
 */
async function resolveAttachmentIdsForCheckpointRun(graphSessionId, inputText) {
  const sid = String(graphSessionId || '').trim();
  const input = String(inputText || '').trim();
  if (!sid || !input) return [];
  try {
    const Msg =
      resolveGraphSessionMindStorageProfile(sid) === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR
        ? MirrorConversationMessage
        : ConversationMessage;
    const rows = await Msg.list('-created_date', 120);
    const filtered = filterConversationRowsForGraphSession(rows, sid);
    for (const r of filtered) {
      if (String(r.role || '') !== 'user') continue;
      if (String(r.content || '').trim() !== input) continue;
      const ids = r.attachment_ids;
      if (Array.isArray(ids)) return ids.map((id) => String(id)).filter(Boolean);
      return [];
    }
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * Newest-first: first PipelineRun checkpoint for this graph session that is still valid to resume
 * (not superseded by a later completed run) and has a normalizable execution cursor + shared memory.
 *
 * @param {string} graphSessionId
 * @returns {Promise<object | null>} Checkpoint blob for {@link graphPipelineStore.patch} — same shape as cooperative KV.
 */
export async function findResumableCheckpointForGraphSessionFromDb(graphSessionId) {
  const sid = String(graphSessionId || '').trim();
  if (!sid) return null;
  let runs = [];
  try {
    const Run =
      resolveGraphSessionMindStorageProfile(sid) === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR
        ? MirrorPipelineRun
        : PipelineRun;
    runs = await Run.list('-created_date', 64);
  } catch {
    return null;
  }
  const forSession = filterPipelineRunsForGraphSession(runs, sid);
  for (const run of forSession) {
    if (!isCheckpointPipelineRun(run)) continue;
    const savedAt = Date.parse(String(run.created_date || ''));
    if (Number.isFinite(savedAt) && savedAt > 0) {
      const superseded = await isGraphCheckpointSupersededByCompletedRun(sid, savedAt);
      if (superseded) continue;
    }
    const attachmentIds = await resolveAttachmentIdsForCheckpointRun(sid, run.input);
    const blob = buildGraphPipelineCheckpointBlobFromRun(run, attachmentIds, sid);
    if (blob && validCooperativePipelineCheckpoint(blob)) return blob;
  }
  return null;
}

/**
 * If the graph store has no checkpoint, load the newest resumable checkpoint row from IndexedDB into KV.
 *
 * @param {string} graphSessionId
 * @returns {Promise<{ ok: boolean, source?: 'store' | 'db', reason?: string }>}
 */
export async function tryLoadCheckpointFromDbIntoStore(graphSessionId) {
  const existing = validCooperativePipelineCheckpoint(graphPipelineStore.getState().pipelineCheckpoint);
  if (existing) return { ok: true, source: 'store' };
  const blob = await findResumableCheckpointForGraphSessionFromDb(graphSessionId);
  if (!blob) return { ok: false, reason: 'none' };
  graphPipelineStore.patch({ pipelineCheckpoint: blob });
  graphPipelineStore.flushPersist();
  return { ok: true, source: 'db' };
}
