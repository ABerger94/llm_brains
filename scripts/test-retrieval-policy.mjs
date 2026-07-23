/**
 * Pure tests for retrieval blend weights, score filters, and adaptive temperature policy.
 */
import assert from 'node:assert/strict';
import {
  applyRetrievalScoreFilters,
  computeRetrievalBlendScore,
  resolveRecencyDecayPerDay,
  resolveRetrievalSemanticWeight,
  retrievalMinScoreEnabled,
} from '../server/retrievalPolicy.js';
import { resolveAdaptiveTemperature, resetAdaptiveTemperaturePolicyCache } from '../server/adaptiveTemperature.js';

const neutralSm = {
  originalInput: 'neutral test input for baseline',
  intent: '',
  phase: 'focus',
  interoception: {
    uncertaintyPressure: 0.35,
    curiosityPressure: 0.35,
    tensionPressure: 0.35,
    cognitiveLoad: 0.35,
  },
  epistemicFusion: { entropy: 0 },
  moduleOutputs: {},
};

{
  const a = resolveRetrievalSemanticWeight(neutralSm);
  assert.ok(Math.abs(a - 0.7) < 0.001, `neutral alpha should be ~0.7, got ${a}`);
}

{
  const s1 = computeRetrievalBlendScore(0.8, 0.5, 0.7);
  const s2 = computeRetrievalBlendScore(0.9, 0.5, 0.7);
  assert.ok(s2 > s1, 'higher semantic similarity should raise blended score holding recency fixed');
  const s3 = computeRetrievalBlendScore(0.8, 0.6, 0.7);
  assert.ok(s3 > s1, 'higher recency decay should raise blended score holding semantic fixed');
}

{
  const prev = process.env.RETRIEVAL_RECENCY_DECAY_PER_DAY;
  process.env.RETRIEVAL_RECENCY_DECAY_PER_DAY = '0.02';
  assert.equal(resolveRecencyDecayPerDay(), 0.02);
  delete process.env.RETRIEVAL_RECENCY_DECAY_PER_DAY;
  assert.equal(resolveRecencyDecayPerDay(), 0.02);
  if (prev !== undefined) process.env.RETRIEVAL_RECENCY_DECAY_PER_DAY = prev;
}

{
  const prevE = process.env.RETRIEVAL_MIN_SCORE_ENABLED;
  const prevD = process.env.RETRIEVAL_MIN_SCORE_DISABLED;
  const prevF = process.env.RETRIEVAL_SCORE_FLOOR_BASE;
  const prevK = process.env.RETRIEVAL_FLOOR_MIN_KEEP;
  delete process.env.RETRIEVAL_MIN_SCORE_DISABLED;
  delete process.env.RETRIEVAL_MIN_SCORE_ENABLED;
  process.env.RETRIEVAL_SCORE_FLOOR_BASE = '0.95';
  process.env.RETRIEVAL_FLOOR_MIN_KEEP = '2';

  assert.equal(retrievalMinScoreEnabled(), true, 'gates default on');

  const scored = [
    { item: 'best', score: 0.99 },
    { item: 'mid', score: 0.5 },
    { item: 'low', score: 0.1 },
  ];
  const sm = { epistemicFusion: { entropy: 0.5 }, interoception: { uncertaintyPressure: 0.4 } };
  const out = applyRetrievalScoreFilters(scored, sm, 10);
  assert.ok(out.length >= 2, 'min-keep should retain at least RETRIEVAL_FLOOR_MIN_KEEP items');
  assert.equal(out[0], 'best');

  if (prevE !== undefined) process.env.RETRIEVAL_MIN_SCORE_ENABLED = prevE;
  else delete process.env.RETRIEVAL_MIN_SCORE_ENABLED;
  if (prevD !== undefined) process.env.RETRIEVAL_MIN_SCORE_DISABLED = prevD;
  else delete process.env.RETRIEVAL_MIN_SCORE_DISABLED;
  if (prevF !== undefined) process.env.RETRIEVAL_SCORE_FLOOR_BASE = prevF;
  else delete process.env.RETRIEVAL_SCORE_FLOOR_BASE;
  if (prevK !== undefined) process.env.RETRIEVAL_FLOOR_MIN_KEEP = prevK;
  else delete process.env.RETRIEVAL_FLOOR_MIN_KEEP;
}

{
  const prevD = process.env.RETRIEVAL_MIN_SCORE_DISABLED;
  process.env.RETRIEVAL_MIN_SCORE_DISABLED = '1';
  assert.equal(retrievalMinScoreEnabled(), false);
  if (prevD !== undefined) process.env.RETRIEVAL_MIN_SCORE_DISABLED = prevD;
  else delete process.env.RETRIEVAL_MIN_SCORE_DISABLED;
}

{
  const prevCrit = process.env.ADAPTIVE_TEMP_CRITICAL_MODULES;
  const prevCap = process.env.ADAPTIVE_TEMP_CRITICAL_CAP;
  resetAdaptiveTemperaturePolicyCache();
  process.env.ADAPTIVE_TEMP_CRITICAL_MODULES = 'Integration';
  process.env.ADAPTIVE_TEMP_CRITICAL_CAP = '0.4';
  const sm = {
    ...neutralSm,
    phaseEffective: 'focus',
    interoception: { uncertaintyPressure: 0.95, curiosityPressure: 0.9, tensionPressure: 0.5, cognitiveLoad: 0.2 },
  };
  const high = resolveAdaptiveTemperature(sm, { temperature: 0.55 }, 'Attention');
  const capped = resolveAdaptiveTemperature(sm, { temperature: 0.55 }, 'Integration');
  assert.ok(capped <= 0.4, `critical module should cap temp, got ${capped}`);
  assert.ok(high > capped || high >= 0.7, 'non-critical module should be hotter than capped critical');
  if (prevCrit !== undefined) process.env.ADAPTIVE_TEMP_CRITICAL_MODULES = prevCrit;
  else delete process.env.ADAPTIVE_TEMP_CRITICAL_MODULES;
  if (prevCap !== undefined) process.env.ADAPTIVE_TEMP_CRITICAL_CAP = prevCap;
  else delete process.env.ADAPTIVE_TEMP_CRITICAL_CAP;
  resetAdaptiveTemperaturePolicyCache();
}

{
  const sm = {
    ...neutralSm,
    interoception: { uncertaintyPressure: 0.35, curiosityPressure: 0.35, tensionPressure: 0.35, cognitiveLoad: 0.35 },
  };
  const t = resolveAdaptiveTemperature(sm, { temperature: 0.55, minAdaptiveTemp: 0.5, maxAdaptiveTemp: 0.52 });
  assert.ok(t >= 0.5 && t <= 0.52, `min/max clamp expected, got ${t}`);
}

console.log('test-retrieval-policy: ok');
