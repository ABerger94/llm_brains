/**
 * In-browser mirror of pipelineSse.js's consumePipelineSseWithMetacognitionContinuations,
 * with the exact same call signature and multi-leg continuation looping — but instead of
 * POSTing to /api/pipeline/stream per leg, it calls server/pipeline.js's runPipeline()
 * in-process, with callLLM backed by an in-browser WebGPU model (browserCallLlm.js)
 * instead of Express's LM Studio/HF/OpenRouter providers.
 *
 * runPipeline's onEvent already emits the exact event shapes the SSE path relays
 * verbatim (server/index.js just forwards them over the wire via sseSend) — so
 * consciousnessStreamRunner.js's onEvent handler needs zero changes to consume this.
 *
 * Only buildable in the browser-only build: this imports server/pipeline.js, which
 * only resolves cleanly once vite.config.js's browser-only aliases are active (see
 * browserOnlyPipelineAliases()). Callers must not import this module in the normal
 * (server-backed) build path.
 */
import './processPolyfill';
import { runPipeline } from '../../../server/pipeline.js';
import { PIPELINE_SCHEMA_VERSION } from '../../../shared/pipelineModules.mjs';
import { slimSharedMemoryForPipelinePost } from '../slimSharedMemory';
import { callLLM } from './browserCallLlm';

export async function runLocalPipelineWithMetacognitionContinuations({
  buildFetchInit,
  initialSlimSharedMemory = null,
  onEvent,
  maxLegs = 14,
  treatFirstLegAsContinuation = false,
  abortSignal,
}) {
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
