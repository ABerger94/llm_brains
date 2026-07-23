/**
 * callLLM(systemPrompt, userContent, options) adapter matching server/index.js's
 * `callLLM` contract exactly (same argument shape, same
 * { text, provider, model, partialDueToSoftTimeout } return shape) so
 * server/pipeline.js's injected-callLLM seam works unmodified whether it's
 * running server-side against LM Studio/HF/OpenRouter or, here, against a
 * model already loaded into the browser via browserLlmEngine.js.
 *
 * Routing-only fields on `options` (openrouterApiKey, llmRoute,
 * onlyProviderId, onlyModel, timeoutMs) are meaningless with a single
 * already-loaded local engine and are ignored.
 */
import { getLoadedEngine, getLoadedModelId, runStage } from '../browserLlmEngine';

export async function callLLM(systemPrompt, userContent, options = {}) {
  const enginePromise = getLoadedEngine();
  if (!enginePromise) {
    const err = new Error(
      'No in-browser model is loaded. Load a model under Settings -> LLM execution before running the pipeline.'
    );
    err.failures = [];
    throw err;
  }
  const engine = await enginePromise;

  const text = await runStage(engine, systemPrompt, userContent, {
    temperature: options.temperature,
    maxTokens: options.max_tokens ?? options.maxTokens,
    signal: options.signal,
  });

  return {
    text,
    provider: 'browser-webgpu',
    model: getLoadedModelId() || 'unknown',
    partialDueToSoftTimeout: false,
  };
}
