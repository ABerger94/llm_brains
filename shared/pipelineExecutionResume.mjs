import { MODULES, PIPELINE_LAYERS as LAYERS, PIPELINE_SCHEMA_VERSION } from './pipelineModules.mjs';

const VALID_PIPELINE_MODULE_NAMES = new Set(MODULES.map((m) => m.name));

/** Legacy v1 cursors (23-module pipeline) are invalid after schema v2 — resume from scratch. */
export { PIPELINE_SCHEMA_VERSION };

/**
 * Client/server shared validation for POST options.executionResume (must match server pipeline).
 * @param {object|null|undefined} er
 * @returns {{ v: number, phase: 'layer14'|'layer5'|'layer6', nextModuleName: string } | null}
 */
export function normalizeExecutionResume(er) {
  if (!er || typeof er !== 'object') return null;
  const v = Number(er.v);
  if (v !== PIPELINE_SCHEMA_VERSION) return null;
  const phase = String(er.phase || '').trim();
  const nextModuleName = String(er.nextModuleName || '').trim();
  if (!nextModuleName || !VALID_PIPELINE_MODULE_NAMES.has(nextModuleName)) return null;
  if (phase !== 'layer14' && phase !== 'layer5' && phase !== 'layer6') return null;
  if (phase === 'layer5' && !LAYERS.layer5.includes(nextModuleName)) return null;
  if (phase === 'layer6' && !LAYERS.layer6.includes(nextModuleName)) return null;
  if (phase === 'layer14') {
    const ok = ['layer1', 'layer2', 'layer3', 'layer4'].some((lk) => LAYERS[lk].includes(nextModuleName));
    if (!ok) return null;
  }
  return { v: PIPELINE_SCHEMA_VERSION, phase, nextModuleName };
}
