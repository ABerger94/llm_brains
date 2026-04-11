import { getRuntimeSettings } from './runtimeSettings';

/** OpenRouter key from Settings (IndexedDB KV); never send empty string. */
export function getOpenrouterApiKeyForRequests() {
  try {
    const k = getRuntimeSettings().openrouterApiKey;
    return typeof k === 'string' ? k.trim() : '';
  } catch {
    return '';
  }
}

/** Top-level fields for POST /api/llm/text, /json, /text-stream. */
export function openrouterRequestFields() {
  const openrouterApiKey = getOpenrouterApiKeyForRequests();
  return openrouterApiKey ? { openrouterApiKey } : {};
}

/**
 * Merge into pipeline `options` for POST /api/pipeline/stream.
 * @param {object} [runtimeSettings] - defaults to current getRuntimeSettings()
 */
export function openrouterPipelineOptions(runtimeSettings) {
  const rt = runtimeSettings || getRuntimeSettings();
  const k = typeof rt?.openrouterApiKey === 'string' ? rt.openrouterApiKey.trim() : '';
  return k ? { openrouterApiKey: k } : {};
}
