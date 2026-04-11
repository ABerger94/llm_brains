import { normalizeModuleOutputsFromServer } from './cognitiveModules';

/**
 * Resolves final Voice text from an SSE `complete` event or JSON payload.
 * Empty string after trim means persistence should be skipped.
 */
export function resolvePipelineVoiceText({ voiceOutput, sharedMemory } = {}) {
  const top = String(voiceOutput ?? '').trim();
  if (top) return top;
  const raw = sharedMemory?.moduleOutputs || {};
  const norm = normalizeModuleOutputsFromServer(raw);
  const fromNorm = String(norm.voice ?? '').trim();
  if (fromNorm) return fromNorm;
  return String(raw.Voice ?? '').trim();
}
