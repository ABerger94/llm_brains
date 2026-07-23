import { normalizeModuleOutputsFromServer } from './cognitiveModules';

/**
 * Resolves final Voice text from an SSE `complete` event or JSON payload.
 * Empty string after trim means persistence should be skipped.
 *
 * @param {{ voiceOutput?: unknown, sharedMemory?: { moduleOutputs?: Record<string, unknown> } }} [payload]
 * @param {Record<string, unknown>|null|undefined} [fallbackModuleOutputs] - UI-keyed graph store map (e.g. after
 *   mergeModuleOutputsPreferLonger from streamed `module_complete`) when `complete` slim payload omits Voice.
 */
export function resolvePipelineVoiceText(
  { voiceOutput, sharedMemory } = {},
  fallbackModuleOutputs
) {
  const top = String(voiceOutput ?? '').trim();
  if (top) return top;
  const raw = sharedMemory?.moduleOutputs || {};
  const norm = normalizeModuleOutputsFromServer(raw);
  const fromNorm = String(norm.voice ?? '').trim();
  if (fromNorm) return fromNorm;
  const fromRaw = String(raw.Voice ?? '').trim();
  if (fromRaw) return fromRaw;
  if (fallbackModuleOutputs && typeof fallbackModuleOutputs === 'object') {
    const fbNorm = normalizeModuleOutputsFromServer(fallbackModuleOutputs);
    const fromFb = String(fbNorm.voice ?? '').trim();
    if (fromFb) return fromFb;
    const directUi = String(fallbackModuleOutputs.voice ?? '').trim();
    if (directUi) return directUi;
  }
  return '';
}
