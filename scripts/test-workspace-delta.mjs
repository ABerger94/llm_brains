/**
 * Deterministic workspace delta (prior carryover vs current globalWorkspace).
 */
import assert from 'node:assert';
import { computeWorkspaceDelta } from '../server/workspaceDelta.js';

const prior = {
  provisionalStance: 'We focused on morning routines and coffee habits last time.',
  phenomenalUnity: 'unified',
  conflictsPreview: ['tension about sleep vs caffeine'],
  openQuestionsPreview: ['Will the user keep the same schedule?'],
  hypotheses: [{ id: 'h1', label: 'Stable habit', weight: 0.6 }],
};

const current = {
  provisionalStance: 'Today we shift to evening wind-down; coffee is background only.',
  phenomenalUnity: 'partial',
  conflicts: ['tension about sleep vs caffeine'],
  openQuestions: ['What boundary should apply tonight?'],
  hypotheses: [{ id: 'h1', label: 'Stable habit', weight: 0.42 }],
};

const d = computeWorkspaceDelta(prior, current);
assert.ok(d && typeof d === 'object');
assert.ok(Array.isArray(d.bullets) && d.bullets.length >= 1);
assert.ok(typeof d.stanceOverlapApprox === 'number');

const d0 = computeWorkspaceDelta(null, current);
assert.ok(d0 && d0.note === 'no_prior_workspace_snapshot');

console.log('test-workspace-delta: ok');
