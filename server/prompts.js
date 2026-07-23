import { MODULES, PIPELINE_LAYERS, PIPELINE_SCHEMA_VERSION } from '../shared/pipelineModules.mjs';

export { MODULES, PIPELINE_SCHEMA_VERSION };

/** Module names per stage, in strict server execution order (derived from MODULES). */
export const LAYERS = PIPELINE_LAYERS;

export function getModuleByName(name) {
  return MODULES.find((m) => m.name === name) || null;
}
