/**
 * Which engine actually runs the pipeline: the Express backend (LM Studio/HF/
 * OpenRouter, over SSE) or a model loaded directly into this browser via
 * WebGPU (server/pipeline.js running in-process — see localPipelineRunner.js).
 *
 * Kept as its own small KV entry rather than folded into runtimeSettings.js's
 * large settings blob — this is an execution-transport switch, not a mind/
 * pipeline behavior setting, and doesn't need that file's merge/normalize
 * machinery.
 */
import { getKvSync, setKvSync } from '../browserStorage';

const STORAGE_KEY = 'mybrain_pipeline_execution_backend';

export const EXECUTION_BACKEND_SERVER = 'server';
export const EXECUTION_BACKEND_BROWSER = 'browser';

/** @returns {'server' | 'browser'} */
export function getPipelineExecutionBackend() {
  // No Express backend exists on the backend-free Vercel build — always browser there.
  if (import.meta.env.VITE_BROWSER_ONLY === '1') return EXECUTION_BACKEND_BROWSER;
  const raw = getKvSync(STORAGE_KEY);
  return raw === EXECUTION_BACKEND_BROWSER ? EXECUTION_BACKEND_BROWSER : EXECUTION_BACKEND_SERVER;
}

export function setPipelineExecutionBackend(backend) {
  setKvSync(STORAGE_KEY, backend === EXECUTION_BACKEND_BROWSER ? EXECUTION_BACKEND_BROWSER : EXECUTION_BACKEND_SERVER);
}
