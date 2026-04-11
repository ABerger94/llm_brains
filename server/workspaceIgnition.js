/**
 * Deterministic post-Integration scaffold: ranks workspace topics and surfaces conflict pressure.
 * Not a second Integration pass — numeric/structural tie-break for downstream context only.
 */

import { getThreshold } from './thresholdStore.js';

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {object} sharedMemory
 * @returns {object|null} JSON-safe object or null when nothing to add
 */
export function computeWorkspaceIgnition(sharedMemory) {
  const gw = sharedMemory?.globalWorkspace;
  if (!gw || typeof gw !== 'object') return null;

  const rankedTopics = [];
  const seen = new Set();
  const pushTopic = (s) => {
    const t = String(s || '').trim().slice(0, 220);
    if (!t || seen.has(t)) return;
    seen.add(t);
    rankedTopics.push(t);
  };

  for (const s of ensureArray(gw.broadcastWinners)) pushTopic(s);
  for (const s of ensureArray(gw.salience)) pushTopic(s);
  if (rankedTopics.length < 4) {
    for (const s of ensureArray(gw.openQuestions)) pushTopic(s);
  }

  let dominantHypothesisId = null;
  let bestW = -1;
  const hyps = ensureArray(gw.hypotheses);
  for (const h of hyps) {
    if (!h || typeof h !== 'object') continue;
    const wf = Number(h.fusedWeight);
    const w = Number.isFinite(wf) ? wf : Number(h.weight);
    if (!Number.isFinite(w)) continue;
    if (w > bestW) {
      bestW = w;
      const id = String(h.id || '').trim().slice(0, 32);
      dominantHypothesisId = id || null;
    }
  }

  const conflicts = ensureArray(gw.conflicts);
  const split = String(gw.phenomenalUnity || '').toLowerCase() === 'split';
  let conflictPressure = Math.min(1, conflicts.length / 4);
  if (split) conflictPressure = Math.max(conflictPressure, 0.55);
  const ic = Number(gw.integrationConfidence);
  const icLowThreshold = getThreshold('integration_confidence_low', 0.5);
  if (Number.isFinite(ic) && ic < icLowThreshold) conflictPressure = Math.max(conflictPressure, 0.45);

  const ef = sharedMemory?.epistemicFusion;
  const ent = ef && typeof ef === 'object' && Number.isFinite(Number(ef.entropy)) ? Number(ef.entropy) : null;
  const entropyHighThreshold = getThreshold('epistemic_entropy_high', 0.9);
  if (ent != null && ent > entropyHighThreshold) {
    conflictPressure = Math.max(conflictPressure, Math.min(0.85, 0.35 + (ent - entropyHighThreshold) * 2));
  }

  const notes = [];
  if (split) notes.push('unity_split');
  if (conflicts.length >= 2) notes.push('multi_conflict');
  if (Number.isFinite(ic) && ic < getThreshold('integration_confidence_note', 0.4)) notes.push('low_integration_confidence');
  if (ent != null && ent > getThreshold('epistemic_entropy_note', 1.0)) notes.push('high_hypothesis_entropy');

  const hasSignal =
    rankedTopics.length > 0 ||
    dominantHypothesisId != null ||
    conflictPressure >= 0.08 ||
    notes.length > 0;
  if (!hasSignal) return null;

  return {
    rankedTopics: rankedTopics.slice(0, 8),
    ...(dominantHypothesisId ? { dominantHypothesisId } : {}),
    conflictPressure: Math.round(conflictPressure * 100) / 100,
    notes: notes.slice(0, 6),
  };
}
