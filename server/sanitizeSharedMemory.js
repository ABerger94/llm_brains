/**
 * Clamp client-supplied sharedMemory before pipeline to avoid huge Perception prompts.
 *
 * When `opts.continuation === true` (supervisor RERUN leg with `pipelineMetacognitionContinuation`),
 * per-module caps are much higher so prior leg outputs are preserved. Very large POST bodies may
 * hit HTTP 413 / proxy limits — override with PIPELINE_CONTINUATION_MODULE_MAX_CHARS (12_000–2_000_000).
 */

const DEFAULT_MAX_MODULE_OUTPUT = 12_000;
const MAX_ORIGINAL_INPUT = 48_000;
const MAX_ORIGINAL_INPUT_CONTINUATION = 96_000;
const MAX_IDENTITY = 16_000;

function continuationModuleMaxChars() {
  const n = Number.parseInt(String(process.env.PIPELINE_CONTINUATION_MODULE_MAX_CHARS || '').trim(), 10);
  if (Number.isFinite(n) && n >= 12_000 && n <= 2_000_000) return n;
  return 400_000;
}

/**
 * @param {object} sm
 * @param {{ continuation?: boolean }} [opts]
 */
export function clampSharedMemoryForPipeline(sm, opts = {}) {
  if (sm == null || typeof sm !== 'object') return sm;
  const continuation = opts.continuation === true;
  const MAX_MODULE_OUTPUT = continuation ? continuationModuleMaxChars() : DEFAULT_MAX_MODULE_OUTPUT;
  const maxOriginalInput = continuation ? MAX_ORIGINAL_INPUT_CONTINUATION : MAX_ORIGINAL_INPUT;
  let o;
  try {
    o = JSON.parse(JSON.stringify(sm));
  } catch {
    return sm;
  }
  if (o.moduleOutputs && typeof o.moduleOutputs === 'object') {
    for (const key of Object.keys(o.moduleOutputs)) {
      if (key.endsWith('__meta')) continue;
      const v = o.moduleOutputs[key];
      if (typeof v === 'string' && v.length > MAX_MODULE_OUTPUT) {
        o.moduleOutputs[key] = `${v.slice(0, MAX_MODULE_OUTPUT)}\n\n[truncated ${v.length - MAX_MODULE_OUTPUT} chars]`;
      }
    }
  }
  if (typeof o.originalInput === 'string' && o.originalInput.length > maxOriginalInput) {
    o.originalInput = `${o.originalInput.slice(0, maxOriginalInput)}\n[truncated]`;
  }
  if (typeof o.recentExchangeBlock === 'string' && o.recentExchangeBlock.length > 14_000) {
    o.recentExchangeBlock = `${o.recentExchangeBlock.slice(0, 14_000)}\n[truncated]`;
  }
  if (typeof o.identityNarrative === 'string' && o.identityNarrative.length > MAX_IDENTITY) {
    o.identityNarrative = `${o.identityNarrative.slice(0, MAX_IDENTITY)}…`;
  }
  if (Array.isArray(o.narrativeHistory)) {
    o.narrativeHistory = o.narrativeHistory.slice(-12).map((x) => {
      if (typeof x !== 'string') return x;
      return x.length > 8000 ? `${x.slice(0, 8000)}…` : x;
    });
  }
  if (typeof o.webFindings === 'string' && o.webFindings.length > 12_000) {
    o.webFindings = `${o.webFindings.slice(0, 12_000)}\n[truncated]`;
  }
  if (Array.isArray(o.webFetchLog)) {
    o.webFetchLog = o.webFetchLog.slice(-12);
  }
  if (typeof o.webFetchSuppressReason === 'string' && o.webFetchSuppressReason.length > 600) {
    o.webFetchSuppressReason = `${o.webFetchSuppressReason.slice(0, 600)}…`;
  }
  if (o.webFetchSuppressedForRun != null && typeof o.webFetchSuppressedForRun !== 'boolean') {
    delete o.webFetchSuppressedForRun;
  }
  if (Array.isArray(o.clientLtmDigest)) {
    o.clientLtmDigest = o.clientLtmDigest.slice(0, 14).map((r) =>
      r && typeof r === 'object'
        ? {
            ...r,
            title: String(r.title || '').slice(0, 260),
            content: String(r.content || '').slice(0, 1800),
          }
        : r
    );
  }
  if (Array.isArray(o.clientBeliefDigest)) {
    o.clientBeliefDigest = o.clientBeliefDigest.slice(0, 22).map((r) =>
      r && typeof r === 'object' ? { ...r, statement: String(r.statement || '').slice(0, 620) } : r
    );
  }
  if (Array.isArray(o.clientAffectDigest)) {
    o.clientAffectDigest = o.clientAffectDigest.slice(0, 10).map((r) =>
      r && typeof r === 'object' ? { ...r, summary: String(r.summary || '').slice(0, 560) } : r
    );
  }
  if (typeof o.clientBiographyExcerpt === 'string' && o.clientBiographyExcerpt.length > 4000) {
    o.clientBiographyExcerpt = `${o.clientBiographyExcerpt.slice(0, 4000)}\n[truncated]`;
  }
  if (Array.isArray(o.clientWorldEnvironmentDigest)) {
    o.clientWorldEnvironmentDigest = o.clientWorldEnvironmentDigest.slice(0, 16).map((r) =>
      r && typeof r === 'object'
        ? {
            ...r,
            label: String(r.label || '').slice(0, 220),
            description: String(r.description || '').slice(0, 1000),
          }
        : r
    );
  }
  if (Array.isArray(o.clientCuriosityDigest)) {
    o.clientCuriosityDigest = o.clientCuriosityDigest.slice(0, 12).map((r) =>
      r && typeof r === 'object' ? { ...r, question: String(r.question || '').slice(0, 440) } : r
    );
  }
  if (Array.isArray(o.clientGoalDigest)) {
    o.clientGoalDigest = o.clientGoalDigest.slice(0, 10).map((r) =>
      r && typeof r === 'object' ? { ...r, statement: String(r.statement || '').slice(0, 560) } : r
    );
  }
  return o;
}
