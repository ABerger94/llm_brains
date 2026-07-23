/**
 * Shared env helpers for local LM Studio / Ollama (read in pipeline + HTTP server).
 *
 * Long unattended runs: each pipeline module is one (or more) LLM HTTP calls bounded by {@link resolveDefaultLlmTimeoutMs}.
 * If calls hit the cap, the stream fails with `Timeout after ${cap}ms` — raise `LOCAL_LLM_TIMEOUT_MS` (max 2h) and/or enable
 * soft timeout via `LOCAL_LLM_SOFT_TIMEOUT_MS` / buffer so the pipeline records partial output and continues. The browser
 * scheduler’s “stale running” threshold (Settings) should exceed worst-case (modules × timeout) for a single scheduled task.
 */

function requiredEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

export function localLlmLowSpec() {
  const v = String(process.env.LOCAL_LLM_LOW_SPEC || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Max total characters of prior moduleOutputs kept in sharedMemory JSON per step (before the next LLM call).
 * Lower = smaller prompts = faster on weak CPUs. Override with LOCAL_LLM_CONTEXT_BUDGET_CHARS.
 */
export function localLlmContextBudgetChars() {
  const raw = requiredEnv('LOCAL_LLM_CONTEXT_BUDGET_CHARS');
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 4000 && n <= 80000) return n;
  }
  return localLlmLowSpec() ? 7200 : 14000;
}

/**
 * Per HTTP completion wait (single module hop). Override LOCAL_LLM_TIMEOUT_MS; max 2h.
 * Default is enough for a heavy 8B step on a slow CPU but avoids 30m “silent” hangs when misconfigured.
 */
export function resolveDefaultLlmTimeoutMs() {
  const raw = requiredEnv('LOCAL_LLM_TIMEOUT_MS');
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 10_000 && n <= 7_200_000) return Math.floor(n);
  }
  const low = localLlmLowSpec();
  return low ? 480_000 : 900_000;
}

/**
 * Per-module soft deadline for local streaming: abort early and keep partial tokens so the pipeline can continue.
 * If unset: hardTimeoutMs − LOCAL_LLM_SOFT_BUFFER_MS (default 120_000), clamped so 10_000 <= soft < hard.
 * Override absolute (must be < hard): LOCAL_LLM_SOFT_TIMEOUT_MS.
 * Returns 0 if disabled or invalid.
 */
export function resolveLocalLlmSoftTimeoutMs(hardTimeoutMs) {
  const hard = Math.floor(Number(hardTimeoutMs) || 0);
  if (!Number.isFinite(hard) || hard < 20_000) return 0;

  const absRaw = requiredEnv('LOCAL_LLM_SOFT_TIMEOUT_MS');
  if (absRaw && /^\d+$/.test(absRaw.trim())) {
    const n = Number(absRaw.trim());
    if (Number.isFinite(n) && n >= 10_000 && n < hard) return Math.floor(n);
    return 0;
  }

  const bufRaw = process.env.LOCAL_LLM_SOFT_BUFFER_MS;
  const buffer =
    bufRaw && String(bufRaw).trim() && /^\d+$/.test(String(bufRaw).trim())
      ? Number(String(bufRaw).trim())
      : 120_000;
  if (!Number.isFinite(buffer) || buffer < 0) return 0;

  const soft = hard - buffer;
  if (soft < 10_000 || soft >= hard) return 0;
  return Math.floor(soft);
}

/**
 * For the local OpenAI-compatible server only: max ms without any streaming chunk before aborting.
 * Catches hung servers / wrong model id instead of waiting LOCAL_LLM_TIMEOUT_MS.
 * Set LOCAL_LLM_STALL_MS=0 to use non-streaming mode (legacy).
 */
export function resolveLocalLlmStallTimeoutMs() {
  const raw = requiredEnv('LOCAL_LLM_STALL_MS');
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n === 0) return 0;
    if (Number.isFinite(n) && n >= 15_000 && n <= 7_200_000) return Math.floor(n);
  }
  return localLlmLowSpec() ? 180_000 : 120_000;
}

/** Default max_tokens when the caller does not set one (e.g. /api/llm/text). */
export function resolveDefaultLocalMaxTokens() {
  return localLlmLowSpec() ? 512 : 800;
}

/**
 * When true, compressSharedMemory() may shrink moduleOutputs to fit LOCAL_LLM_CONTEXT_BUDGET_CHARS.
 * Default false: rely on LLM_CONTEXT_TOKENS_MAX + optional chunked map/reduce instead.
 */
export function shouldCompressSharedMemory() {
  const v = String(process.env.LOCAL_LLM_COMPRESS_SHARED_MEMORY || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Second Reasoning completion + merge when PIPELINE_REASONING_MULTI_SAMPLE=1|true|yes */
export function reasoningMultiSampleEnabled() {
  const v = String(process.env.PIPELINE_REASONING_MULTI_SAMPLE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** `llm` (default): third call merges drafts. `mechanical`: union HYPOTHESES_JSON only, keep longer prose body. */
export function reasoningMultiSampleMergeMode() {
  const v = String(process.env.PIPELINE_REASONING_MERGE || 'llm').toLowerCase().trim();
  if (v === 'mechanical') return 'mechanical';
  return 'llm';
}

export function integrationMultiSampleEnabled() {
  const v = String(process.env.PIPELINE_INTEGRATION_MULTI_SAMPLE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function contradictionMultiSampleEnabled() {
  const v = String(process.env.PIPELINE_CONTRADICTION_MULTI_SAMPLE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function multiSampleMergeMode() {
  const v = String(process.env.PIPELINE_MULTI_SAMPLE_MERGE || 'llm').toLowerCase().trim();
  if (v === 'mechanical') return 'mechanical';
  return 'llm';
}

/** Temperature for the second Reasoning sample (first uses request defaults). Default 0.92. */
export function reasoningMultiSampleSecondTemperature() {
  const raw = String(process.env.PIPELINE_REASONING_SAMPLE2_TEMP || '').trim();
  if (raw && /^-?\d*\.?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0.2 && n <= 1.5) return n;
  }
  return 0.92;
}

/**
 * Multiply prior-turn hypothesis weights when hydrating from priorTurnGlobalWorkspace.hypotheses.
 * Default 0.88; clamp 0.5–1 (set PIPELINE_PRIOR_HYPOTHESIS_DECAY).
 */
export function priorHypothesisDecayFactor() {
  const raw = String(process.env.PIPELINE_PRIOR_HYPOTHESIS_DECAY || '').trim();
  if (raw && /^-?\d*\.?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0.5 && n <= 1) return n;
  }
  return 0.88;
}
