/**
 * Retrieval ranking policy: semantic vs recency blend, score floors/margins (on by default).
 * Used by applyProbabilisticMemoryRetrieval in mindPolicy.js.
 */

import { getThreshold } from './thresholdStore.js';

function parseEnvFloat(key, defaultValue) {
  const raw = String(process.env[key] ?? '').trim();
  if (!raw) return defaultValue;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseEnvInt(key, defaultValue) {
  const raw = String(process.env[key] ?? '').trim();
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

/**
 * Per-day exponent for recency decay: exp(-ageDays * rate). Default 0.02 matches prior hardcoded behavior.
 * @returns {number}
 */
export function resolveRecencyDecayPerDay() {
  const v = parseEnvFloat('RETRIEVAL_RECENCY_DECAY_PER_DAY', 0.02);
  return v > 0 ? v : 0.02;
}

/**
 * Blend semantic similarity [0,1] and recency decay [0,1] with weight alpha on semantic.
 * @param {number} semanticSim
 * @param {number} recencyDecay
 * @param {number} alpha
 * @returns {number}
 */
export function computeRetrievalBlendScore(semanticSim, recencyDecay, alpha) {
  const a = typeof alpha === 'number' && Number.isFinite(alpha) ? alpha : 0.7;
  const s = Math.max(0, Math.min(1, Number(semanticSim) || 0));
  const r = Math.max(0, Math.min(1, Number(recencyDecay) || 0));
  return s * a + r * (1 - a);
}

/**
 * Context-dependent semantic weight for memory digest reranking.
 * Neutral interoception and no keyword hints → base (~0.7), matching legacy 0.7/0.3 split.
 * @param {object} sharedMemory
 * @returns {number}
 */
export function resolveRetrievalSemanticWeight(sharedMemory) {
  const base = parseEnvFloat('RETRIEVAL_SEMANTIC_WEIGHT_BASE', 0.7);
  const minA = parseEnvFloat('RETRIEVAL_SEMANTIC_WEIGHT_MIN', 0.15);
  const maxA = parseEnvFloat('RETRIEVAL_SEMANTIC_WEIGHT_MAX', 0.95);
  let a = base;

  const intr = sharedMemory?.interoception || {};
  const up = typeof intr.uncertaintyPressure === 'number' ? intr.uncertaintyPressure : 0.35;
  const ef = sharedMemory?.epistemicFusion;
  const ent = ef && typeof ef === 'object' && typeof ef.entropy === 'number' ? ef.entropy : 0;
  const entropyHigh = getThreshold('epistemic_entropy_high', 0.9);

  if (up > 0.5) {
    a += (up - 0.5) * 0.2;
  }
  if (ent > entropyHigh) {
    a += Math.min(0.12, (ent - entropyHigh) * 0.4);
  }

  const corpus = `${String(sharedMemory?.originalInput ?? '')} ${String(sharedMemory?.intent ?? '')}`.toLowerCase();
  if (/\b(remember|recall|what did i|last time we|earlier i)\b/i.test(corpus)) {
    a += 0.08;
  }
  if (/\b(yesterday|last week|today|recently|just now|this morning)\b/i.test(corpus)) {
    a -= 0.1;
  }

  const att = String(sharedMemory?.moduleOutputs?.Attention ?? '').trim();
  const inp = String(sharedMemory?.originalInput ?? '').trim();
  if (att.length > 200 && inp.length > 0 && inp.length < 80) {
    a -= 0.08;
  }

  return Math.round(Math.min(maxA, Math.max(minA, a)) * 1000) / 1000;
}

/**
 * Whether floor/margin gates run after ranking (default: true).
 * Opt out: RETRIEVAL_MIN_SCORE_DISABLED=1 or RETRIEVAL_MIN_SCORE_ENABLED=0|false|no|off.
 * @returns {boolean}
 */
export function retrievalMinScoreEnabled() {
  const dis = String(process.env.RETRIEVAL_MIN_SCORE_DISABLED || '').trim().toLowerCase();
  if (dis === '1' || dis === 'true' || dis === 'yes') return false;

  const en = String(process.env.RETRIEVAL_MIN_SCORE_ENABLED ?? '').trim().toLowerCase();
  if (en === '0' || en === 'false' || en === 'no' || en === 'off') return false;
  if (en === '1' || en === 'true' || en === 'yes') return true;
  return true;
}

/**
 * Dynamic minimum blended score to keep an item (when retrieval gates are enabled).
 * Rises with epistemic entropy and uncertainty so weak matches drop under noisy states.
 * @param {object} sharedMemory
 * @returns {number}
 */
export function resolveRetrievalScoreFloor(sharedMemory) {
  if (!retrievalMinScoreEnabled()) return 0;

  let base = parseEnvFloat('RETRIEVAL_SCORE_FLOOR_BASE', 0.22);
  const ef = sharedMemory?.epistemicFusion;
  const ent = ef && typeof ef === 'object' && typeof ef.entropy === 'number' ? ef.entropy : 0;
  const intr = sharedMemory?.interoception || {};
  const up = typeof intr.uncertaintyPressure === 'number' ? intr.uncertaintyPressure : 0.35;

  if (ent > 0.75) {
    base += Math.min(0.2, (ent - 0.75) * 0.35);
  }
  if (up > 0.55) {
    base += (up - 0.55) * 0.15;
  }

  const calibrated = getThreshold('memory_score_floor', base);
  const floor = typeof calibrated === 'number' && Number.isFinite(calibrated) ? calibrated : base;
  return Math.round(Math.min(0.95, Math.max(0, floor)) * 1000) / 1000;
}

/**
 * Score margin below the best item; kept only if score >= best - margin (when min-score mode on).
 * @param {object} sharedMemory
 * @returns {number|null} null when min-score mode off
 */
export function resolveRetrievalScoreMargin(sharedMemory) {
  if (!retrievalMinScoreEnabled()) return null;

  let m = getThreshold('memory_score_margin', 0.12);
  if (typeof m !== 'number' || !Number.isFinite(m)) {
    m = 0.12;
  }
  const ef = sharedMemory?.epistemicFusion;
  const ent = ef && typeof ef === 'object' && typeof ef.entropy === 'number' ? ef.entropy : 0;
  if (ent > 0.85) {
    m += 0.05;
  }
  return Math.round(Math.min(0.5, Math.max(0.02, m)) * 1000) / 1000;
}

/**
 * Apply floor and margin; always keep at least minKeep items from the score-sorted list.
 * @param {Array<{ item: unknown, score: number }>} scoredSortedDesc
 * @param {object} sharedMemory
 * @param {number} maxItems
 * @returns {unknown[]}
 */
export function applyRetrievalScoreFilters(scoredSortedDesc, sharedMemory, maxItems) {
  if (!retrievalMinScoreEnabled()) {
    return scoredSortedDesc.slice(0, maxItems).map((x) => x.item);
  }

  const floor = resolveRetrievalScoreFloor(sharedMemory);
  const margin = resolveRetrievalScoreMargin(sharedMemory) ?? 0.12;
  const minKeep = Math.min(
    scoredSortedDesc.length,
    Math.max(1, parseEnvInt('RETRIEVAL_FLOOR_MIN_KEEP', 3))
  );

  const best = scoredSortedDesc.length ? scoredSortedDesc[0].score : 0;
  const threshold = Math.max(floor, best - margin);

  let kept = scoredSortedDesc.filter((s) => s.score >= threshold);
  if (kept.length < minKeep) {
    kept = scoredSortedDesc.slice(0, minKeep);
  }

  return kept.slice(0, maxItems).map((x) => x.item);
}
