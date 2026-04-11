/**
 * Adaptive temperature: derives LLM sampling temperature from interoception state,
 * cognitive phase, and module context. Creates a feedback loop where the system's
 * own felt uncertainty modulates how exploratory its next generation is.
 */

function adaptiveTemperatureDisabled() {
  const v = String(process.env.ADAPTIVE_TEMPERATURE_DISABLED || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

const MODULE_FIXED_TEMPS = new Set([
  '__map_ingest',
  '__merge_reasoning',
  '__chunked_reduce',
]);

/**
 * Resolve adaptive temperature from shared memory interoception.
 * @param {object} sharedMemory
 * @param {{ temperature?: number, _fixedTemp?: boolean }} [moduleDefaults]
 * @returns {number}
 */
export function resolveAdaptiveTemperature(sharedMemory, moduleDefaults = {}) {
  const base = moduleDefaults.temperature ?? 0.55;

  if (adaptiveTemperatureDisabled() || moduleDefaults._fixedTemp) {
    return base;
  }

  const intr = sharedMemory?.interoception || {};
  const up = typeof intr.uncertaintyPressure === 'number' ? intr.uncertaintyPressure : 0.35;
  const cp = typeof intr.curiosityPressure === 'number' ? intr.curiosityPressure : 0.35;
  const tp = typeof intr.tensionPressure === 'number' ? intr.tensionPressure : 0.35;
  const cl = typeof intr.cognitiveLoad === 'number' ? intr.cognitiveLoad : 0.35;
  const phase = sharedMemory?.phaseEffective || sharedMemory?.phase || 'focus';

  let t = base;

  t += (up - 0.35) * 0.25;
  t += (cp - 0.35) * 0.15;
  t += (tp - 0.35) * 0.10;

  if (cl > 0.6) t -= (cl - 0.6) * 0.08;

  switch (phase) {
    case 'drift':
      t += 0.08;
      break;
    case 'sleep':
      t -= 0.05;
      break;
    case 'wake':
      t -= 0.02;
      break;
  }

  return Math.round(Math.min(1.2, Math.max(0.15, t)) * 100) / 100;
}

/**
 * Check if a module's callOpts should use adaptive temperature.
 * Returns false for internal merge/reduce calls that need fixed low temps.
 */
export function shouldAdaptTemperature(moduleName, callOpts) {
  if (callOpts?._fixedTemp) return false;
  if (MODULE_FIXED_TEMPS.has(moduleName)) return false;
  return true;
}
