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
 *
 * A full pipeline run makes many sequential calls through here (11 modules,
 * worst case ~2 full metacognition reruns plus chunked module calls) — the
 * same call volume that crashed the llm_brains sibling project's browser
 * tab on mobile before it added resetChat()-between-calls and a yield after
 * every call (see its git history: "Fix PWA/browser crashes"). Same fix
 * here: each unrelated single-turn module call shouldn't accumulate KV-cache
 * state, and the main thread needs a moment to breathe/GC between heavy
 * WebGPU calls instead of running back-to-back.
 */
import { getLoadedEngine, getLoadedModelId, runStage, unloadEngine } from '../browserLlmEngine';

function isDeviceLostError(e) {
  const message = e instanceof Error ? e.message : String(e);
  return /device|context lost|gpu/i.test(message);
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

  let text;
  try {
    text = await runStage(engine, systemPrompt, userContent, {
      temperature: options.temperature,
      maxTokens: options.max_tokens ?? options.maxTokens,
      signal: options.signal,
    });
  } catch (e) {
    if (isDeviceLostError(e)) {
      // The GPU context is gone — nothing further will run on this engine. Reset so
      // the next pipeline attempt (or "Reload model") starts clean instead of hanging
      // on a dead engine, and surface a clear reason instead of web-llm's raw error.
      unloadEngine();
      const err = new Error(
        `The GPU context was lost mid-run (${e instanceof Error ? e.message : String(e)}). This can happen under sustained load on some devices — reload the model and try again, or switch to the "Local server" execution backend on this device.`
      );
      err.failures = [];
      throw err;
    }
    throw e;
  }

  // Each module call is a fresh, unrelated single-turn prompt — clear the engine's
  // internal conversation/KV-cache state between calls rather than letting it
  // accumulate across a full run's worth of sequential generations.
  try {
    await engine.resetChat();
  } catch {
    // non-fatal: not every backend/build supports this.
  }
  await yieldToBrowser();

  return {
    text,
    provider: 'browser-webgpu',
    model: getLoadedModelId() || 'unknown',
    partialDueToSoftTimeout: false,
  };
}
