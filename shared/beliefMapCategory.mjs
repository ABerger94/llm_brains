/** Belief Map UI categories (distinct from world-model categories). */
export const BELIEF_MAP_CATEGORY_ORDER = [
  'factual',
  'normative',
  'self',
  'causal',
  'predictive',
];

const CANON = new Set(BELIEF_MAP_CATEGORY_ORDER);

/**
 * @param {unknown} value
 * @returns {typeof BELIEF_MAP_CATEGORY_ORDER[number] | null}
 */
export function normalizeBeliefMapCategory(value) {
  const k = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (!k) return null;
  return CANON.has(k) ? /** @type {typeof BELIEF_MAP_CATEGORY_ORDER[number]} */ (k) : null;
}
