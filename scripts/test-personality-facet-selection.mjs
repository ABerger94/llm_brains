/**
 * Pure tests for adaptive personality facet ranking / trimming (no live LLM).
 */
import assert from 'node:assert/strict';
import {
  normalizePersonalityProfile,
  personalityProfileBlock,
  rankFacetsForContext,
} from '../server/mindPolicy.js';

const sm = {
  originalInput: 'I love typescript programming every day',
  phase: 'focus',
  arousal: 0.5,
  constitution: '',
  intent: '',
  moduleOutputs: { Attention: 'SALIENT: typescript and daily coding habits' },
  personalityProfile: {
    version: 1,
    facets: [
      {
        id: 'irrel',
        label: 'avocado enthusiast',
        strength: 0.95,
        confidence: 0.95,
        evidence: 'always talks guacamole',
        trigger: 'user_content',
      },
      {
        id: 'relevant',
        label: 'typescript cadence',
        strength: 0.45,
        confidence: 0.45,
        evidence: 'mentions types and daily coding',
        trigger: 'user_content',
      },
    ],
    relationalStance: null,
    systemTreatmentNotes: '',
  },
};

{
  const o = normalizePersonalityProfile(sm.personalityProfile);
  const order = rankFacetsForContext(sm, o.facets, 'Voice').map((f) => f.id);
  assert.deepEqual(order, ['relevant', 'irrel'], 'context-relevant facet should rank first');
}

{
  const block = personalityProfileBlock(sm, 420, 'Voice');
  assert.match(block, /"id":"relevant"/, 'under tight budget, keep higher-ranked facet');
  assert.doesNotMatch(block, /"id":"irrel"/, 'drop lower-ranked facet before the other');
}

console.log('test-personality-facet-selection: ok');
