/**
 * Epistemic fusion unit checks (no network).
 */
import assert from 'node:assert/strict';
import {
  fuseEpistemicPosterior,
  applyEpistemicFusionToSharedMemory,
  buildHypothesisPrior,
  lexicalJaccard,
  slimEpistemicFusion,
  EPISTEMIC_FUSION_VERSION,
} from '../shared/epistemicFusion.mjs';

function approxEqual(a, b, eps = 1e-5) {
  return Math.abs(a - b) < eps;
}

// lexicalJaccard
assert.ok(lexicalJaccard('hello world', 'world hello') > 0.4);
assert.ok(lexicalJaccard('aaa', 'bbb') === 0);

// Prior: id match bumps mass
const cur = [{ id: 'h1', label: 'A', weight: 0.5 }];
const prior = [{ id: 'h1', label: 'old', weight: 0.8 }];
const { prior: p0, priorSource } = buildHypothesisPrior(cur, prior, 0.88);
assert.equal(priorSource, 'prior_turn');
assert.ok(p0[0] > 0.5);

// Full fusion minimal
const sm = {
  globalWorkspace: {
    hypotheses: [
      { id: 'h1', label: 'user wants help with code', weight: 0.6 },
      { id: 'h2', label: 'user is testing the system', weight: 0.4 },
    ],
    conflicts: [],
    integrationConfidence: 0.7,
    phenomenalUnity: 'unified',
  },
  hypothesisPortfolio: {
    hypotheses: [
      { id: 'h1', label: 'x', weight: 0.7 },
      { id: 'h2', label: 'y', weight: 0.3 },
    ],
  },
  userStancePrediction: { expectUserWants: 'help with my code project', confidence: 0.6 },
  surpriseAssessment: { score: 0.1, note: '' },
  contradictions: [],
  beliefTensions: [],
  clientBeliefDigest: [],
  beliefStore: [],
  priorTurnGlobalWorkspace: null,
};

const fused = fuseEpistemicPosterior(sm, { priorHypothesisDecay: 0.88 });
assert.ok(fused);
assert.equal(fused.version, EPISTEMIC_FUSION_VERSION);
assert.equal(fused.posterior.length, 2);
assert.ok(approxEqual(fused.posterior.reduce((a, b) => a + b, 0), 1, 1e-4));
// Stance overlaps h1 more — should favor h1
assert.ok(fused.posterior[0] > fused.posterior[1]);

// Surprise flattening: high surprise → closer to uniform
const smFlat = {
  ...sm,
  surpriseAssessment: { score: 0.95, note: 'wow' },
};
const fusedHighSur = fuseEpistemicPosterior(smFlat, { priorHypothesisDecay: 0.88 });
const entBase = fused.entropy;
const entHigh = fusedHighSur.entropy;
assert.ok(entHigh >= entBase - 0.01);

// Stance gated off when no overlap
const smNoStance = {
  ...sm,
  userStancePrediction: { expectUserWants: 'zzzzzz', confidence: 0.5 },
};
const fusedNo = fuseEpistemicPosterior(smNoStance, { priorHypothesisDecay: 0.88 });
assert.equal(fusedNo.factorsMeta.stanceApplied, false);

// applyEpistemicFusionToSharedMemory adds fusedWeight
const sm2 = JSON.parse(JSON.stringify(sm));
applyEpistemicFusionToSharedMemory(sm2, { priorHypothesisDecay: 0.88 });
assert.ok(sm2.globalWorkspace.hypotheses[0].fusedWeight != null);
assert.ok(approxEqual(sm2.globalWorkspace.hypotheses[0].fusedWeight + sm2.globalWorkspace.hypotheses[1].fusedWeight, 1, 1e-3));

// slimEpistemicFusion
const slim = slimEpistemicFusion(sm2.epistemicFusion);
assert.ok(slim);
assert.ok(slim.posterior.length <= 8);
assert.equal(slim.version, EPISTEMIC_FUSION_VERSION);

console.log('test-epistemic-fusion: ok');
