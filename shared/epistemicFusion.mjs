/**
 * Epistemic fusion: single latent categorical over current Integration hypotheses,
 * combining cross-turn priors and pipeline observations in log space (naive-Bayes fragment).
 * Pure functions; safe to import from server or tests.
 */

export const EPISTEMIC_FUSION_VERSION = 1;

const EPS = 1e-9;

function clamp01(x, fb = 0.5) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fb;
  return Math.min(1, Math.max(0, n));
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function tokenSet(s) {
  return new Set(tokenize(s));
}

/** Jaccard similarity on word sets, in [0,1]. */
export function lexicalJaccard(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

function softmaxLog(logP) {
  const n = logP.length;
  if (!n) return [];
  const mx = Math.max(...logP);
  const ex = logP.map((l) => Math.exp(l - mx));
  const s = ex.reduce((a, b) => a + b, 0);
  if (s <= 0) return logP.map(() => 1 / n);
  return ex.map((e) => e / s);
}

function normalizePositive(v) {
  const s = v.reduce((a, b) => a + b, 0);
  if (s <= EPS) return v.map(() => 1 / v.length);
  return v.map((x) => x / s);
}

function uniform(K) {
  const u = 1 / K;
  return Array(K).fill(u);
}

function blendWithUniform(p, mix) {
  const m = clamp01(mix, 0);
  if (m <= EPS) return [...p];
  const K = p.length;
  const u = 1 / K;
  return p.map((pi) => pi * (1 - m) + u * m);
}

function entropyNat(p) {
  let h = 0;
  for (const x of p) {
    if (x > EPS) h -= x * Math.log(x);
  }
  return h;
}

/**
 * Build prior p0 over hypothesis indices from priorTurnGlobalWorkspace.hypotheses (decayed id match).
 * @param {Array<{id?: string, weight?: number}>} currentHyps
 * @param {Array<{id?: string, weight?: number}>|null|undefined} priorHyps
 * @param {number} decay
 */
export function buildHypothesisPrior(currentHyps, priorHyps, decay) {
  const K = currentHyps.length;
  if (K === 0) return { prior: [], priorSource: 'none', idMap: new Map() };

  const d = clamp01(decay, 0.88);
  const alpha = 0.04 / K;
  const prior = Array(K).fill(alpha);

  const idMap = new Map();
  if (Array.isArray(priorHyps)) {
    for (const h of priorHyps) {
      if (!h || typeof h !== 'object') continue;
      const id = String(h.id || '').trim().toLowerCase();
      if (!id) continue;
      const w = clamp01(h.weight, 0.5) * d;
      idMap.set(id, (idMap.get(id) || 0) + w);
    }
  }

  let matched = 0;
  for (let i = 0; i < K; i++) {
    const id = String(currentHyps[i]?.id || '').trim().toLowerCase();
    if (id && idMap.has(id)) {
      prior[i] += idMap.get(id);
      matched += 1;
    }
  }

  const priorSource = matched > 0 ? 'prior_turn' : 'uniform_smoothed';
  return { prior: normalizePositive(prior), priorSource, idMap };
}

function vectorFromHypothesisWeights(hyps, K, key = 'weight') {
  const v = Array(K).fill(EPS);
  for (let i = 0; i < K; i++) {
    const w = hyps[i] && typeof hyps[i] === 'object' ? Number(hyps[i][key]) : NaN;
    v[i] = Number.isFinite(w) && w > 0 ? w + EPS : EPS;
  }
  return normalizePositive(v);
}

/** Map source hypothesis list onto current K hypotheses by stable id. */
function vectorFromSourceById(currentHyps, sourceHyps, K) {
  const map = new Map();
  for (const h of sourceHyps || []) {
    if (!h || typeof h !== 'object') continue;
    const id = String(h.id || '').trim().toLowerCase();
    if (!id) continue;
    const w = clamp01(h.weight, 0.5);
    map.set(id, w);
  }
  const v = Array(K).fill(EPS);
  for (let i = 0; i < K; i++) {
    const id = String(currentHyps[i]?.id || '').trim().toLowerCase();
    const w = id && map.has(id) ? map.get(id) : NaN;
    v[i] = Number.isFinite(w) && w > 0 ? w + EPS : EPS;
  }
  return normalizePositive(v);
}

function logVectorFromProb(p) {
  return p.map((x) => Math.log(Math.max(x, EPS)));
}

/** Geometric mean of two positive vectors (normalized). */
function mergeReasoningIntegrationLikelihoods(pr, pi, K) {
  const logR = logVectorFromProb(pr);
  const logI = logVectorFromProb(pi);
  const logM = [];
  for (let i = 0; i < K; i++) {
    logM[i] = 0.5 * (logR[i] + logI[i]);
  }
  return softmaxLog(logM);
}

function stanceLikelihoodVector(stanceText, labels, K, precomputedStanceSims) {
  const out = Array(K).fill(1);
  const st = String(stanceText || '').trim();
  if (!st) return { vec: out, applied: false, maxOverlap: 0 };
  let maxO = 0;
  const overlaps = [];
  for (let i = 0; i < K; i++) {
    const o = Array.isArray(precomputedStanceSims)
      ? (precomputedStanceSims[i] ?? lexicalJaccard(st, labels[i] || ''))
      : lexicalJaccard(st, labels[i] || '');
    overlaps.push(o);
    if (o > maxO) maxO = o;
  }
  const stanceMinOverlap = typeof precomputedStanceSims?._minOverlap === 'number' ? precomputedStanceSims._minOverlap : 0.08;
  if (maxO < stanceMinOverlap) return { vec: out, applied: false, maxOverlap: maxO };
  const beta = typeof precomputedStanceSims?._beta === 'number' ? precomputedStanceSims._beta : 2.2;
  for (let i = 0; i < K; i++) {
    out[i] = Math.exp(beta * overlaps[i]);
  }
  return { vec: normalizePositive(out), applied: true, maxOverlap: maxO };
}

function beliefOverlapLikelihood(labels, beliefSnippets, K, precomputedBeliefSims) {
  const out = Array(K).fill(1);
  const snippets = Array.isArray(beliefSnippets) ? beliefSnippets.filter(Boolean) : [];
  if (!snippets.length) return { vec: out, applied: false };
  let any = false;
  const cap = 1.35;
  for (let i = 0; i < K; i++) {
    let best = 0;
    if (Array.isArray(precomputedBeliefSims) && precomputedBeliefSims[i]) {
      const row = precomputedBeliefSims[i];
      for (let j = 0; j < row.length; j++) {
        if (row[j] > best) best = row[j];
      }
    } else {
      for (const sn of snippets) {
        const o = lexicalJaccard(labels[i] || '', sn);
        if (o > best) best = o;
      }
    }
    const beliefMinOverlap = Array.isArray(precomputedBeliefSims) && typeof precomputedBeliefSims._minOverlap === 'number' ? precomputedBeliefSims._minOverlap : 0.06;
    if (best > beliefMinOverlap) any = true;
    out[i] = 1 + (cap - 1) * Math.min(1, best * 3);
  }
  return { vec: normalizePositive(out), applied: any };
}

function collectBeliefSnippets(sm) {
  const out = [];
  const digest = sm?.clientBeliefDigest;
  if (Array.isArray(digest)) {
    for (const r of digest.slice(0, 12)) {
      if (r && typeof r === 'object' && r.statement) out.push(String(r.statement));
    }
  }
  const store = sm?.beliefStore;
  if (Array.isArray(store)) {
    for (const b of store.slice(-15)) {
      if (b && typeof b === 'object' && b.belief) {
        const t = String(b.belief).replace(/\s+/g, ' ').trim().slice(0, 400);
        if (t) out.push(t);
      }
    }
  }
  return out;
}

function tensionStress(sm, gw) {
  const contradictions = Array.isArray(sm?.contradictions) ? sm.contradictions.length : 0;
  const tensions = Array.isArray(sm?.beliefTensions) ? sm.beliefTensions.length : 0;
  const conflicts = Array.isArray(gw?.conflicts) ? gw.conflicts.length : 0;
  const split = String(gw?.phenomenalUnity || '').toLowerCase() === 'split';
  let s = 0;
  s += Math.min(0.35, contradictions * 0.07);
  s += Math.min(0.25, tensions * 0.06);
  s += Math.min(0.3, conflicts * 0.08);
  if (split) s += 0.22;
  return Math.min(1, s);
}

function hypothesisConflictPenalty(labels, conflictTexts, K) {
  const out = Array(K).fill(1);
  const texts = (Array.isArray(conflictTexts) ? conflictTexts : [])
    .map((x) => String(x || '').toLowerCase())
    .join(' ');
  if (!texts.trim()) return out;
  for (let i = 0; i < K; i++) {
    const lab = String(labels[i] || '').trim().toLowerCase();
    if (lab.length >= 8 && texts.includes(lab.slice(0, Math.min(40, lab.length)))) {
      out[i] *= 0.55;
    }
  }
  return out;
}

/**
 * @param {object} sharedMemory - pipeline shared memory snapshot (after Integration)
 * @param {{ priorHypothesisDecay?: number, stanceSimilarities?: number[], beliefSimilarities?: number[][] }} [options]
 * @returns {object|null}
 */
export function fuseEpistemicPosterior(sharedMemory, options = {}) {
  const sm = sharedMemory;
  if (!sm || typeof sm !== 'object') return null;
  const gw = sm.globalWorkspace;
  if (!gw || typeof gw !== 'object') return null;
  const hyps = Array.isArray(gw.hypotheses) ? gw.hypotheses : [];
  const K = hyps.length;
  if (K === 0) return null;

  const decay = typeof options.priorHypothesisDecay === 'number' && Number.isFinite(options.priorHypothesisDecay)
    ? options.priorHypothesisDecay
    : 0.88;

  const labels = hyps.map((h) => String(h?.label || ''));

  const priorGw = sm.priorTurnGlobalWorkspace;
  const priorHyps = priorGw && typeof priorGw === 'object' && Array.isArray(priorGw.hypotheses) ? priorGw.hypotheses : [];
  const { prior: p0, priorSource } = buildHypothesisPrior(hyps, priorHyps, decay);

  const portfolio = sm.hypothesisPortfolio?.hypotheses;
  const hasPortfolio = Array.isArray(portfolio) && portfolio.length > 0;
  const pr = hasPortfolio ? vectorFromSourceById(hyps, portfolio, K) : uniform(K);
  const pi = vectorFromHypothesisWeights(hyps, K, 'weight');

  let lik;
  if (hasPortfolio) {
    lik = mergeReasoningIntegrationLikelihoods(pr, pi, K);
  } else {
    lik = [...pi];
  }

  const logP = logVectorFromProb(p0).map((lp, i) => lp + Math.log(Math.max(lik[i], EPS)));

  const stance = sm.userStancePrediction;
  const stanceText = stance && typeof stance === 'object' ? String(stance.expectUserWants || '') : '';
  const stanceRes = stanceLikelihoodVector(stanceText, labels, K, options.stanceSimilarities);
  for (let i = 0; i < K; i++) {
    logP[i] += Math.log(Math.max(stanceRes.vec[i], EPS));
  }

  const beliefSnippets = collectBeliefSnippets(sm);
  const belRes = beliefOverlapLikelihood(labels, beliefSnippets, K, options.beliefSimilarities);
  for (let i = 0; i < K; i++) {
    logP[i] += Math.log(Math.max(belRes.vec[i], EPS));
  }

  const conflictTexts = [
    ...(Array.isArray(gw.conflicts) ? gw.conflicts : []),
    ...(Array.isArray(sm.contradictions) ? sm.contradictions.map((x) => String(x)) : []),
  ];
  const pen = hypothesisConflictPenalty(labels, conflictTexts, K);
  for (let i = 0; i < K; i++) {
    logP[i] += Math.log(Math.max(pen[i], EPS));
  }

  let post = softmaxLog(logP);

  const sur = sm.surpriseAssessment;
  const surpriseScore = sur && typeof sur === 'object' ? clamp01(sur.score, 0.3) : 0;
  const surpriseBlend = 0.15 * surpriseScore;
  post = blendWithUniform(post, surpriseBlend);

  const stress = tensionStress(sm, gw);
  const tensionBlend = 0.2 * stress;
  post = blendWithUniform(post, tensionBlend);

  const ic = Number(gw.integrationConfidence);
  const icLow = Number.isFinite(ic) && ic < 0.45 ? (0.45 - ic) / 0.45 : 0;
  const integrationBlend = 0.12 * icLow;
  post = blendWithUniform(post, integrationBlend);

  const H = entropyNat(post);
  const maxP = Math.max(...post);

  return {
    version: EPISTEMIC_FUSION_VERSION,
    posterior: post.map((x) => Math.round(x * 10000) / 10000),
    entropy: Math.round(H * 1000) / 1000,
    maxPosterior: Math.round(maxP * 10000) / 10000,
    priorSource,
    factorsMeta: {
      stanceApplied: stanceRes.applied,
      stanceMaxOverlap: Math.round(stanceRes.maxOverlap * 1000) / 1000,
      beliefsApplied: belRes.applied,
      surpriseBlend: Math.round(surpriseBlend * 1000) / 1000,
      tensionBlend: Math.round(tensionBlend * 1000) / 1000,
      integrationBlend: Math.round(integrationBlend * 1000) / 1000,
      priorTurnDecay: decay,
    },
    hypothesisIds: hyps.map((h) => String(h?.id || '').slice(0, 32)),
  };
}

/**
 * Slim epistemic fusion for SSE / client POST payloads.
 * @param {object|null|undefined} ef
 */
export function slimEpistemicFusion(ef) {
  if (!ef || typeof ef !== 'object') return null;
  const posterior = Array.isArray(ef.posterior) ? ef.posterior.map((x) => clamp01(x, 0)) : [];
  return {
    version: ef.version === EPISTEMIC_FUSION_VERSION ? EPISTEMIC_FUSION_VERSION : Number(ef.version) || EPISTEMIC_FUSION_VERSION,
    posterior: posterior.slice(0, 8),
    entropy: typeof ef.entropy === 'number' && Number.isFinite(ef.entropy) ? ef.entropy : undefined,
    maxPosterior: typeof ef.maxPosterior === 'number' && Number.isFinite(ef.maxPosterior) ? ef.maxPosterior : undefined,
    priorSource: typeof ef.priorSource === 'string' ? ef.priorSource.slice(0, 24) : undefined,
    factorsMeta:
      ef.factorsMeta && typeof ef.factorsMeta === 'object'
        ? {
            stanceApplied: ef.factorsMeta.stanceApplied === true,
            beliefsApplied: ef.factorsMeta.beliefsApplied === true,
            surpriseBlend: ef.factorsMeta.surpriseBlend,
            tensionBlend: ef.factorsMeta.tensionBlend,
            integrationBlend: ef.factorsMeta.integrationBlend,
          }
        : undefined,
    hypothesisIds: Array.isArray(ef.hypothesisIds) ? ef.hypothesisIds.map((id) => String(id).slice(0, 32)).slice(0, 8) : [],
  };
}

/**
 * Mutates globalWorkspace.hypotheses with fusedWeight; sets sharedMemory.epistemicFusion.
 * @param {object} sharedMemory
 * @param {{ priorHypothesisDecay?: number }} [options]
 * @returns {object|null} fusion result or null
 */
export function applyEpistemicFusionToSharedMemory(sharedMemory, options = {}) {
  const fused = fuseEpistemicPosterior(sharedMemory, options);
  if (!fused) {
    sharedMemory.epistemicFusion = null;
    return null;
  }
  const gw = sharedMemory.globalWorkspace;
  const hyps = gw?.hypotheses;
  if (!Array.isArray(hyps) || hyps.length !== fused.posterior.length) {
    sharedMemory.epistemicFusion = fused;
    return fused;
  }
  for (let i = 0; i < hyps.length; i++) {
    const h = hyps[i];
    if (!h || typeof h !== 'object') continue;
    const fw = fused.posterior[i];
    h.fusedWeight = typeof fw === 'number' && Number.isFinite(fw) ? Math.round(fw * 10000) / 10000 : fw;
  }
  sharedMemory.epistemicFusion = fused;
  return fused;
}
