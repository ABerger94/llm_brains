/**
 * In-browser mirror of pipelineSse.js's consumePipelineSseWithMetacognitionContinuations,
 * with the exact same call signature and multi-leg continuation looping — but instead of
 * POSTing to /api/pipeline/stream per leg, it calls server/pipeline.js's runPipeline()
 * in-process, with callLLM backed by an in-browser WebGPU model (browserCallLlm.js)
 * instead of Express's LM Studio/HF/OpenRouter providers.
 *
 * runPipeline's onEvent already emits the exact event shapes the SSE path relays
 * verbatim (server/index.js just forwards them over the wire via sseSend) — so
 * every caller's onEvent handler (consciousnessStreamRunner.js, runGraphPipelineOneShot.js)
 * needs zero changes to consume this. Only reached via dynamic import() when the
 * execution-backend setting is "browser" (see executionBackend.js) — never imported
 * eagerly, so the normal server-backed build path pays no cost for it.
 *
 * server/pipeline.js resolves cleanly here because vite.config.js's localPipelineAliases()
 * are registered unconditionally (both build paths), not gated on a build flag.
 */
import './processPolyfill';
import { runPipeline } from '../../../server/pipeline.js';
import { PIPELINE_SCHEMA_VERSION } from '../../../shared/pipelineModules.mjs';
import { slimSharedMemoryForPipelinePost } from '../slimSharedMemory';

/** iOS Safari kills the whole tab under memory pressure well before desktop browsers hit real limits. */
function isLikelyMobile() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isTouchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS reports as Mac
  return /iPhone|iPad|iPod|Android/.test(ua) || isTouchMac;
}

/**
 * On mobile, shrink the pipeline's own context-budget/max-tokens/timeout defaults
 * (the same LOCAL_LLM_LOW_SPEC=1 knob server/llmEnv.js already exposes) so each of
 * the many sequential WebGPU calls a full pipeline run makes stays smaller — less
 * sustained GPU memory pressure, directly reducing tab-crash risk on memory-
 * constrained devices. No-op on desktop (mobile crash reports were desktop-clean).
 */
function enableLowSpecOnMobile() {
  if (!isLikelyMobile()) return;
  if (typeof globalThis.process?.env === 'object') {
    globalThis.process.env.LOCAL_LLM_LOW_SPEC = '1';
  }
}
import { callLLM } from './browserCallLlm';

export async function runLocalPipelineWithMetacognitionContinuations({
  buildFetchInit,
  initialSlimSharedMemory = null,
  onEvent,
  maxLegs = 14,
  treatFirstLegAsContinuation = false,
  abortSignal,
}) {
  enableLowSpecOnMobile();
  let slimSm = initialSlimSharedMemory;
  let streamResult = null;

  for (let leg = 1; leg <= maxLegs; leg += 1) {
    if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

    streamResult = null;
    const pipelineMetacognitionContinuation =
      leg > 1 || (leg === 1 && treatFirstLegAsContinuation === true);
    const init = await buildFetchInit({ leg, slimSharedMemory: slimSm, pipelineMetacognitionContinuation });
    const body = JSON.parse(init.body);

    let continuation = null;
    let pausedEvt = null;
    await runPipeline({
      input: body.input,
      existingSharedMemory: body.sharedMemory,
      callLLM,
      options: body.options,
      onEvent: (evt) => {
        if (abortSignal?.aborted) return;
        onEvent?.(evt);
        if (evt.type === 'pipeline_continuation') continuation = evt;
        if (evt.type === 'complete') streamResult = evt;
        if (evt.type === 'paused') pausedEvt = evt;
      },
    });

    if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

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
        throw new Error('Supervisor continuation event is missing sharedMemory — cannot start the next local pipeline leg.');
      }
      slimSm = slimSharedMemoryForPipelinePost(continuation.sharedMemory, { continuation: true });
      continue;
    }
    throw new Error('Local pipeline run ended without a complete or pipeline_continuation event.');
  }

  throw new Error(`Pipeline exceeded ${maxLegs} metacognition continuation legs.`);
}
