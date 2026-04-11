import { ConversationMessage, PipelineRun } from './data';
import { isCheckpointPipelineRun, pickLatestNonCheckpointPipelineRun } from './pipelineRunCheckpoint';

function parseCreatedMs(record) {
  const raw = record?.created_date;
  if (raw == null || raw === '') return null;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Pick shared_memory for the next pipeline run from already-fetched rows.
 * Uses the fresher of: latest PipelineRun vs latest assistant ConversationMessage that carries shared_memory.
 * On equal timestamps, prefers the assistant message so chat and mind state stay aligned.
 *
 * @param {{ latestPipelineRun?: object | null, recentConversationMessages?: object[] }} opts
 * @returns {object | null}
 */
export function pickContinuationSharedMemoryFromFetched({
  latestPipelineRun = null,
  recentConversationMessages = [],
} = {}) {
  const run =
    latestPipelineRun && !isCheckpointPipelineRun(latestPipelineRun) ? latestPipelineRun : null;
  const runSm =
    run?.shared_memory && typeof run.shared_memory === 'object' ? run.shared_memory : null;
  const runMs = parseCreatedMs(run);

  const msgs = Array.isArray(recentConversationMessages) ? recentConversationMessages : [];
  let lastAsst = null;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role !== 'assistant') continue;
    const sm = m?.shared_memory;
    if (sm && typeof sm === 'object') {
      lastAsst = m;
      break;
    }
  }
  const asstSm =
    lastAsst?.shared_memory && typeof lastAsst.shared_memory === 'object'
      ? lastAsst.shared_memory
      : null;
  const asstMs = parseCreatedMs(lastAsst);

  if (runSm && !asstSm) return runSm;
  if (asstSm && !runSm) return asstSm;
  if (!runSm && !asstSm) return null;

  if (runMs == null && asstMs == null) return asstSm;
  if (runMs == null) return asstSm;
  if (asstMs == null) return runSm;
  if (asstMs > runMs) return asstSm;
  if (runMs > asstMs) return runSm;
  return asstSm;
}

/**
 * Fetch latest pipeline run and recent messages, then pick continuation shared_memory.
 */
export async function resolveLatestContinuationSharedMemory() {
  const [runs, msgs] = await Promise.all([
    PipelineRun.list('-created_date', 12),
    ConversationMessage.list('-created_date', 32),
  ]);
  return pickContinuationSharedMemoryFromFetched({
    latestPipelineRun: pickLatestNonCheckpointPipelineRun(runs),
    recentConversationMessages: msgs,
  });
}
