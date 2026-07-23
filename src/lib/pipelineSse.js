import { PIPELINE_SCHEMA_VERSION } from '../../shared/pipelineModules.mjs';
import { patchDashboardLlmFromPipelineSseEvent } from './graphPipelineStore';
import { slimSharedMemoryForPipelinePost } from './slimSharedMemory';
import { formatPipelineSseErrorPayload, stringifyJsonSafe } from './pipelineRunErrorFormat';

const FETCH_ERROR_BODY_MAX = 32_000;

export async function readFetchErrorMessage(res) {
  const status = res.status;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text().catch(() => '');

  if (status === 502 || status === 503 || status === 504) {
    return `API unreachable (HTTP ${status}). Start the full stack with "npm run dev" (UI on port 5174, API proxied) or run the backend only with "npm run dev:backend".`;
  }
  if (status === 413 || /PayloadTooLargeError|request entity too large/i.test(raw)) {
    return 'Request body too large (usually continued shared memory). Try a shorter session or Reset on Graph Pipeline.';
  }
  if (ct.includes('application/json')) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        const errLine = j.error != null ? String(j.error).trim() : '';
        const detail =
          j.details != null
            ? typeof j.details === 'string'
              ? j.details.trim()
              : stringifyJsonSafe(j.details)
            : '';
        if (errLine && detail) return `${errLine}\n\n${detail}`;
        if (errLine) return errLine;
      }
    } catch {
      /* ignore */
    }
  }
  if (raw.includes('JSON.parse') && raw.includes('body-parser')) {
    return 'Invalid JSON in request (or body too large for the server).';
  }
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const snippet = normalized.length > FETCH_ERROR_BODY_MAX ? normalized.slice(0, FETCH_ERROR_BODY_MAX) : normalized;
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status} from pipeline stream`;
}

export function formatProviderFailures(details) {
  if (!Array.isArray(details) || !details.length) return '';
  return details
    .slice(0, 6)
    .map((f) => {
      const id = f.provider || 'provider';
      const msg = f.error?.message || f.error?.error || JSON.stringify(f.error || {}).slice(0, 80);
      const model = f.model ? ` (${f.model})` : '';
      return `${id}${model}: ${msg}`;
    })
    .join(' | ');
}

const LOCAL_LLM_HINT =
  'Check LM Studio: Local Server must be running, LOCAL_LLM_BASE_URL should match (e.g. http://127.0.0.1:1234), and LOCAL_LLM_MODELS must equal the exact model id the server shows. With both HF and local configured, the API tries local first unless LLM_HF_FIRST=1. Defaults: ~8–15m per module (LOCAL_LLM_LOW_SPEC shortens); raise LOCAL_LLM_TIMEOUT_MS for very slow runs (max 7200000). Restart the backend after changing .env.';

/**
 * Append recovery guidance when the error looks like rate limit / quota / credits.
 */
export function appendRateLimitRecoveryHint(message) {
  const raw = String(message || '').trim();
  if (/groq\s*\(|together:\s*Missing/i.test(raw)) {
    return `${raw}\n\n— Restart the API server, then open /api/health and confirm llm.providerIds (e.g. ["local","openrouter","huggingface"]) and llm.backendProfile (underscore-joined ids). Default dev (UI port 5174) uses LLM_HF_FIRST=1; npm run dev:local uses LLM_LOCAL_FIRST=1 (UI port 3000).`;
  }
  if (raw.includes('LOCAL_LLM_BASE_URL') || raw.includes('ollama.com')) return raw;
  const m = raw.toLowerCase();
  const looksRateLimited =
    /\b429\b/.test(m) ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('quota') ||
    m.includes('credit') ||
    m.includes('exhausted') ||
    m.includes('capacity');
  if (!looksRateLimited) return raw;
  return `${raw}\n\n— ${LOCAL_LLM_HINT}`;
}

/**
 * Dispatch SSE JSON to the handler without awaiting returned promises.
 * The pipeline transcript path used `async` handlers + `await streamThoughtChunks`, which blocked the
 * reader and stalled the TCP window while Perception (large first payload) was still streaming.
 */
function dispatchPipelineSseEvent(onEvent, data) {
  patchDashboardLlmFromPipelineSseEvent(data);
  const ret = onEvent(data);
  if (ret != null && typeof ret.then === 'function') {
    void ret.catch((err) => console.error('[pipeline SSE] async handler error:', err));
  }
}

function processSseBuffer(buffer, onEvent) {
  let rest = buffer;
  for (;;) {
    const sep = rest.indexOf('\n\n');
    if (sep === -1) break;
    const chunk = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) {
        const rawLine = line.slice(5).trim();
        if (!rawLine) continue;
        let data;
        try {
          data = JSON.parse(rawLine);
        } catch (e) {
          console.warn('SSE parse error', e);
          continue;
        }
        dispatchPipelineSseEvent(onEvent, data);
      }
    }
  }
  return rest;
}

export async function consumePipelineSse(response, onEvent) {
  if (!response.body) {
    throw new Error('Pipeline response has no body (stream unavailable).');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value?.byteLength) {
        buffer += decoder.decode(value, { stream: true });
      }
      buffer = processSseBuffer(buffer, onEvent);
      if (done) {
        buffer += decoder.decode();
        processSseBuffer(buffer, onEvent);
        break;
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* already closed */ }
  }
}

/**
 * Chains multiple POST /api/pipeline/stream calls when the server emits `pipeline_continuation`
 * (supervisor RERUN split across HTTP legs). When the server ends with
 * `complete` + `metacognitionRerunPending` (deferred rerun mode), returns after the first leg — caller schedules the next run.
 *
 * Persistence: immediate multi-leg chains produce one final `complete` and typically one `PipelineRun`
 * row for the whole user action (final `shared_memory` reflects the last leg). Partial deferred legs
 * are persisted separately when the client saves after `partial: true`.
 *
 * @param {object} opts
 * @param {string} [opts.streamUrl]
 * @param {(ctx: { leg: number, slimSharedMemory: object|null, pipelineMetacognitionContinuation: boolean }) => RequestInit | Promise<RequestInit>} opts.buildFetchInit
 * @param {object|null} [opts.initialSlimSharedMemory]
 * @param {(evt: object) => void} [opts.onEvent]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.maxLegs]
 * @param {AbortSignal} [opts.abortSignal] - aborts in-flight fetch/SSE (all legs share this signal)
 * @param {boolean} [opts.treatFirstLegAsContinuation] - when true, first POST already continues a prior leg (e.g. deferred supervisor RERUN); server must receive `pipelineMetacognitionContinuation: true` on leg 1 so shared memory is not stripped.
 * @returns {Promise<object>} Final `complete` event payload
 */
export async function consumePipelineSseWithMetacognitionContinuations({
  streamUrl = '/api/pipeline/stream',
  buildFetchInit,
  initialSlimSharedMemory = null,
  onEvent,
  fetchImpl = fetch,
  maxLegs = 14,
  treatFirstLegAsContinuation = false,
  abortSignal,
}) {
  let slimSm = initialSlimSharedMemory;
  let streamResult = null;

  for (let leg = 1; leg <= maxLegs; leg += 1) {
    /** Fresh per HTTP leg — avoids a stray prior `complete` masking a continuation-only response. */
    streamResult = null;
    const pipelineMetacognitionContinuation =
      leg > 1 || (leg === 1 && treatFirstLegAsContinuation === true);
    const baseInit = await buildFetchInit({
      leg,
      slimSharedMemory: slimSm,
      pipelineMetacognitionContinuation,
    });
    const init = abortSignal ? { ...baseInit, signal: abortSignal } : baseInit;
    const res = await fetchImpl(streamUrl, init);
    if (!res.ok) {
      throw new Error(await readFetchErrorMessage(res));
    }

    let continuation = null;
    /** @type {object | null} */
    let pausedEvt = null;
    await consumePipelineSse(res, (evt) => {
      if (evt.type === 'error') {
        const full = formatPipelineSseErrorPayload(evt);
        throw new Error(appendRateLimitRecoveryHint(full));
      }
      dispatchPipelineSseEvent(onEvent, evt);
      if (evt.type === 'pipeline_continuation') continuation = evt;
      if (evt.type === 'complete') streamResult = evt;
      if (evt.type === 'paused') pausedEvt = evt;
    });

    if (pausedEvt) {
      const sm = pausedEvt.sharedMemory && typeof pausedEvt.sharedMemory === 'object' ? pausedEvt.sharedMemory : null;
      const ecRaw = pausedEvt.executionCursor;
      const executionCursor =
        ecRaw && typeof ecRaw === 'object'
          ? ecRaw
          : {
              v: PIPELINE_SCHEMA_VERSION,
              phase: pausedEvt.phase,
              nextModuleName: pausedEvt.nextModuleName,
            };
      const ru = sm?.metacognitionRerunsUsed;
      const rerunsUsed =
        typeof ru === 'number' && Number.isFinite(ru) ? ru : Number(pausedEvt.rerunsUsed) || 0;
      return {
        type: 'paused',
        pipelinePaused: true,
        sharedMemory: sm,
        executionCursor,
        voiceOutput: '',
        partial: true,
        rerunsUsed,
        providerUsed: sm?.lastProviderUsed ?? null,
        modelUsed: sm?.lastModelUsed ?? null,
      };
    }
    if (streamResult) return streamResult;
    if (continuation) {
      if (!continuation.sharedMemory || typeof continuation.sharedMemory !== 'object') {
        throw new Error(
          'Supervisor continuation event is missing sharedMemory — cannot POST the next pipeline leg (check server slimSharedMemoryForSse / SSE payload size).'
        );
      }
      slimSm = slimSharedMemoryForPipelinePost(continuation.sharedMemory, { continuation: true });
      continue;
    }
    throw new Error('Stream ended without a complete or pipeline_continuation event.');
  }

  throw new Error(`Pipeline exceeded ${maxLegs} metacognition continuation legs.`);
}
