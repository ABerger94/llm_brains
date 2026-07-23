import { MODULES, PIPELINE_LAYER_KEYS, PIPELINE_LAYERS, PIPELINE_SCHEMA_VERSION } from './pipelineModules.mjs';

/**
 * Flatten canonical pipeline order (matches {@link runPipeline} forward path without metacognition surprises).
 * Used to compute "resume at next module" after each module completes.
 */
export function getFlatPipelineModuleNames() {
  const out = [];
  for (const lk of PIPELINE_LAYER_KEYS) {
    const row = PIPELINE_LAYERS[lk];
    if (Array.isArray(row)) {
      for (const name of row) out.push(name);
    }
  }
  return out;
}

const FLAT = getFlatPipelineModuleNames();

/**
 * @param {string} completedModuleName
 * @returns {{ v: number, phase: string, nextModuleName: string } | null}
 *   `null` after Voice (nothing left to run).
 */
export function getIncrementalCheckpointCursorAfter(completedModuleName) {
  const name = String(completedModuleName || '').trim();
  if (!name) return null;
  const i = FLAT.indexOf(name);
  if (i === -1) return null;
  const next = FLAT[i + 1];
  if (!next) return null;
  const layer = MODULES.find((m) => m.name === next)?.layer;
  const phase =
    layer === 'layer5' ? 'layer5' : layer === 'layer6' ? 'layer6' : 'layer14';
  return { v: PIPELINE_SCHEMA_VERSION, phase, nextModuleName: next };
}
