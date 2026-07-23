/**
 * Deterministic cross-turn delta between prior carryover snapshot and current globalWorkspace.
 * No LLM calls — cheap token overlap and set comparisons only.
 */

import { clipTextComplete } from '../shared/textClip.mjs';

const SIGNIFICANT_TOKEN = /\b[a-z]{4,}\b/gi;

/** @param {string} s */
function tokenSet(s) {
  const m = String(s).toLowerCase().match(SIGNIFICANT_TOKEN);
  if (!m) return new Set();
  return new Set(m);
}

/** @param {Set<string>} a @param {Set<string>} b */
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** @param {string[]} arr */
function normLines(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {object|null|undefined} prior
 * @param {object|null|undefined} current
 * @returns {object|null}
 */
export function computeWorkspaceDelta(prior, current) {
  if (!current || typeof current !== 'object') return null;
  if (!prior || typeof prior !== 'object') {
    return {
      note: 'no_prior_workspace_snapshot',
      stanceOverlapApprox: null,
      unityChange: null,
      bullets: ['First workspace this session or no prior carryover — treat PRIOR_TURN block as empty or stale.'],
    };
  }

  const pStance = String(prior.provisionalStance || '').trim();
  const cStance = String(current.provisionalStance || '').trim();
  const A = tokenSet(pStance);
  const B = tokenSet(cStance);
  const stanceJ = jaccard(A, B);

  const pUnity = String(prior.phenomenalUnity || '').trim().toLowerCase();
  const cUnity = String(current.phenomenalUnity || '').trim().toLowerCase();
  const unityChange =
    pUnity && cUnity && pUnity !== cUnity ? `${pUnity} → ${cUnity}` : pUnity === cUnity && pUnity ? 'stable' : null;

  const prevConf = normLines(prior.conflictsPreview || prior.conflicts);
  const curConf = normLines(current.conflicts);
  const resolvedHints = [];
  for (const line of prevConf.slice(0, 4)) {
    if (line.length < 12) continue;
    if (!curConf.some((c) => c.includes(line.slice(0, 24)) || line.includes(c.slice(0, 24)))) {
      resolvedHints.push(clipTextComplete(line, 200, { ellipsis: true }));
    }
  }

  const prevOq = normLines(prior.openQuestionsPreview || prior.openQuestions);
  const curOq = normLines(current.openQuestions);
  const newOq = [];
  for (const line of curOq.slice(0, 6)) {
    if (line.length < 12) continue;
    if (!prevOq.some((p) => p.includes(line.slice(0, 20)) || line.includes(p.slice(0, 20)))) {
      newOq.push(clipTextComplete(line, 200, { ellipsis: true }));
    }
  }

  const hypDrift = [];
  const ph = Array.isArray(prior.hypotheses) ? prior.hypotheses : [];
  const ch = Array.isArray(current.hypotheses) ? current.hypotheses : [];
  const pmap = new Map(ph.map((h) => [String(h?.id || '').trim(), h]));
  for (const h of ch.slice(0, 5)) {
    const id = String(h?.id || '').trim();
    if (!id) continue;
    const prevH = pmap.get(id);
    if (!prevH) continue;
    const pw = Number(prevH.weight);
    const cw = Number(h.weight);
    if (Number.isFinite(pw) && Number.isFinite(cw) && Math.abs(cw - pw) >= 0.12) {
      const lab = clipTextComplete(String(h.label || id), 80, { ellipsis: true });
      hypDrift.push(`${lab}: weight ${pw.toFixed(2)} → ${cw.toFixed(2)}`);
    }
  }

  const bullets = [];
  if (stanceJ < 0.25 && pStance.length > 40 && cStance.length > 40) {
    bullets.push('Provisional stance shifted strongly vs prior turn (low token overlap).');
  } else if (stanceJ >= 0.45 && pStance.length > 20 && cStance.length > 20) {
    bullets.push('Provisional stance broadly continuous with prior turn.');
  }
  if (unityChange && unityChange !== 'stable') {
    bullets.push(`Phenomenal unity: ${unityChange}.`);
  }
  if (resolvedHints.length) {
    bullets.push(`Some prior conflicts appear quieter or absent: ${resolvedHints.slice(0, 2).join(' · ')}`);
  }
  if (newOq.length) {
    bullets.push(`New or sharpened open questions vs prior: ${newOq.slice(0, 2).join(' · ')}`);
  }
  if (hypDrift.length) {
    bullets.push(`Hypothesis drift: ${hypDrift.slice(0, 2).join('; ')}`);
  }
  if (!bullets.length) {
    bullets.push('Workspace continuity: minor or no labeled change vs prior snapshot.');
  }

  return {
    stanceOverlapApprox: Math.round(stanceJ * 100) / 100,
    unityChange: unityChange || null,
    bullets: bullets.map((b) => clipTextComplete(b, 420, { ellipsis: true })).slice(0, 6),
  };
}
