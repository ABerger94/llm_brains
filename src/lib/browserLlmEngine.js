/**
 * Thin wrapper around @mlc-ai/web-llm, ported from the llm_brains sibling
 * project. Everything here runs entirely in the browser: the model weights
 * are fetched once from Hugging Face, compiled with WebGPU, and cached by
 * the browser's Cache API for subsequent visits (including when installed
 * as a PWA).
 */

// Model ids match @mlc-ai/web-llm's prebuilt config (prebuiltAppConfig).
export const AVAILABLE_MODELS = [
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 1B Instruct',
    approxSizeMB: 880,
    description: 'Fastest, smallest download. Good default for phones.',
  },
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5 1.5B Instruct',
    approxSizeMB: 1130,
    description: 'Small and strong at structured, terse reasoning.',
  },
  {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 3B Instruct',
    approxSizeMB: 2100,
    description: 'Best quality of the three, larger download.',
    riskyOnMobile: true,
  },
];

let enginePromise = null;
let loadedModelId = null;

export function isWebGPUAvailable() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export async function loadEngine(modelId, onProgress) {
  const webllm = await import('@mlc-ai/web-llm');

  if (loadedModelId && loadedModelId !== modelId && enginePromise) {
    const existing = await enginePromise;
    await existing.unload();
    enginePromise = null;
    loadedModelId = null;
  }

  if (!enginePromise) {
    loadedModelId = modelId;
    enginePromise = webllm.CreateMLCEngine(modelId, {
      initProgressCallback: onProgress,
    });
  }

  return enginePromise;
}

export function unloadEngine() {
  if (enginePromise) {
    enginePromise.then((e) => e.unload()).catch(() => {});
  }
  enginePromise = null;
  loadedModelId = null;
}

/**
 * Runs one chained prompt stage against an already-loaded engine, streaming tokens.
 * @param {import('@mlc-ai/web-llm').MLCEngineInterface} engine
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {{ temperature?: number, maxTokens?: number, onToken?: (fullTextSoFar: string) => void, signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export async function runStage(engine, systemPrompt, userPrompt, options = {}) {
  const stream = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 120,
    stream: true,
  });

  let full = '';
  for await (const chunk of stream) {
    if (options.signal?.aborted) break;
    const delta = chunk.choices?.[0]?.delta?.content ?? '';
    if (delta) {
      full += delta;
      options.onToken?.(full);
    }
  }
  return full.trim();
}
