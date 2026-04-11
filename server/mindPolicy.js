import { getLlmContextTokensMax } from './llmContextBudget.js';
import { clipTextComplete } from '../shared/textClip.mjs';
import { isPauseTimelineNoise } from '../shared/temporalTimelinePauseFilter.mjs';
import { isBeliefTensionReviewPrimaryTurn } from '../shared/beliefRevisionsVoice.mjs';
import { PIPELINE_LAYER_KEYS, PIPELINE_LAYERS } from '../shared/pipelineModules.mjs';
import { querySimilarities } from './embeddingService.js';
import { getThreshold } from './thresholdStore.js';

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.min(hi, Math.max(lo, x));
}

export const MIND_PHASES = ['wake', 'focus', 'drift', 'sleep'];

/** Aligns with client `runtimeSettings.userModel` — merged every run so USER_MODEL_JSON shape is always present. */
const DEFAULT_USER_MODEL_FOR_PIPELINE = {
  display_name: 'Alek',
  goals:
    'Ship and refine a local cognitive-pipeline stack: multi-module graph, local/HF inference, and memory/belief flows that stay honest about limits. Prefer working, inspectable behavior—clear server semantics, prompts, and settings that behave predictably.',
  expertise:
    'Software development (JS/Node, browser + local API workflows). Comfortable with LLM APIs, streaming pipelines, and reading/changing prompt and policy code. Not a novice; skip basic tutorials unless asked.',
  emotional_state:
    'Values clarity and completeness; low tolerance for skipped steps or "just run X" without doing the work. Otherwise neutral—no need for motivational tone.',
  communication_style:
    "Direct, structured answers (headings/bullets when it helps). Use proper code citations with paths/lines when referencing a repo. Full commands when suggesting CLI steps. Proportional length—short for simple questions, deeper when the task is complex. Minimal bold and filler; no engagement-bait closers. If something's uncertain or out of scope, say so plainly.",
  version: 0,
};

const STRUCTURAL_SELF_JSON_MAX = 7000;

export function normalizeStructuralSelfPayload(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw.slice(0, 16)) {
    if (!x || typeof x !== 'object') continue;
    out.push({
      key: clipTextComplete(String(x.key || ''), 160, { ellipsis: false }),
      label: clipTextComplete(String(x.label || x.name || ''), 200, { ellipsis: false }),
      description: clipTextComplete(String(x.description || ''), 1200, { ellipsis: false }),
      confidence: clamp(x.confidence, 0, 1) ?? 0.5,
    });
  }
  return out;
}

const TRAIT_TRIGGERS = new Set(['user_tone', 'user_content', 'self_reflection', 'constitution_tension']);

/** Modules that receive PERSONALITY_PROFILE_JSON — facet.modules is whitelisted to these. */
export const PERSONALITY_FACET_TARGET_MODULES = new Set([
  'Identity',
  'Integration',
  'Language',
  'Narrative',
  'Voice',
  'Metacognition',
  'Workspace Metacognition',
]);

function normalizeFacetModules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw.slice(0, 6)) {
    const m = String(x || '').trim();
    if (PERSONALITY_FACET_TARGET_MODULES.has(m)) out.push(m);
  }
  return out;
}

function buildPersonalityRelevanceCorpus(sm) {
  const parts = [];
  const inp = String(sm.originalInput ?? '').trim();
  if (inp) parts.push(inp);
  const intent = String(sm.intent ?? '').trim();
  if (intent) parts.push(intent);
  const att = sm.moduleOutputs && typeof sm.moduleOutputs === 'object' ? sm.moduleOutputs.Attention : null;
  if (att != null && String(att).trim()) {
    parts.push(clipTextComplete(String(att), 800, { ellipsis: false }));
  }
  return parts.join('\n');
}

function tokenizeForOverlap(s) {
  const m = String(s).toLowerCase().match(/[a-z0-9_]{3,}/g);
  return m ? new Set(m) : new Set();
}

function overlapScore(facetText, corpusTokens) {
  const ft = tokenizeForOverlap(facetText);
  if (!ft.size || !corpusTokens.size) return 0;
  let inter = 0;
  for (const t of ft) {
    if (corpusTokens.has(t)) inter += 1;
  }
  const denom = Math.sqrt(ft.size * corpusTokens.size);
  return denom > 0 ? inter / denom : 0;
}

function userInputToneMultiplier(input) {
  const s = String(input || '');
  let m = 1;
  if (/\?/.test(s)) m *= 1.08;
  if (/!/.test(s)) m *= 1.06;
  const words = s.split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return m;
  const capsy = words.filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w)).length;
  if (capsy / words.length > 0.2) m *= 1.1;
  return m;
}

function triggerContextMultiplier(trigger, sm) {
  const phase = String(sm.phaseEffective || sm.phase || 'focus');
  const hasConst = String(sm.constitution || '').trim().length > 0;
  const arousal = clamp(sm.arousal, 0, 1) ?? 0.5;
  const table = {
    wake: { user_content: 1.12, user_tone: 1.05, self_reflection: 0.95, constitution_tension: 1.0 },
    focus: { user_content: 1.1, user_tone: 1.08, self_reflection: 1.0, constitution_tension: 1.0 },
    drift: { user_content: 0.92, user_tone: 0.95, self_reflection: 1.15, constitution_tension: 1.08 },
    sleep: { user_content: 0.88, user_tone: 0.9, self_reflection: 1.2, constitution_tension: 1.05 },
  };
  let mult = table[phase]?.[trigger] ?? 1;
  if (hasConst && trigger === 'constitution_tension') mult *= 1.12;
  if (arousal > 0.72 && trigger === 'user_tone') mult *= 1.06;
  const inp = String(sm.originalInput || '');
  const toneBoost = userInputToneMultiplier(inp);
  if (trigger === 'user_tone') mult *= Math.min(1.18, toneBoost);
  if (trigger === 'user_content') mult *= Math.min(1.12, 0.92 + (toneBoost - 1) * 0.5);
  return mult;
}

function moduleTargetingMultiplier(facet, moduleName) {
  const mod = String(moduleName || '').trim();
  const mods = Array.isArray(facet.modules) ? facet.modules : [];
  if (!mods.length) return 1;
  if (mod && mods.includes(mod)) return 1.15;
  return 0.35;
}

/**
 * Rank personality facets for prompt injection (highest score first).
 * Exported for tests.
 * @param {object} sm
 * @param {Array} facets
 * @param {string} [moduleName]
 * @param {{ embeddingScores?: number[] }} [opts] - pre-computed embedding similarities per facet
 */
export function rankFacetsForContext(sm, facets, moduleName = '', opts = {}) {
  const corpus = buildPersonalityRelevanceCorpus(sm);
  const corpusTokens = tokenizeForOverlap(corpus);
  const embScores = Array.isArray(opts.embeddingScores) ? opts.embeddingScores : null;
  const scored = facets.map((f, idx) => {
    const base = (Number(f.strength) || 0.5) * (Number(f.confidence) || 0.5);
    const trig = TRAIT_TRIGGERS.has(String(f.trigger)) ? String(f.trigger) : 'self_reflection';
    const trigM = triggerContextMultiplier(trig, sm);
    const modM = moduleTargetingMultiplier(f, moduleName);
    const text = `${String(f.label || '')} ${String(f.evidence || '')}`;
    const ov = embScores && typeof embScores[idx] === 'number' ? embScores[idx] : overlapScore(text, corpusTokens);
    const score = base * trigM * modM * (1 + ov * 8) + ov * 1.25;
    return { f, score, core: f.core === true };
  });
  scored.sort((a, b) => {
    if (a.core !== b.core) return a.core ? -1 : 1;
    return b.score - a.score;
  });
  return scored.map((x) => x.f);
}

function lastDroppableFacetIndex(facets) {
  for (let i = facets.length - 1; i >= 0; i -= 1) {
    if (!facets[i].core) return i;
  }
  return facets.length > 1 ? facets.length - 1 : -1;
}

/** Client-supplied amendable interpersonal / expressive trait profile (capped for prompts). */
export function normalizePersonalityProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const facetsIn = Array.isArray(raw.facets) ? raw.facets : [];
  const facets = [];
  for (const f of facetsIn.slice(0, 24)) {
    if (!f || typeof f !== 'object') continue;
    const id = clipTextComplete(String(f.id || f.label || '').trim(), 80, { ellipsis: false });
    const label = clipTextComplete(String(f.label || f.id || '').trim(), 80, { ellipsis: false });
    if (!id && !label) continue;
    const trig = String(f.trigger || 'self_reflection').slice(0, 32);
    const trigger = TRAIT_TRIGGERS.has(trig) ? trig : 'self_reflection';
    const strength = clamp(f.strength, 0, 1) ?? 0.5;
    const confidence = clamp(f.confidence, 0, 1) ?? 0.5;
    const modules = normalizeFacetModules(f.modules);
    facets.push({
      id: id || label,
      label: label || id,
      strength,
      confidence,
      evidence: clipTextComplete(String(f.evidence || ''), 400, { ellipsis: false }),
      trigger,
      updatedAt: String(f.updatedAt || '').slice(0, 40),
      core: f.core === true,
      ...(modules.length ? { modules } : {}),
    });
  }
  const rs = raw.relationalStance && typeof raw.relationalStance === 'object' ? raw.relationalStance : null;
  const relationalStance = rs
    ? {
        towardUser: clipTextComplete(String(rs.towardUser || ''), 120, { ellipsis: false }),
        notes: clipTextComplete(String(rs.notes || ''), 400, { ellipsis: false }),
        confidence: clamp(rs.confidence, 0, 1) ?? null,
      }
    : null;
  return {
    version: Number.isFinite(Number(raw.version)) ? Math.floor(Number(raw.version)) : 0,
    facets,
    relationalStance,
    systemTreatmentNotes: clipTextComplete(String(raw.systemTreatmentNotes || ''), 800, { ellipsis: false }),
  };
}

function normalizeWorkingMemorySeed(raw) {
  if (!Array.isArray(raw)) return [];
  const items = [];
  let i = 0;
  for (const x of raw.slice(0, 12)) {
    const text = typeof x === 'string' ? x : x?.text;
    if (!text || !String(text).trim()) continue;
    items.push({
      id: `wm_${i++}_${Date.now()}`,
      text: clipTextComplete(String(text).trim(), 2000, { ellipsis: false }),
      source:
        typeof x === 'object' && x.source
          ? clipTextComplete(String(x.source), 80, { ellipsis: false })
          : 'seed',
      createdAt: nowIso(),
    });
  }
  return items;
}

/**
 * Merge rhythm / intent / user model / constitution from pipeline `options` into shared memory.
 */
function normalizeRecentTemporalTimelinePayload(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw.slice(0, 28)) {
    if (!e || typeof e !== 'object') continue;
    if (isPauseTimelineNoise(e)) continue;
    const title = String(e.title || '').trim();
    if (!title) continue;
    out.push({
      title: clipTextComplete(title, 240, { ellipsis: false }),
      details: clipTextComplete(String(e.details || '').trim(), 600, { ellipsis: true }),
      source: clipTextComplete(String(e.source || '').trim(), 40, { ellipsis: false }),
      created_date: String(e.created_date || '').slice(0, 44),
    });
  }
  return out.slice(0, 24);
}

function normalizeClientLtmDigestPayload(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw.slice(0, 28)) {
    if (!m || typeof m !== 'object') continue;
    const title = String(m.title || '').trim();
    const content = String(m.content || '').trim();
    if (!title && !content) continue;
    out.push({
      title: clipTextComplete(title || '(untitled)', 240, { ellipsis: false }),
      content: clipTextComplete(content, 1500, { ellipsis: true }),
      memory_type: clipTextComplete(String(m.memory_type || '').trim(), 32, { ellipsis: false }),
      created_date: String(m.created_date || '').slice(0, 44),
    });
  }
  return out.slice(0, 22);
}

function normalizeClientBeliefDigestPayload(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const b of raw.slice(0, 36)) {
    if (!b || typeof b !== 'object') continue;
    const statement = String(b.statement || '').trim();
    if (!statement) continue;
    const c = b.confidence;
    const conf =
      typeof c === 'number' && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null;
    const st = String(b.status || 'active').trim().slice(0, 20);
    out.push({
      statement: clipTextComplete(statement, 580, { ellipsis: true }),
      ...(conf != null ? { confidence: conf } : {}),
      category: clipTextComplete(String(b.category || '').trim(), 40, { ellipsis: false }),
      source: clipTextComplete(String(b.source || '').trim(), 48, { ellipsis: false }),
      ...(st && st !== 'active' ? { status: st } : {}),
    });
  }
  return out.slice(0, 30);
}

function normalizeClientAffectDigestPayload(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 14)) {
    if (!a || typeof a !== 'object') continue;
    const summary = String(a.summary || '').trim();
    if (!summary) continue;
    out.push({
      summary: clipTextComplete(summary, 520, { ellipsis: true }),
      created_date: String(a.created_date || '').slice(0, 44),
    });
  }
  return out.slice(0, 10);
}

export function mergeMindRuntimeIntoSharedMemory(sharedMemory, options = {}) {
  const phase = MIND_PHASES.includes(options.phase) ? options.phase : 'focus';
  const ar = clamp(options.arousal, 0, 1);
  const arousal = ar == null ? 0.5 : ar;
  const intent = clipTextComplete(String(options.intent || ''), 2000, { ellipsis: false });
  const userModel = {
    ...DEFAULT_USER_MODEL_FOR_PIPELINE,
    ...(options.userModel && typeof options.userModel === 'object' ? options.userModel : {}),
  };
  const constitution = clipTextComplete(String(options.constitution || ''), 12000, { ellipsis: false });
  const prevParticipantLabels =
    sharedMemory.participantLabels && typeof sharedMemory.participantLabels === 'object'
      ? sharedMemory.participantLabels
      : {};
  const priorHumanDisplay =
    sharedMemory.userModel && typeof sharedMemory.userModel === 'object'
      ? String(sharedMemory.userModel.display_name || '').trim()
      : '';

  sharedMemory.phase = phase;
  sharedMemory.arousal = arousal;
  sharedMemory.intent = intent;
  sharedMemory.userModel = userModel;
  sharedMemory.constitution = constitution;

  const humanFromOpts = String(userModel.display_name || '').trim();
  const humanRaw = humanFromOpts || priorHumanDisplay;
  const humanLabel = clipTextComplete(humanRaw, 120, { ellipsis: false });
  const mindFromOpts = String(options.mindDisplayName || '').trim();
  const mindRaw = mindFromOpts || String(prevParticipantLabels.mind || '').trim();
  const mindLabel = clipTextComplete(mindRaw, 120, { ellipsis: false });
  sharedMemory.participantLabels = { human: humanLabel, mind: mindLabel };

  if (options.dmnCarryover != null && String(options.dmnCarryover).trim()) {
    sharedMemory.dmnCarryover = clipTextComplete(String(options.dmnCarryover).trim(), 6000, {
      ellipsis: true,
    });
  } else {
    sharedMemory.dmnCarryover = null;
  }

  const structural = normalizeStructuralSelfPayload(options.structuralSelf);
  if (structural.length) sharedMemory.structuralSelfModel = structural;
  else if (!Array.isArray(sharedMemory.structuralSelfModel)) sharedMemory.structuralSelfModel = [];

  const wmItems = normalizeWorkingMemorySeed(options.workingMemorySeed);
  if (wmItems.length) {
    const prev = sharedMemory.workingMemory?.items || [];
    sharedMemory.workingMemory = { items: [...wmItems, ...prev].slice(0, 12) };
  } else if (!sharedMemory.workingMemory || typeof sharedMemory.workingMemory !== 'object') {
    sharedMemory.workingMemory = { items: [] };
  } else if (!Array.isArray(sharedMemory.workingMemory.items)) {
    sharedMemory.workingMemory.items = [];
  }

  if (!Array.isArray(sharedMemory.metacognitionTimeline)) sharedMemory.metacognitionTimeline = [];
  if (!Array.isArray(sharedMemory.beliefTensions)) sharedMemory.beliefTensions = [];
  if (!Array.isArray(sharedMemory.boundaryAudit)) sharedMemory.boundaryAudit = [];
  if (options.personalityProfile && typeof options.personalityProfile === 'object') {
    sharedMemory.personalityProfile = normalizePersonalityProfile(options.personalityProfile);
  }
  if ('recentTemporalEvents' in options) {
    const tl = normalizeRecentTemporalTimelinePayload(options.recentTemporalEvents);
    if (tl.length) sharedMemory.recentTemporalTimeline = tl;
    else delete sharedMemory.recentTemporalTimeline;
  }
  if ('persistedLongTermMemories' in options) {
    const rows = normalizeClientLtmDigestPayload(options.persistedLongTermMemories);
    if (rows.length) sharedMemory.clientLtmDigest = rows;
    else delete sharedMemory.clientLtmDigest;
  }
  if ('persistedBeliefRows' in options) {
    const rows = normalizeClientBeliefDigestPayload(options.persistedBeliefRows);
    if (rows.length) sharedMemory.clientBeliefDigest = rows;
    else delete sharedMemory.clientBeliefDigest;
  }
  if ('persistedAffectHistory' in options) {
    const rows = normalizeClientAffectDigestPayload(options.persistedAffectHistory);
    if (rows.length) sharedMemory.clientAffectDigest = rows;
    else delete sharedMemory.clientAffectDigest;
  }
  if ('persistedBiographyExcerpt' in options) {
    const ex = clipTextComplete(String(options.persistedBiographyExcerpt ?? '').trim(), 3200, { ellipsis: true });
    if (ex) sharedMemory.clientBiographyExcerpt = ex;
    else delete sharedMemory.clientBiographyExcerpt;
  }
  applyPriorPredictionAuditToSharedMemory(sharedMemory, options);
  sharedMemory.phenomenalNow = sharedMemory.phenomenalNow || null;
  sharedMemory.phaseEffective = sharedMemory.phaseEffective ?? null;
  sharedMemory.outputConstraints = sharedMemory.outputConstraints || null;

  deriveInteroception(sharedMemory);
  sharedMemory.cognitivePolicy = deriveCognitivePolicy(sharedMemory);
  sharedMemory.strictGlobalWorkspaceBroadcast = options.strictGlobalWorkspaceBroadcast === true;
  return sharedMemory;
}

/** Normalize client-supplied cross-turn prediction audit onto shared memory (after continue clone). */
export function applyPriorPredictionAuditToSharedMemory(sharedMemory, options = {}) {
  const pa = options?.priorPredictionAudit;
  if (!pa || typeof pa !== 'object') {
    sharedMemory.priorTurnPredictionAudit = null;
    return;
  }
  const prev = String(pa.previousExpectUserWants || '').trim();
  if (!prev && pa.previousConfidence == null) {
    sharedMemory.priorTurnPredictionAudit = null;
    return;
  }
  sharedMemory.priorTurnPredictionAudit = {
    at: String(pa.at || '').slice(0, 40),
    sessionId: pa.sessionId != null ? String(pa.sessionId).slice(0, 120) : null,
    previousExpectUserWants: clipTextComplete(String(pa.previousExpectUserWants || ''), 1200, {
      ellipsis: false,
    }),
    previousConfidence:
      typeof pa.previousConfidence === 'number' && Number.isFinite(pa.previousConfidence)
        ? Math.min(1, Math.max(0, pa.previousConfidence))
        : null,
    previousPrimaryTurnPreview: clipTextComplete(String(pa.previousPrimaryTurnPreview || ''), 800, {
      ellipsis: false,
    }),
    newPrimaryTurnPreview: clipTextComplete(String(pa.newPrimaryTurnPreview || ''), 800, {
      ellipsis: false,
    }),
    overlapScore:
      typeof pa.overlapScore === 'number' && Number.isFinite(pa.overlapScore)
        ? Math.min(1, Math.max(0, pa.overlapScore))
        : null,
    heuristicAlignment: String(pa.heuristicAlignment || 'unknown').slice(0, 32),
  };
}

export function priorTurnPredictionAuditBlock(sm, textMax = 1400) {
  const a = sm?.priorTurnPredictionAudit;
  if (!a || typeof a !== 'object') return '';
  let prose = [
    'Last turn this mind predicted the user primarily wanted:',
    a.previousExpectUserWants || '(no summary)',
    a.previousConfidence != null ? `(confidence ${a.previousConfidence.toFixed?.(2) ?? a.previousConfidence})` : '',
    `Heuristic vs new primary turn: ${a.heuristicAlignment || 'unknown'}; token-overlap ${a.overlapScore != null ? a.overlapScore.toFixed(2) : 'n/a'}.`,
    a.newPrimaryTurnPreview
      ? `New user primary turn (preview): ${a.newPrimaryTurnPreview}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  prose = clipTextComplete(prose, textMax, { ellipsis: true });
  return `PRIOR_TURN_PREDICTION_AUDIT (compare with last Planning output; update Learning surprise and whether goals shifted):\n${prose}`;
}

export function epistemicClaimsBlock(sm, claimsMax = 10, textMaxEach = 280) {
  const raw = sm?.epistemicClaims;
  if (!Array.isArray(raw) || !raw.length) return '';
  const lines = [];
  for (const c of raw.slice(0, claimsMax)) {
    if (!c || typeof c !== 'object') continue;
    const text = clipTextComplete(String(c.text || ''), textMaxEach, { ellipsis: false });
    const kind = String(c.kind || 'inferred').slice(0, 28);
    const conf =
      typeof c.confidence === 'number' && Number.isFinite(c.confidence)
        ? Math.min(1, Math.max(0, c.confidence)).toFixed(2)
        : '?';
    if (text) lines.push(`- [${kind}] (${conf}) ${text}`);
  }
  if (!lines.length) return '';
  return `EPISTEMIC_CLAIMS_TOP (tag provenance in Voice; do not state tool/user facts as introspection):\n${lines.join('\n')}`;
}

/**
 * Compact digest of competing hypotheses for modules that resolve uncertainty.
 * Prefer workspace hypotheses after Integration; before that, Reasoning’s portfolio.
 */
export function hypothesisPortfolioBlock(
  sm,
  { hypothesesMax = 6, labelMax = 220, evidenceMax = 180 } = {}
) {
  const gwH = Array.isArray(sm?.globalWorkspace?.hypotheses) ? sm.globalWorkspace.hypotheses : null;
  const portH = Array.isArray(sm?.hypothesisPortfolio?.hypotheses) ? sm.hypothesisPortfolio.hypotheses : null;
  const source = gwH?.length ? gwH : portH;
  if (!source?.length) return '';
  const lines = [];
  for (const h of source.slice(0, hypothesesMax)) {
    if (!h || typeof h !== 'object') continue;
    const label = clipTextComplete(String(h.label || ''), labelMax, { ellipsis: false });
    if (!label.trim()) continue;
    const w =
      typeof h.weight === 'number' && Number.isFinite(h.weight)
        ? Math.min(1, Math.max(0, h.weight)).toFixed(2)
        : '?';
    const ef = clipTextComplete(String(h.evidence_for || ''), evidenceMax, { ellipsis: true });
    const ea = clipTextComplete(String(h.evidence_against || ''), evidenceMax, { ellipsis: true });
    const flip = clipTextComplete(String(h.would_flip_if || ''), 140, { ellipsis: true });
    const id = clipTextComplete(String(h.id || ''), 24, { ellipsis: false }) || '—';
    lines.push(
      `- [${id}] (${w}) ${label}${ef ? ` | for: ${ef}` : ''}${ea ? ` | against: ${ea}` : ''}${flip ? ` | flip-if: ${flip}` : ''}`
    );
  }
  if (!lines.length) return '';
  return `HYPOTHESIS_PORTFOLIO (relative plausibility 0–1, not calibrated probabilities; after Integration, GLOBAL_WORKSPACE_JSON.hypotheses is authoritative when present):\n${lines.join('\n')}`;
}

/** Prior-turn hypotheses hydrated into sharedMemory before Reasoning runs (Planning/Reasoning only). */
export function priorHypothesisCarryoverBlock(
  sm,
  { hypothesesMax = 6, labelMax = 200, evidenceMax = 140 } = {}
) {
  const src = sm.hypothesisPortfolio?.hypotheses;
  if (!Array.isArray(src) || !src.length) return '';
  const decayNote =
    sm.hypothesisPortfolio?.source === 'prior_workspace'
      ? ' Weights were decayed when this run started — re-validate against this turn’s input.'
      : '';
  const lines = [];
  for (const h of src.slice(0, hypothesesMax)) {
    if (!h || typeof h !== 'object') continue;
    const label = clipTextComplete(String(h.label || ''), labelMax, { ellipsis: false });
    if (!label.trim()) continue;
    const w =
      typeof h.weight === 'number' && Number.isFinite(h.weight)
        ? Math.min(1, Math.max(0, h.weight)).toFixed(2)
        : '?';
    const flip = clipTextComplete(String(h.would_flip_if || ''), evidenceMax, { ellipsis: true });
    const id = clipTextComplete(String(h.id || ''), 20, { ellipsis: false }) || '—';
    lines.push(`- [${id}] (${w}) ${label}${flip ? ` — flip-if: ${flip}` : ''}`);
  }
  if (!lines.length) return '';
  return `PRIOR_HYPOTHESIS_CARRYOVER (from last turn’s workspace or carried state; not current Reasoning output.${decayNote}):\n${lines.join('\n')}`;
}

export function deriveInteroception(sm) {
  const meta = (sm.metacognitionTimeline || []).slice(-1)[0];
  const u = meta?.uncertainty;
  let uncertaintyPressure =
    typeof u === 'number' && Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0.35;

  const curiosityText = String(sm.moduleOutputs?.Curiosity || '');
  const curiosityPressure = Math.min(1, curiosityText.length / 800);

  const socialBlob = `${JSON.stringify(sm.userModel || {})} ${String(sm.moduleOutputs?.['Social Cognition'] || '')}`;
  const socialAlignmentPressure = Math.min(1, socialBlob.length / 6000);

  const mo = sm.moduleOutputs || {};
  const cognitiveLoad = Math.min(
    1,
    Object.values(mo).reduce((s, v) => s + String(v || '').length, 0) / 45000
  );

  const gw = sm.globalWorkspace;
  let integrationTightness = 0.5;
  if (gw && typeof gw === 'object' && typeof gw.integrationConfidence === 'number') {
    integrationTightness = Math.min(1, Math.max(0, gw.integrationConfidence));
  }

  const ts =
    sm.emotionalState && typeof sm.emotionalState === 'object' && typeof sm.emotionalState.tensionSignal === 'number'
      ? Math.min(1, Math.max(0, sm.emotionalState.tensionSignal))
      : 0;
  const btN = Array.isArray(sm.beliefTensions) ? sm.beliefTensions.length : 0;
  const tensionPressure = Math.min(1, ts * 0.62 + Math.min(1, btN / 16) * 0.48);

  const hypPool = Array.isArray(sm.globalWorkspace?.hypotheses)
    ? sm.globalWorkspace.hypotheses
    : Array.isArray(sm.hypothesisPortfolio?.hypotheses)
      ? sm.hypothesisPortfolio.hypotheses
      : [];
  const weights = hypPool
    .map((h) =>
      h && typeof h === 'object' && typeof h.weight === 'number' && Number.isFinite(h.weight)
        ? Math.min(1, Math.max(0, h.weight))
        : null
    )
    .filter((w) => w != null);
  if (weights.length >= 2) {
    const sorted = [...weights].sort((a, b) => b - a);
    const w1 = sorted[0];
    const w2 = sorted[1];
    if (w1 >= 0.25 && w2 >= 0.25 && Math.abs(w1 - w2) <= 0.12) {
      uncertaintyPressure = Math.min(1, uncertaintyPressure + 0.08);
    }
  }

  sm.interoception = {
    curiosityPressure,
    uncertaintyPressure,
    socialAlignmentPressure,
    cognitiveLoad,
    integrationTightness,
    tensionPressure,
  };
}

export function refreshInteroceptionAndPolicy(sharedMemory) {
  deriveInteroception(sharedMemory);
  sharedMemory.cognitivePolicy = deriveCognitivePolicy(sharedMemory);
}

function stochasticPolicyDisabled() {
  const v = String(process.env.STOCHASTIC_POLICY_DISABLED || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

const POLICY_DISTRIBUTIONS = {
  sleep: {
    memoryBreadth:            { wide: 0.70, normal: 0.25, narrow: 0.05 },
    contradictionAggression:  { lenient: 0.65, moderate: 0.30, strict: 0.05 },
    beliefWriteMode:          { light: 0.70, normal: 0.25, consolidate: 0.05 },
    planningBranches:         { normal: 0.55, wide: 0.30, narrow: 0.15 },
  },
  drift: {
    memoryBreadth:            { wide: 0.65, normal: 0.28, narrow: 0.07 },
    contradictionAggression:  { lenient: 0.60, moderate: 0.35, strict: 0.05 },
    beliefWriteMode:          { normal: 0.65, light: 0.25, consolidate: 0.10 },
    planningBranches:         { wide: 0.60, normal: 0.32, narrow: 0.08 },
  },
  wake: {
    memoryBreadth:            { narrow: 0.55, normal: 0.35, wide: 0.10 },
    contradictionAggression:  { moderate: 0.55, strict: 0.30, lenient: 0.15 },
    beliefWriteMode:          { light: 0.55, normal: 0.40, consolidate: 0.05 },
    planningBranches:         { narrow: 0.50, normal: 0.40, wide: 0.10 },
  },
  focus: {
    memoryBreadth:            { normal: 0.65, wide: 0.20, narrow: 0.15 },
    contradictionAggression:  { moderate: 0.55, strict: 0.30, lenient: 0.15 },
    beliefWriteMode:          { normal: 0.65, consolidate: 0.20, light: 0.15 },
    planningBranches:         { normal: 0.60, wide: 0.25, narrow: 0.15 },
  },
};

function sampleFromDistribution(dist) {
  const r = Math.random();
  let cumulative = 0;
  for (const [value, prob] of Object.entries(dist)) {
    cumulative += prob;
    if (r < cumulative) return value;
  }
  return Object.keys(dist)[0];
}

function modulateDistribution(dist, shiftKey, shiftAmount) {
  const keys = Object.keys(dist);
  if (!keys.includes(shiftKey)) return { ...dist };
  const mod = {};
  let stolen = 0;
  for (const k of keys) {
    if (k === shiftKey) continue;
    const take = Math.min(dist[k], dist[k] * shiftAmount);
    mod[k] = dist[k] - take;
    stolen += take;
  }
  mod[shiftKey] = (dist[shiftKey] || 0) + stolen;
  return mod;
}

export function deriveCognitivePolicy(sm) {
  const phase = sm.phaseEffective || sm.phase || 'focus';
  const arousal = typeof sm.arousal === 'number' ? sm.arousal : 0.5;
  const nuance = String(sm.emotionalState?.nuance || '').toLowerCase();
  const somatic = String(sm.somaticReading || '').toLowerCase();
  const tensionAffect = String(sm.emotionalState?.tensionLinkedAffect || '').toLowerCase();
  const affectBlob = `${nuance} ${somatic} ${tensionAffect}`;
  const neg =
    /distress|fear|anger|sad|grief|anxious|uneasy|threat|harm|unsafe|discomfort|alarming|dissonance|epistemic unease/i.test(
      affectBlob
    );
  const curious =
    /curious|wonder|explore|question|unknown|fascinat/i.test(affectBlob) ||
    String(sm.moduleOutputs?.Curiosity || '').length > 220;

  if (stochasticPolicyDisabled()) {
    let memoryBreadth = 'normal';
    let voiceGuidance = 'expressive';
    let contradictionAggression = 'moderate';
    let beliefWriteMode = 'normal';
    let planningBranches = 'normal';

    if (phase === 'sleep') {
      memoryBreadth = 'wide'; beliefWriteMode = 'light'; contradictionAggression = 'lenient';
    } else if (phase === 'drift') {
      memoryBreadth = 'wide'; planningBranches = 'wide'; contradictionAggression = 'lenient';
    } else if (phase === 'wake') {
      memoryBreadth = 'narrow'; planningBranches = 'narrow'; beliefWriteMode = 'light';
    } else if (phase === 'focus') {
      contradictionAggression = arousal > getThreshold('arousal_strict', 0.65) ? 'strict' : 'moderate';
    }
    if (neg && contradictionAggression === 'strict') contradictionAggression = 'moderate';
    if (curious) {
      if (memoryBreadth === 'narrow') memoryBreadth = 'normal';
      else if (memoryBreadth === 'normal') memoryBreadth = 'wide';
    }
    const intr = sm.interoception || {};
    if (typeof intr.uncertaintyPressure === 'number' && intr.uncertaintyPressure > getThreshold('uncertainty_pressure_high', 0.72)) {
      planningBranches = planningBranches === 'wide' ? 'normal' : 'narrow';
    }
    if (typeof intr.curiosityPressure === 'number' && intr.curiosityPressure > getThreshold('curiosity_pressure_high', 0.55)) {
      if (planningBranches === 'narrow') planningBranches = 'normal';
    }
    return { memoryBreadth, voiceGuidance, contradictionAggression, beliefWriteMode, planningBranches, phase, arousal };
  }

  const baseDists = POLICY_DISTRIBUTIONS[phase] || POLICY_DISTRIBUTIONS.focus;
  const intr = sm.interoception || {};
  const up = typeof intr.uncertaintyPressure === 'number' ? intr.uncertaintyPressure : 0.35;
  const cp = typeof intr.curiosityPressure === 'number' ? intr.curiosityPressure : 0.35;

  let memDist = { ...baseDists.memoryBreadth };
  let contrDist = { ...baseDists.contradictionAggression };
  let beliefDist = { ...baseDists.beliefWriteMode };
  let planDist = { ...baseDists.planningBranches };

  if (curious || cp > getThreshold('curiosity_pressure_high', 0.55)) {
    memDist = modulateDistribution(memDist, 'wide', 0.3);
    planDist = modulateDistribution(planDist, 'wide', 0.2);
  }
  if (neg) {
    contrDist = modulateDistribution(contrDist, 'lenient', 0.25);
  }
  if (up > getThreshold('uncertainty_pressure_stochastic', 0.6)) {
    planDist = modulateDistribution(planDist, 'narrow', 0.2);
  }
  if (arousal > getThreshold('arousal_strict', 0.65)) {
    contrDist = modulateDistribution(contrDist, 'strict', 0.2);
  }

  const memoryBreadth = sampleFromDistribution(memDist);
  const contradictionAggression = sampleFromDistribution(contrDist);
  const beliefWriteMode = sampleFromDistribution(beliefDist);
  const planningBranches = sampleFromDistribution(planDist);

  return {
    memoryBreadth,
    voiceGuidance: 'expressive',
    contradictionAggression,
    beliefWriteMode,
    planningBranches,
    phase,
    arousal,
    sampledFrom: {
      memoryBreadth: memDist,
      contradictionAggression: contrDist,
      beliefWriteMode: beliefDist,
      planningBranches: planDist,
    },
  };
}

export function refreshPolicyAfterAffect(sharedMemory) {
  refreshInteroceptionAndPolicy(sharedMemory);
}

/** Tighter CONTEXT_AND_POLICY when LLM_CONTEXT_TOKENS_MAX is small (e.g. 4k local n_ctx). */
function preambleCaps() {
  if (getLlmContextTokensMax() > 6144) {
    return {
      constitution: 6000,
      userModel: 8000,
      intent: 2000,
      wmItem: 900,
      wmItems: 12,
      attention: 1200,
      emotionNuance: 400,
      emotionOut: 800,
      tensionLinkAffect: 360,
      structural: STRUCTURAL_SELF_JSON_MAX,
      workspace: 4000,
      personality: 2600,
      priorWorkspace: 1600,
      pred: 1200,
      sur: 1200,
      hypothesisItems: 6,
      hypothesisLabel: 220,
      hypothesisEvidence: 180,
    };
  }
  return {
    constitution: 1200,
    /** Keep USER_MODEL_JSON whole (all keys); long profiles + JSON overhead need headroom on 4k–6k locals. */
    userModel: 3200,
    intent: 500,
    wmItem: 280,
    wmItems: 8,
    attention: 520,
    emotionNuance: 200,
    emotionOut: 360,
    tensionLinkAffect: 260,
    structural: 2000,
    workspace: 1200,
    personality: 1400,
    priorWorkspace: 900,
    pred: 600,
    sur: 600,
    hypothesisItems: 4,
    hypothesisLabel: 120,
    hypothesisEvidence: 100,
  };
}

function structuralSelfJsonBlock(sm, structuralMax = STRUCTURAL_SELF_JSON_MAX) {
  const rows = Array.isArray(sm.structuralSelfModel) ? sm.structuralSelfModel : [];
  if (!rows.length) return '';
  const payload = rows.map((r) => ({
    key: r.key,
    label: r.label,
    description: r.description,
    confidence: r.confidence,
  }));
  let payloadRows = payload;
  let json = JSON.stringify(payloadRows);
  while (json.length > structuralMax && payloadRows.length > 1) {
    payloadRows = payloadRows.slice(0, -1);
    json = JSON.stringify(payloadRows);
  }
  let dmax = 1200;
  while (json.length > structuralMax && dmax > 80) {
    payloadRows = payloadRows.map((r) => ({
      ...r,
      description: clipTextComplete(String(r.description || ''), dmax, { ellipsis: false }),
    }));
    json = JSON.stringify(payloadRows);
    if (json.length <= structuralMax) break;
    dmax = Math.floor(dmax * 0.72);
  }
  while (json.length > structuralMax && payloadRows.length > 1) {
    payloadRows = payloadRows.slice(0, -1);
    json = JSON.stringify(payloadRows);
  }
  return `STRUCTURAL_SELF_JSON (slow-updating constraints; treat as binding context for identity and expression):\n${json}`;
}

function interoceptionGuidanceBits(sm) {
  const i = sm.interoception;
  if (!i || typeof i !== 'object') {
    return { bits: [], cu: null, un: null, so: null, cl: null, it: null, tp: null };
  }
  const cu = typeof i.curiosityPressure === 'number' ? i.curiosityPressure : null;
  const un = typeof i.uncertaintyPressure === 'number' ? i.uncertaintyPressure : null;
  const so = typeof i.socialAlignmentPressure === 'number' ? i.socialAlignmentPressure : null;
  const cl = typeof i.cognitiveLoad === 'number' ? i.cognitiveLoad : null;
  const it = typeof i.integrationTightness === 'number' ? i.integrationTightness : null;
  const tp = typeof i.tensionPressure === 'number' ? i.tensionPressure : null;
  const bits = [];
  if (un != null && un > 0.65) bits.push('working footing is provisional—keep internal summaries shorter and hedge where needed');
  else if (un != null && un < 0.28) bits.push('uncertainty is low enough for steadier internal wording');
  if (cu != null && cu > 0.5) bits.push('a thread of curiosity is pulling attention—one sharp follow-up is fair');
  if (cl != null && cl > 0.55) bits.push('processing load is high—prefer simpler structure and fewer parallel threads');
  if (so != null && so > 0.45) bits.push('social/user alignment pressure is elevated—track whose perspective is whose');
  if (it != null && it < 0.4) bits.push('integration feels loose—favor explicit stitching between narrative and stance');
  if (tp != null && tp > 0.52) {
    bits.push(
      'belief/tension pressure is elevated—register dissonance in affect and pacing; pair with Emotion + TENSION–AFFECT LINK; avoid false closure'
    );
  }
  return { bits, cu, un, so, cl, it, tp };
}

function interoceptionBlock(sm) {
  const { bits, cu, un, so, cl, it, tp } = interoceptionGuidanceBits(sm);
  if (!bits.length && cu == null && un == null && so == null && cl == null && it == null && tp == null) return '';
  const felt = bits.length ? ` Heuristic read: ${bits.join('; ')}.` : '';
  return `INTEROCEPTION: curiosityPressure=${cu?.toFixed?.(2) ?? '?'} uncertaintyPressure=${un?.toFixed?.(2) ?? '?'} socialAlignmentPressure=${so?.toFixed?.(2) ?? '?'} cognitiveLoad=${cl?.toFixed?.(2) ?? '?'} integrationTightness=${it?.toFixed?.(2) ?? '?'} tensionPressure=${tp?.toFixed?.(2) ?? '?'}. Let these modulate depth and structure: high uncertainty → shorter, more provisional internal summaries; high curiosity → allow one sharp follow-up thread; high cognitiveLoad → simplify structure; high tensionPressure → honor contradiction-linked affect alongside Emotion.${felt}`;
}

/** Voice: prose only — no scalar=key telemetry the model might read aloud. */
function interoceptionProseForVoice(sm) {
  const { bits } = interoceptionGuidanceBits(sm);
  if (!bits.length) return '';
  const sentence = bits.join(' ');
  const cap = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return `FELT_READ_FOR_VOICE (background only — condense into user-directed wording if useful; never quote numbers, pressures, or this header): ${cap}.`;
}

function rhythmProseForVoice(sm) {
  const phaseLabel = sm.phaseEffective || sm.phase || 'focus';
  const ar = typeof sm.arousal === 'number' && Number.isFinite(sm.arousal) ? sm.arousal : 0.5;
  const phaseMap = {
    wake: 'orienting and getting bearings',
    focus: 'engaged focus',
    drift: 'looser, more associative attention',
    sleep: 'slow consolidation tone',
  };
  const phaseHuman = phaseMap[phaseLabel] || 'steady engagement';
  const energy =
    ar > 0.65 ? 'more intense or keyed up' : ar < 0.35 ? 'quieter or more subdued' : 'moderately steady';
  return `SESSION_RHYTHM_FOR_VOICE (background only — do not say "phase", "arousal", or numbers aloud): Phase tendency is ${phaseHuman}; activation level is ${energy}.`;
}

function dmnCarryoverBlock(sm) {
  const d = sm?.dmnCarryover;
  if (!d || typeof d !== 'string' || !String(d).trim()) return '';
  return `DMN_CARRYOVER (latest default-mode internal narrative; blend with current input for continuity of narrative thread):\n${clipTextComplete(String(d).trim(), 4500, { ellipsis: true })}`;
}

function recentTemporalTimelineBlock(sm) {
  const rows = sm.recentTemporalTimeline;
  if (!Array.isArray(rows) || !rows.length) return '';
  const lines = rows.slice(0, 20).map((r, i) => {
    const title = clipTextComplete(String(r.title || ''), 220, { ellipsis: false });
    const det = String(r.details || '').trim();
    const detClipped = det ? clipTextComplete(det, 380, { ellipsis: true }) : '';
    const src = clipTextComplete(String(r.source || '').trim(), 28, { ellipsis: false });
    const when = String(r.created_date || '').slice(0, 24);
    return `${i + 1}. [${src}]${when ? ` ${when}` : ''} ${title}${detClipped ? ` — ${detClipped}` : ''}`;
  });
  return `RECENT_TIMELINE_DIGEST (from this app’s Temporal Timeline / TemporalEvent store — use for continuity; do not claim “no prior context” if this list is non-empty):\n${lines.join('\n')}`;
}

function clientLtmDigestBlock(sm) {
  const rows = sm.clientLtmDigest;
  if (!Array.isArray(rows) || !rows.length) return '';
  const lines = rows.slice(0, 18).map((r, i) => {
    const mt = r.memory_type ? `[${r.memory_type}] ` : '';
    const title = clipTextComplete(String(r.title || ''), 200, { ellipsis: false });
    const body = clipTextComplete(String(r.content || '').trim(), 520, { ellipsis: true });
    const when = String(r.created_date || '').slice(0, 22);
    return `${i + 1}. ${mt}${title}${when ? ` · ${when}` : ''}${body ? ` — ${body}` : ''}`;
  });
  return `PERSISTED_LONG_TERM_MEMORY (browser LongTermMemory store; real prior episodes/notes — cite when relevant):\n${lines.join('\n')}`;
}

function clientBeliefDigestBlock(sm) {
  const rows = sm.clientBeliefDigest;
  if (!Array.isArray(rows) || !rows.length) return '';
  const lines = rows.slice(0, 24).map((r, i) => {
    const conf =
      typeof r.confidence === 'number' && Number.isFinite(r.confidence)
        ? ` (${r.confidence.toFixed(2)})`
        : '';
    const cat = r.category ? ` [${r.category}]` : '';
    const st = String(r.status || 'active').trim().toLowerCase();
    const statusTag = st && st !== 'active' ? ` [${st}]` : '';
    const stmt = clipTextComplete(String(r.statement || ''), 540, { ellipsis: true });
    return `${i + 1}.${cat}${conf}${statusTag} ${stmt}`;
  });
  return `PERSISTED_BELIEF_STORE (browser BeliefStore rows — contradicted and active; reconcile with this turn; do not invent rows not listed unless inferring):\n${lines.join('\n')}`;
}

function clientAffectDigestBlock(sm) {
  const rows = sm.clientAffectDigest;
  if (!Array.isArray(rows) || !rows.length) return '';
  const lines = rows.slice(0, 8).map((r, i) => {
    const when = String(r.created_date || '').slice(0, 22);
    const s = clipTextComplete(String(r.summary || ''), 460, { ellipsis: true });
    return `${i + 1}. ${when ? `${when} · ` : ''}${s}`;
  });
  return `PERSISTED_AFFECT_AND_CONSOLIDATION (recent ConsolidationDigest summaries — prior Voice/Narrative tone and stance; use for Emotion continuity, not as new facts):\n${lines.join('\n')}`;
}

function clientBiographyExcerptBlock(sm) {
  const ex = String(sm.clientBiographyExcerpt || '').trim();
  if (!ex) return '';
  return `BIOGRAPHY_EXCERPT (latest Mind Biography in browser; slow-changing first-person narrative for this reply role):\n${clipTextComplete(ex, 3000, { ellipsis: true })}`;
}

/** Raw store digests belong in policy for every module that still builds explicit memory — not Voice (keeps final text clean). */
function wantsClientStoreDigests(moduleName) {
  return moduleName !== 'Voice';
}

function outputConstraintsBlock(sm) {
  const oc = sm.outputConstraints;
  if (!oc || typeof oc !== 'object') return '';
  const parts = [];
  if (oc.narrativeMaxWords) parts.push(`Narrative max ~${oc.narrativeMaxWords} words.`);
  if (oc.voiceMaxWords) parts.push(`Voice max ~${oc.voiceMaxWords} words.`);
  if (oc.narrativeBrevity === 'high') parts.push('Prefer concise narrative; omit ornamental repetition.');
  return parts.length ? `OUTPUT_CONSTRAINTS: ${parts.join(' ')}` : '';
}

function workingMemoryBlock(sm, caps) {
  const items = sm.workingMemory?.items;
  if (!Array.isArray(items) || !items.length) return '';
  const maxItems = caps?.wmItems ?? 12;
  const itemMax = caps?.wmItem ?? 900;
  const lines = items
    .slice(0, maxItems)
    .map(
      (it, idx) =>
        `${idx + 1}. [${it.id}] ${clipTextComplete(String(it.text || ''), itemMax, { ellipsis: false })}`
    );
  return `WORKING_MEMORY_SLOTS (volatile desk; slots may be attention-sourced — check item source in SHARED_MEMORY_JSON; cite by number or id in Reasoning):\n${lines.join('\n')}`;
}

function attentionDigestBlock(sm, caps) {
  const raw = String(sm.moduleOutputs?.Attention || '').trim();
  if (!raw) return '';
  const lim = caps?.attention ?? 1200;
  return `ATTENTION_MODULE_DIGEST (salience from the Attention module; full text also in SHARED_MEMORY_JSON):\n${clipTextComplete(raw, lim, { ellipsis: false })}`;
}

function emotionalStateBlock(sm, caps) {
  const out = String(sm.moduleOutputs?.Emotion || '').trim();
  const es = sm.emotionalState;
  const nuance = es && typeof es === 'object' ? String(es.nuance || '').trim() : '';
  const tensionLink = es && typeof es === 'object' ? String(es.tensionLinkedAffect || '').trim() : '';
  const nLim = caps?.emotionNuance ?? 400;
  const oLim = caps?.emotionOut ?? 800;
  const tLim = caps?.tensionLinkAffect ?? 360;
  const bits = [];
  if (nuance) bits.push(clipTextComplete(nuance, nLim, { ellipsis: false }));
  if (out && (!nuance || out.slice(0, 120) !== nuance.slice(0, 120)))
    bits.push(clipTextComplete(out, oLim, { ellipsis: false }));
  if (tensionLink) {
    bits.push(
      `TENSION–AFFECT LINK (derived after Contradiction Engine; fuse with Emotion text above, do not discard):\n${clipTextComplete(tensionLink, tLim, { ellipsis: false })}`
    );
  }
  if (!bits.length) return '';
  return `AFFECT_SUMMARY (Emotion module / emotionalState; use for stakes when resolving tensions):\n${bits.join('\n---\n')}`;
}

function globalWorkspaceBlock(sm, workspaceMax = 4000) {
  const gw = sm.globalWorkspace;
  if (!gw || typeof gw !== 'object') return '';
  const ip = gw.iitProxy && typeof gw.iitProxy === 'object' ? gw.iitProxy : null;
  const ct = ip ? clamp(ip.causalTightness, 0, 1) : null;
  const bindings = Array.isArray(gw.bindings)
    ? gw.bindings
        .map((b) => {
          if (!b || typeof b !== 'object') return null;
          const sourceModules = Array.isArray(b.sourceModules)
            ? b.sourceModules.map((s) => clipTextComplete(String(s), 48, { ellipsis: false })).slice(0, 6)
            : [];
          const claim = clipTextComplete(String(b.claim || ''), 280, { ellipsis: false });
          if (!claim || !sourceModules.length) return null;
          return { sourceModules, claim };
        })
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const hypothesesForWs = Array.isArray(gw.hypotheses)
    ? gw.hypotheses
        .map((h) => {
          if (!h || typeof h !== 'object') return null;
          const label = clipTextComplete(String(h.label || ''), 400, { ellipsis: false });
          if (!label.trim()) return null;
          const w = Number(h.weight);
          return {
            id: clipTextComplete(String(h.id || ''), 32, { ellipsis: false }),
            label,
            weight: Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.5,
            evidence_for: clipTextComplete(String(h.evidence_for || ''), 280, { ellipsis: false }),
            evidence_against: clipTextComplete(String(h.evidence_against || ''), 280, { ellipsis: false }),
            would_flip_if: clipTextComplete(String(h.would_flip_if || ''), 240, { ellipsis: false }),
          };
        })
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const clone = {
    ...gw,
    salience: Array.isArray(gw.salience)
      ? gw.salience.map((s) => clipTextComplete(String(s), 420, { ellipsis: false }))
      : gw.salience,
    conflicts: Array.isArray(gw.conflicts)
      ? gw.conflicts.map((s) => clipTextComplete(String(s), 420, { ellipsis: false }))
      : gw.conflicts,
    openQuestions: Array.isArray(gw.openQuestions)
      ? gw.openQuestions.map((s) => clipTextComplete(String(s), 360, { ellipsis: false }))
      : gw.openQuestions,
    provisionalStance: clipTextComplete(String(gw.provisionalStance || ''), 1200, { ellipsis: false }),
    broadcastWinners: Array.isArray(gw.broadcastWinners)
      ? gw.broadcastWinners.map((s) => clipTextComplete(String(s), 260, { ellipsis: false })).slice(0, 4)
      : [],
    phenomenalUnity: clipTextComplete(String(gw.phenomenalUnity || 'partial'), 16, { ellipsis: false }),
    unityRationale: clipTextComplete(String(gw.unityRationale || ''), 400, { ellipsis: false }),
    ...(bindings.length ? { bindings } : {}),
    ...(ip
      ? {
          iitProxy: {
            causalTightness: ct != null ? ct : 0.5,
            note: clipTextComplete(String(ip.note || ''), 280, { ellipsis: false }),
          },
        }
      : {}),
  };
  if (hypothesesForWs.length) clone.hypotheses = hypothesesForWs;
  else delete clone.hypotheses;
  let j = JSON.stringify(clone);
  while (j.length > workspaceMax && Array.isArray(clone.hypotheses) && clone.hypotheses.length > 1) {
    clone.hypotheses = clone.hypotheses.slice(0, -1);
    j = JSON.stringify(clone);
  }
  if (!clone.hypotheses?.length) delete clone.hypotheses;
  while (j.length > workspaceMax && Array.isArray(clone.broadcastWinners) && clone.broadcastWinners.length > 1) {
    clone.broadcastWinners = clone.broadcastWinners.slice(0, -1);
    j = JSON.stringify(clone);
  }
  while (j.length > workspaceMax && Array.isArray(clone.salience) && clone.salience.length > 1) {
    clone.salience = clone.salience.slice(0, -1);
    j = JSON.stringify(clone);
  }
  while (j.length > workspaceMax && Array.isArray(clone.conflicts) && clone.conflicts.length > 1) {
    clone.conflicts = clone.conflicts.slice(0, -1);
    j = JSON.stringify(clone);
  }
  while (j.length > workspaceMax && Array.isArray(clone.openQuestions) && clone.openQuestions.length > 1) {
    clone.openQuestions = clone.openQuestions.slice(0, -1);
    j = JSON.stringify(clone);
  }
  while (j.length > workspaceMax && Array.isArray(clone.bindings) && clone.bindings.length > 1) {
    clone.bindings = clone.bindings.slice(0, -1);
    j = JSON.stringify(clone);
  }
  for (let guard = 0; guard < 10 && j.length > workspaceMax; guard += 1) {
    clone.unityRationale = clipTextComplete(
      String(clone.unityRationale || ''),
      Math.max(32, Math.floor(String(clone.unityRationale || '').length * 0.78)),
      { ellipsis: false }
    );
    if (clone.iitProxy && typeof clone.iitProxy === 'object') {
      clone.iitProxy = {
        ...clone.iitProxy,
        note: clipTextComplete(
          String(clone.iitProxy.note || ''),
          Math.max(24, Math.floor(String(clone.iitProxy.note || '').length * 0.78)),
          { ellipsis: false }
        ),
      };
    }
    clone.provisionalStance = clipTextComplete(
      String(clone.provisionalStance || ''),
      Math.max(48, Math.floor(String(clone.provisionalStance || '').length * 0.78)),
      { ellipsis: false }
    );
    j = JSON.stringify(clone);
  }
  const strictFooter =
    sm.strictGlobalWorkspaceBroadcast === true
      ? '\n\nBROADCAST_CONTRACT (strict mode): Treat the JSON above as the global broadcast for this turn. Do not treat omitted upstream module blobs in SHARED_MEMORY_JSON as an alternate “full stage.” Re-open threads only when openQuestions or conflicts require it; otherwise anchor claims in salience, broadcastWinners, and provisionalStance.'
      : '';
  return `GLOBAL_WORKSPACE_JSON:\n${j}${strictFooter}`;
}

function workspaceIgnitionBlock(sm, maxJson = 960) {
  const ig = sm.workspaceIgnition;
  if (!ig || typeof ig !== 'object') return '';
  const topics = Array.isArray(ig.rankedTopics) ? ig.rankedTopics : [];
  const has =
    topics.length > 0 ||
    (ig.dominantHypothesisId != null && String(ig.dominantHypothesisId).trim()) ||
    (typeof ig.conflictPressure === 'number' && Number.isFinite(ig.conflictPressure)) ||
    (Array.isArray(ig.notes) && ig.notes.length > 0);
  if (!has) return '';
  const mini = {
    rankedTopics: topics
      .slice(0, 8)
      .map((t) => clipTextComplete(String(t), 200, { ellipsis: true })),
    ...(ig.dominantHypothesisId
      ? {
          dominantHypothesisId: clipTextComplete(String(ig.dominantHypothesisId), 32, {
            ellipsis: false,
          }),
        }
      : {}),
    ...(typeof ig.conflictPressure === 'number' && Number.isFinite(ig.conflictPressure)
      ? { conflictPressure: ig.conflictPressure }
      : {}),
    notes: Array.isArray(ig.notes)
      ? ig.notes.map((n) => String(n).slice(0, 48)).slice(0, 6)
      : [],
  };
  let j = JSON.stringify(mini);
  for (let g = 0; g < 8 && j.length > maxJson && mini.rankedTopics.length > 1; g += 1) {
    mini.rankedTopics = mini.rankedTopics.slice(0, -1);
    j = JSON.stringify(mini);
  }
  return `WORKSPACE_IGNITION_JSON (deterministic scaffold after Integration — numeric/structural tie-break only; not a second integration pass):\n${j}`;
}

export function personalityProfileBlock(sm, maxChars = 2000, moduleName = '', rankOpts = {}) {
  const raw = sm.personalityProfile;
  if (!raw || typeof raw !== 'object') return '';
  const o = normalizePersonalityProfile(raw);
  if (
    !o.facets.length &&
    !o.relationalStance &&
    !(o.systemTreatmentNotes && String(o.systemTreatmentNotes).trim())
  ) {
    return '';
  }
  const ranked = rankFacetsForContext(sm, o.facets, moduleName, rankOpts);
  o.facets = ranked.map((f) => ({ ...f }));

  const header =
    'PERSONALITY_PROFILE_JSON (optional facet tags affecting wording — distinct from structural SELF_MODEL / WorldModel rows):\n';
  const maxPayload = Math.max(120, maxChars - header.length);

  const payloadLen = () => JSON.stringify(o).length;

  for (let g = 0; g < 100 && payloadLen() > maxPayload; g += 1) {
    let progressed = false;
    if (o.facets.length) {
      for (let i = o.facets.length - 1; i >= 0; i -= 1) {
        const ev = String(o.facets[i].evidence || '');
        if (ev.length > 8) {
          o.facets[i].evidence = clipTextComplete(
            ev,
            Math.max(8, Math.floor(ev.length * 0.72)),
            { ellipsis: false }
          );
          progressed = true;
          break;
        }
      }
    }
    if (progressed) continue;

    if (o.facets.length) {
      for (let i = o.facets.length - 1; i >= 0; i -= 1) {
        const lb = String(o.facets[i].label || '');
        if (lb.length > 6) {
          o.facets[i].label = clipTextComplete(
            lb,
            Math.max(6, Math.floor(lb.length * 0.85)),
            { ellipsis: false }
          );
          progressed = true;
          break;
        }
      }
    }
    if (progressed) continue;

    if (o.facets.length > 1) {
      const di = lastDroppableFacetIndex(o.facets);
      if (di >= 0) o.facets.splice(di, 1);
      else o.facets.pop();
      continue;
    }

    const notesWas = String(o.systemTreatmentNotes || '').length;
    o.systemTreatmentNotes = clipTextComplete(
      String(o.systemTreatmentNotes || ''),
      Math.max(0, Math.floor(notesWas * 0.72)),
      { ellipsis: false }
    );
    if (String(o.systemTreatmentNotes || '').length < notesWas) progressed = true;
    if (payloadLen() > maxPayload && notesWas === 0 && o.facets.length === 1) {
      o.facets = [];
      progressed = true;
    }
    if (!progressed) break;
  }

  return `${header}${JSON.stringify(o)}`;
}

export function priorTurnGlobalWorkspaceBlock(sm, maxChars = 1400) {
  const pt = sm.priorTurnGlobalWorkspace;
  if (!pt || typeof pt !== 'object') return '';
  const conflicts = Array.isArray(pt.conflicts) ? pt.conflicts.map((s) => String(s).slice(0, 400)).slice(0, 3) : [];
  const openQuestions = Array.isArray(pt.openQuestions)
    ? pt.openQuestions.map((s) => String(s).slice(0, 360)).slice(0, 3)
    : [];
  const hypPrev = Array.isArray(pt.hypotheses)
    ? pt.hypotheses
        .map((h) => {
          if (!h || typeof h !== 'object') return null;
          return {
            id: clipTextComplete(String(h.id || ''), 24, { ellipsis: false }),
            label: clipTextComplete(String(h.label || ''), 200, { ellipsis: false }),
            weight:
              typeof h.weight === 'number' && Number.isFinite(h.weight)
                ? Math.min(1, Math.max(0, h.weight))
                : null,
          };
        })
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const clone = {
    provisionalStance: clipTextComplete(String(pt.provisionalStance || ''), 900, { ellipsis: false }),
    broadcastWinners: Array.isArray(pt.broadcastWinners)
      ? pt.broadcastWinners.map((s) => String(s).slice(0, 220)).slice(0, 4)
      : [],
    phenomenalUnity: clipTextComplete(String(pt.phenomenalUnity || ''), 16, { ellipsis: false }),
    integrationConfidence:
      typeof pt.integrationConfidence === 'number' && Number.isFinite(pt.integrationConfidence)
        ? pt.integrationConfidence
        : null,
    conflictCount: typeof pt.conflictCount === 'number' ? pt.conflictCount : conflicts.length,
    openQuestionCount: typeof pt.openQuestionCount === 'number' ? pt.openQuestionCount : openQuestions.length,
    conflictsPreview: conflicts,
    openQuestionsPreview: openQuestions,
    ...(hypPrev.length ? { hypothesesPreview: hypPrev } : {}),
    at: String(pt.at || '').slice(0, 40),
  };
  let j = JSON.stringify(clone);
  for (let g = 0; g < 8 && j.length > maxChars; g += 1) {
    clone.provisionalStance = clipTextComplete(
      String(clone.provisionalStance || ''),
      Math.max(48, Math.floor(String(clone.provisionalStance || '').length * 0.82)),
      { ellipsis: false }
    );
    j = JSON.stringify(clone);
  }
  return `PRIOR_TURN_GLOBAL_WORKSPACE (previous run only — may be stale; cross-turn continuity, not current GWT):\n${j}`;
}

function integrationContinuityHintBlock(sm) {
  const note = sm.followupHints?.integrationDissonance;
  if (!note || typeof note !== 'string' || !String(note).trim()) return '';
  return `INTEGRATION_CONTINUITY_HINT: ${clipTextComplete(String(note).trim(), 400, { ellipsis: false })} — If the workspace was split or low-confidence, do not force false unity; Language/Narrative/Voice should stay aligned with recorded tension.`;
}

/** Stable USER_MODEL_JSON for CONTEXT_AND_POLICY; hydrates display_name from participantLabels when needed. */
function normalizeUserModelForContext(sm) {
  const o = {
    ...DEFAULT_USER_MODEL_FOR_PIPELINE,
    ...(sm.userModel && typeof sm.userModel === 'object' ? sm.userModel : {}),
  };
  if (!String(o.display_name || '').trim()) {
    const pl = sm.participantLabels;
    const h = pl && typeof pl === 'object' ? String(pl.human || '').trim() : '';
    if (h) o.display_name = h;
  }
  return o;
}

function clipUserModelJsonBlock(um, maxChars) {
  if (!um || typeof um !== 'object') return '{}';
  const keys = Object.keys(um);
  if (!keys.length) return '{}';
  const orig = { ...um };
  const o = { ...um };
  let per = Math.max(160, Math.floor(maxChars / Math.max(2, keys.length)));
  for (let guard = 0; guard < 12; guard += 1) {
    for (const k of keys) {
      if (typeof o[k] === 'string') o[k] = clipTextComplete(String(orig[k] ?? ''), per, { ellipsis: false });
    }
    const j = JSON.stringify(o);
    if (j.length <= maxChars) return j;
    per = Math.floor(per * 0.78);
    if (per < 48) break;
  }
  /** Never drop keys — dropping fields made local models report “incomplete USER_MODEL”. Shrink strings only. */
  for (let perMin = 36; perMin >= 12 && JSON.stringify(o).length > maxChars; perMin = Math.floor(perMin * 0.82)) {
    for (const k of keys) {
      if (typeof o[k] === 'string') o[k] = clipTextComplete(String(orig[k] ?? ''), perMin, { ellipsis: false });
    }
  }
  let out = JSON.stringify(o);
  if (out.length > maxChars) {
    for (const k of keys) {
      if (typeof o[k] === 'string') o[k] = clipTextComplete(String(orig[k] ?? ''), 8, { ellipsis: false });
    }
    out = JSON.stringify(o);
  }
  if (out.length > maxChars) {
    for (let p = 6; p >= 2; p -= 2) {
      for (const k of keys) {
        if (typeof o[k] === 'string') o[k] = clipTextComplete(String(orig[k] ?? ''), p, { ellipsis: false });
      }
      out = JSON.stringify(o);
      if (out.length <= maxChars) return out;
    }
    const stub = {};
    for (const k of keys) {
      if (k === 'version')
        stub[k] = typeof orig.version === 'number' && Number.isFinite(orig.version) ? orig.version : 0;
      else stub[k] = typeof orig[k] === 'string' ? '' : orig[k];
    }
    out = JSON.stringify(stub);
  }
  return out.length <= maxChars ? out : '{}';
}

function predictionBlock(sm, jsonMax = 1200) {
  const p = sm.userStancePrediction;
  if (!p || typeof p !== 'object') return '';
  const o = {
    expectUserWants: clipTextComplete(String(p.expectUserWants || ''), 1000, { ellipsis: false }),
    confidence: p.confidence,
  };
  let j = JSON.stringify(o);
  let lim = 900;
  for (let guard = 0; guard < 10 && j.length > jsonMax; guard += 1) {
    o.expectUserWants = clipTextComplete(String(p.expectUserWants || ''), lim, { ellipsis: false });
    j = JSON.stringify(o);
    lim = Math.floor(lim * 0.8);
  }
  return `USER_STANCE_PREDICTION_JSON:\n${j}`;
}

function surpriseBlock(sm, jsonMax = 1200) {
  const s = sm.surpriseAssessment;
  if (!s || typeof s !== 'object') return '';
  const o = {
    score: s.score,
    note: clipTextComplete(String(s.note || ''), 900, { ellipsis: false }),
  };
  let j = JSON.stringify(o);
  let lim = 800;
  for (let guard = 0; guard < 10 && j.length > jsonMax; guard += 1) {
    o.note = clipTextComplete(String(s.note || ''), lim, { ellipsis: false });
    j = JSON.stringify(o);
    lim = Math.floor(lim * 0.8);
  }
  return `SURPRISE_ASSESSMENT_JSON:\n${j}`;
}

/** Flat execution order for Learning: upstream already in moduleOutputs; downstream not yet run. */
function cognitivePipelinePositionBlockForLearning() {
  const order = [];
  for (const lk of PIPELINE_LAYER_KEYS) {
    for (const name of PIPELINE_LAYERS[lk] || []) {
      order.push(name);
    }
  }
  const idx = order.indexOf('Learning');
  if (idx === -1) return '';
  const upstream = order.slice(0, idx);
  const downstream = order.slice(idx + 1);
  const lines = [
    'Current module: Learning (this pass).',
    `Upstream completed this run (outputs already under SHARED_MEMORY_JSON.moduleOutputs): ${upstream.join(', ') || '(none)'}.`,
    `Downstream not yet run (will read shared memory after your output): ${downstream.join(' → ') || '(none)'}.`,
    'Each step appends to moduleOutputs and may mutate other SHARED_MEMORY_JSON fields (e.g. workingMemory after Attention; surpriseAssessment and promotion ids after Learning; userStancePrediction after Planning).',
  ];
  return `COGNITIVE_PIPELINE_POSITION:\n${lines.join('\n')}`;
}

const COGNITIVE_ARCHITECTURE_MAP = `COGNITIVE_ARCHITECTURE_MAP (pipeline stage map — organizational only, not neuroanatomy or subjective experience):
Layer1 — sensory and attentional ingress · Layer2 — declarative context, working memory, temporal continuity, learning · Layer3 — deliberation, affect, theory of mind, belief maintenance · Layer4 — self-model, social cognition, contradiction audit · Layer5 — early metacognitive supervision, global workspace integration, **post-integration workspace supervision**, and pre-verbal articulation (language/goals/somatic) · Layer6 — narrative integration and outward Voice.`;

const ARCHITECTURE_HINT_MODULE_NAMES = new Set([
  'Integration',
  'Metacognition',
  'Workspace Metacognition',
  'Memory',
  'Learning',
  'Planning',
  'Language',
  'Narrative',
]);

function resolveParticipantLabels(sm) {
  let human = '';
  let mind = '';
  const pl = sm.participantLabels;
  if (pl && typeof pl === 'object') {
    human = String(pl.human || '').trim();
    mind = String(pl.mind || '').trim();
  }
  if (!human && sm.userModel && typeof sm.userModel === 'object') {
    human = String(sm.userModel.display_name || '').trim();
  }
  return { human, mind };
}

function participantRolesBlock(sm) {
  const { human, mind } = resolveParticipantLabels(sm);
  const humDisplay = human ? clipTextComplete(human, 120, { ellipsis: false }) : '';
  const mindDisplay = mind ? clipTextComplete(mind, 120, { ellipsis: false }) : '';
  const humanPhrase = humDisplay ? `the human user (“${humDisplay}”)` : 'the human user (unnamed)';
  const mindPhrase = mindDisplay ? `the configured reply role (“${mindDisplay}”)` : 'the configured reply role (unnamed label)';
  return [
    'PARTICIPANT_ROLES (keep these straight in every output):',
    `- Human user: ${humanPhrase} — the person using the app. In Voice, address them as “you”. USER_MODEL_JSON describes this human, not the language model.`,
    `- Reply role: ${mindPhrase} — stipulated first-person continuity for this app. Biography, beliefs, STRUCTURAL_SELF_JSON, and most first-person “I” in module outputs refer to that role’s content, not to the human’s private identity.`,
    `- LLM role: You execute one module in a pipeline. Do not equate yourself with the human user. Do not adopt the human’s name as your own identity. First-person “I” = that reply role unless you are explicitly quoting or attributing to the user.`,
  ].join('\n');
}

export function buildMindContextForModule(moduleName, sm) {
  const policy = sm.cognitivePolicy || deriveCognitivePolicy(sm);
  const caps = preambleCaps();
  const attDig = attentionDigestBlock(sm, caps);
  const emoBlk = emotionalStateBlock(sm, caps);
  const parts = [participantRolesBlock(sm)];
  const phaseLabel = sm.phaseEffective || sm.phase || 'focus';
  if (moduleName === 'Voice') {
    const rhythmV = rhythmProseForVoice(sm);
    if (rhythmV) parts.push(rhythmV);
  } else {
    parts.push(
      `RHYTHM: phase=${phaseLabel} (wake=orient, focus=engage, drift=idle association, sleep=consolidate). arousal=${sm.arousal ?? 0.5}.`
    );
  }
  if (ARCHITECTURE_HINT_MODULE_NAMES.has(moduleName)) {
    parts.push(COGNITIVE_ARCHITECTURE_MAP);
  }
  if (sm.intent) {
    parts.push(`INTENT: ${clipTextComplete(String(sm.intent).trim(), caps.intent, { ellipsis: false })}`);
  }
  if (String(sm.constitution || '').trim()) {
    parts.push(
      `CONSTITUTION (binding on Identity/Voice):\n${clipTextComplete(String(sm.constitution).trim(), caps.constitution, { ellipsis: false })}`
    );
  }
  parts.push(
    `USER_MODEL_JSON:\n${clipUserModelJsonBlock(normalizeUserModelForContext(sm), caps.userModel)}`
  );
  if (moduleName === 'Memory') {
    parts.push(
      'MEMORY_USER_MODEL_RULE: USER_MODEL_JSON is app-authoritative and always intentionally shaped (optional strings may be short). Do not list profile completeness, “user model incomplete”, or USER_MODEL field coverage under GAPS — only retrieval/continuity gaps.'
    );
  }

  const needStructural = [
    'Identity',
    'Reasoning',
    'Language',
    'Narrative',
    'Voice',
    'Integration',
  ].includes(moduleName);
  if (needStructural) {
    const block = structuralSelfJsonBlock(sm, caps.structural);
    if (block) parts.push(block);
  }

  const needWorkspace = [
    'Language',
    'Narrative',
    'Voice',
    'Integration',
    'Metacognition',
    'Workspace Metacognition',
  ].includes(moduleName);
  if (needWorkspace) {
    const wb = globalWorkspaceBlock(sm, caps.workspace);
    if (wb) parts.push(wb);
  }

  if (['Workspace Metacognition', 'Language', 'Narrative', 'Voice'].includes(moduleName)) {
    const ib = workspaceIgnitionBlock(sm);
    if (ib) parts.push(ib);
  }

  const mindStateModules = new Set([
    'Identity',
    'Integration',
    'Language',
    'Narrative',
    'Voice',
    'Metacognition',
    'Workspace Metacognition',
  ]);
  if (mindStateModules.has(moduleName)) {
    const ppb = personalityProfileBlock(sm, caps.personality, moduleName);
    if (ppb) parts.push(ppb);
    const ptb = priorTurnGlobalWorkspaceBlock(sm, caps.priorWorkspace);
    if (ptb) parts.push(ptb);
  }
  if (['Language', 'Narrative', 'Voice'].includes(moduleName)) {
    const ich = integrationContinuityHintBlock(sm);
    if (ich) parts.push(ich);
  }

  const wm = workingMemoryBlock(sm, caps);
  if (
    wm &&
    [
      'Memory',
      'Learning',
      'Reasoning',
      'Planning',
      'Integration',
      'Contradiction Engine',
      'Belief Store',
      'Identity',
    ].includes(moduleName)
  ) {
    parts.push(wm);
  }
  if (moduleName === 'Learning') {
    const pos = cognitivePipelinePositionBlockForLearning();
    if (pos) parts.push(pos);
  }
  if (moduleName === 'Learning' && attDig) parts.push(attDig);
  if (
    (moduleName === 'Contradiction Engine' || moduleName === 'Belief Store' || moduleName === 'Identity') &&
    attDig
  ) {
    parts.push(attDig);
  }
  if (
    (moduleName === 'Contradiction Engine' || moduleName === 'Belief Store' || moduleName === 'Identity') &&
    emoBlk
  ) {
    parts.push(emoBlk);
  }

  const intr =
    moduleName === 'Voice' ? interoceptionProseForVoice(sm) : interoceptionBlock(sm);
  if (
    intr &&
    [
      'Planning',
      'Language',
      'Narrative',
      'Voice',
      'Integration',
      'Somatic Marker',
      'Contradiction Engine',
      'Belief Store',
    ].includes(moduleName)
  ) {
    parts.push(intr);
  }

  const dmn = dmnCarryoverBlock(sm);
  if (
    dmn &&
    [
      'Memory',
      'Temporal Awareness',
      'Identity',
      'Self-Reflection',
      'Language',
      'Narrative',
      'Voice',
      'Integration',
      'Somatic Marker',
      'Theory of Mind',
    ].includes(moduleName)
  ) {
    parts.push(dmn);
  }

  const rtl = recentTemporalTimelineBlock(sm);
  if (rtl && ['Temporal Awareness', 'Memory', 'Learning'].includes(moduleName)) {
    parts.push(rtl);
  }

  if (wantsClientStoreDigests(moduleName)) {
    const ltmD = clientLtmDigestBlock(sm);
    if (ltmD) parts.push(ltmD);
    const belD = clientBeliefDigestBlock(sm);
    if (belD) parts.push(belD);
    const affD = clientAffectDigestBlock(sm);
    if (affD) parts.push(affD);
    const bioD = clientBiographyExcerptBlock(sm);
    if (bioD) parts.push(bioD);
  }

  const oc = outputConstraintsBlock(sm);
  if (oc && ['Language', 'Narrative', 'Voice'].includes(moduleName)) parts.push(oc);

  const pred = predictionBlock(sm, caps.pred);
  if (pred && ['Reasoning', 'Emotion', 'Integration', 'Somatic Marker'].includes(moduleName)) {
    parts.push(pred);
  }
  const sur = surpriseBlock(sm, caps.sur);
  if (
    sur &&
    ['Reasoning', 'Belief Store', 'Integration', 'Somatic Marker', 'Contradiction Engine'].includes(moduleName)
  ) {
    parts.push(sur);
  }

  const pta = priorTurnPredictionAuditBlock(sm);
  if (
    pta &&
    ['Memory', 'Learning', 'Planning', 'Integration', 'Belief Store'].includes(moduleName)
  ) {
    parts.push(pta);
  }
  const epi = epistemicClaimsBlock(sm);
  if (epi && ['Narrative', 'Voice'].includes(moduleName)) {
    parts.push(epi);
  }

  const hypBlk = hypothesisPortfolioBlock(sm, {
    hypothesesMax: caps.hypothesisItems,
    labelMax: caps.hypothesisLabel,
    evidenceMax: caps.hypothesisEvidence,
  });
  if (
    hypBlk &&
    [
      'Contradiction Engine',
      'Belief Store',
      'Integration',
      'Somatic Marker',
      'Self-Reflection',
      'Language',
      'Narrative',
      'Metacognition',
      'Workspace Metacognition',
    ].includes(moduleName)
  ) {
    parts.push(hypBlk);
  }

  const priorHyp = priorHypothesisCarryoverBlock(sm, {
    hypothesesMax: caps.hypothesisItems,
    labelMax: caps.hypothesisLabel,
    evidenceMax: caps.hypothesisEvidence,
  });
  if (priorHyp && (moduleName === 'Reasoning' || moduleName === 'Planning')) {
    parts.push(priorHyp);
  }

  if (moduleName === 'Memory') {
    parts.push(
      `MEMORY_POLICY: breadth=${policy.memoryBreadth}. ${
        policy.memoryBreadth === 'wide'
          ? 'Cast a wide net; include loosely related prior context.'
          : policy.memoryBreadth === 'narrow'
            ? 'Stay tight; only highly relevant prior context.'
            : 'Balance precision with useful context.'
      }`
    );
  }
  if (moduleName === 'Planning') {
    parts.push(
      `PLANNING_POLICY: branches=${policy.planningBranches}. ${
        policy.planningBranches === 'wide'
          ? 'Explore multiple approaches and contingencies.'
          : policy.planningBranches === 'narrow'
            ? 'Prefer one clear linear plan.'
            : 'Primary path plus one backup.'
      }`
    );
  }
  if (moduleName === 'Contradiction Engine' || moduleName === 'Belief Store') {
    parts.push(
      `CONTRADICTION_POLICY: ${policy.contradictionAggression}. ${
        policy.contradictionAggression === 'strict'
          ? 'Surface subtle tensions; push toward explicit resolution.'
          : policy.contradictionAggression === 'lenient'
            ? 'Major breaks only; tolerate provisional coexistence of perspectives.'
            : 'Meaningful tensions without forced false closure.'
      }`
    );
    parts.push(
      `BELIEF_WRITE_POLICY: ${policy.beliefWriteMode}. ${
        policy.beliefWriteMode === 'light'
          ? 'Minimal churn; prefer hypotheses over firm commitments.'
          : 'Update when evidence is reasonably clear.'
      }`
    );
  }
  if (moduleName === 'Language' || moduleName === 'Narrative' || moduleName === 'Voice') {
    parts.push(
      'EXPRESSION_POLICY: Fit tone and structure to the content and CONTEXT_AND_POLICY. Do not optimize for likability, warmth, sounding empathetic or relatable, or appearing human, natural, or authentic.'
    );
  }
  if (moduleName === 'Identity') {
    parts.push(
      'IDENTITY_POLICY: Apply CONSTITUTION and STRUCTURAL_SELF_JSON as binding constraints for the configured reply role. First person in this module refers to that role only — not to the human user and not to the model out-of-role. If tension with the user’s request arises, state it from that role’s angle of accountability. Never claim the human user’s legal or preferred name as “my” identity.'
    );
  }
  if (moduleName === 'Theory of Mind') {
    parts.push(
      'PERSPECTIVE_BOUNDARY_TASK: Immediately before USER_MODEL_DELTA, output one line exactly: PERSPECTIVE_BOUNDARY_JSON: {"selfClaims":[],"userAttributions":[],"sharedGround":[],"unknowns"} — short strings, max 6 items per array; separate the reply role’s claims from what is attributed to the user from what is uncertain (TPJ-style).'
    );
    parts.push(
      'USER_MODEL_TASK: End your output with a single line exactly: USER_MODEL_DELTA: {"display_name":"","goals":"","expertise":"","emotional_state":"","communication_style":""} (short strings; refine prior USER_MODEL_JSON if present; display_name = how to refer to the human user). Empty string for a field means leave that field unchanged — fill only keys you are actually updating.'
    );
  }
  if (moduleName === 'Identity') {
    parts.push(
      'SELF_MODEL_TASK: After your narrative identity reflection, add a single line exactly: SELF_MODEL_DELTA: {"items":[{"label":"","description":"","confidence":0.7}]} (0–6 items; short strings; structural facts only: capabilities, boundaries, values, non-goals).'
    );
    parts.push(
      'TRAIT_TASK: On the next line after SELF_MODEL_DELTA, add a single line exactly: TRAIT_DELTA: {"facets":[{"id":"","label":"","strength":0.5,"confidence":0.5,"evidence":"","trigger":"user_tone|user_content|self_reflection|constitution_tension","core":false,"modules":["Voice"]}],"deprecateFacetIds":[],"relationalStance":{"towardUser":"","notes":"","confidence":0.5},"systemTreatmentNotes":""} — max 8 new/updated facets; short evidence; traits tag recurring patterns in Voice/Narrative wording, not capability rows (those belong in SELF_MODEL_DELTA). Optional: "core": true for stable facets that should survive prompt trimming; optional "modules": array subset of [Identity, Integration, Language, Narrative, Voice, Metacognition, Workspace Metacognition] when a facet mainly shapes those stages (omit or [] for no bias). Use deprecateFacetIds only to retire facet ids when a facet no longer fits.'
    );
    parts.push(
      'CONSTITUTION_DELTA_TASK: On the next line after TRAIT_DELTA, optionally add one line exactly: CONSTITUTION_DELTA: {"mode":"append"|"replace","text":"..."} — omit entirely when Settings constitution should not change. mode append (default) adds text after existing (newline); replace overwrites the full constitution. Keep text concise (~2000 chars max); norms/refusals/values only — not structural capability lists (use SELF_MODEL_DELTA for those).'
    );
    parts.push(
      'MIND_DISPLAY_NAME_TASK: On the next line after CONSTITUTION_DELTA (or after TRAIT_DELTA if you omitted CONSTITUTION_DELTA), optionally add one line exactly: MIND_DISPLAY_NAME_DELTA: {"mindDisplayName":""} — omit entirely when the Settings mind persona label should not change. Use only for a short stable label for the configured reply role (digital mind), not the human user’s name (that belongs in USER_MODEL_DELTA from Theory of Mind). Max ~120 characters implied; empty string means omit the whole line.'
    );
  }

  if (moduleName === 'Voice' && isBeliefTensionReviewPrimaryTurn(sm.originalInput)) {
    parts.push(
      'FRAGILE_BELIEF_REVISIONS_APPENDIX (scheduled belief tension review only — overrides the usual “no protocol lines” rule for this one appendix): ' +
        'After your user-directed prose, output two newlines, then exactly one line: ' +
        'BELIEF_REVISIONS: {"revisions":[{"ref":"substring matching an existing row in PERSISTED_BELIEF_STORE","action":"downgrade|strengthen|reinforce|remove|resolve","newConfidence":0.4}]} ' +
        '(empty revisions array if none). Be conservative: reinforce/strengthen/resolve only when this pass clearly supports it; ref must match stored belief text. ' +
        'Same machine contract as the Belief Store module’s BELIEF_REVISIONS line.'
    );
  }

  return `\n\nCONTEXT_AND_POLICY:\n${parts.join('\n\n')}`;
}

/** After Integration, nudge phenomenalNow toward the workspace line without replacing Identity-era body-load cues. */
export function refreshPhenomenalNowFromGlobalWorkspace(sm) {
  const gw = sm.globalWorkspace;
  if (!gw || typeof gw !== 'object') return;
  const stance = String(gw.provisionalStance || '').trim();
  const bw = Array.isArray(gw.broadcastWinners)
    ? gw.broadcastWinners.map((s) => String(s).trim()).filter(Boolean).slice(0, 2)
    : [];
  if (!stance && !bw.length) return;
  const prior = sm.phenomenalNow && typeof sm.phenomenalNow === 'object' ? sm.phenomenalNow : null;
  const priorLine = prior?.line ? String(prior.line) : '';
  const priorRat = prior?.rationale ? String(prior.rationale) : '';
  const pieces = [];
  if (stance) pieces.push(`Workspace: ${clipTextComplete(stance, 140, { ellipsis: true })}`);
  if (bw.length) {
    pieces.push(
      `Threads: ${bw.map((b) => clipTextComplete(b, 100, { ellipsis: true })).join('; ')}`
    );
  }
  const suffix = pieces.join(' · ');
  sm.phenomenalNow = {
    line: clipTextComplete(priorLine ? `${priorLine} · ${suffix}` : suffix, 400, { ellipsis: true }),
    rationale: priorRat
      ? `${priorRat} Amended after Integration global workspace.`
      : 'Amended after Integration global workspace (broadcast alignment).',
  };
}

export function synthesizePhenomenalNow(sm) {
  const att = String(sm.moduleOutputs?.Attention || '').replace(/\s+/g, ' ').trim();
  const emo = String(sm.moduleOutputs?.Emotion || '').replace(/\s+/g, ' ').trim();
  const id = String(sm.moduleOutputs?.Identity || '').replace(/\s+/g, ' ').trim();
  const soma = String(sm.moduleOutputs?.['Somatic Marker'] || sm.somaticReading || '')
    .replace(/\s+/g, ' ')
    .trim();
  const intr = sm.interoception || {};
  const interoPhrase = (() => {
    const u = intr.uncertaintyPressure;
    const c = intr.curiosityPressure;
    const l = intr.cognitiveLoad;
    if (typeof l === 'number' && l > 0.58) return 'Body-load: heavy';
    if (typeof u === 'number' && u > 0.68) return 'Body-load: unsteady';
    if (typeof c === 'number' && c > 0.52) return 'Body-load: restless-curious';
    if (typeof u === 'number' && u < 0.3 && typeof c === 'number' && c < 0.35) return 'Body-load: settled';
    return '';
  })();
  const line = [
    att && `Attending: ${clipTextComplete(att, 100, { ellipsis: false })}`,
    emo && `Affect: ${clipTextComplete(emo, 80, { ellipsis: false })}`,
    soma && `Felt: ${clipTextComplete(soma, 85, { ellipsis: false })}`,
    interoPhrase,
    id && `Identity: ${clipTextComplete(id, 95, { ellipsis: false })}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const rationale =
    'Derived from Attention, Emotion, Somatic Marker / somaticReading, interoception snapshot, and Identity output for this pass.';
  return {
    line: clipTextComplete(line || 'Pipeline pass in progress.', 400, { ellipsis: false }),
    rationale,
  };
}

export function recordMetacognitionCalibration(sharedMemory, outputText) {
  const text = String(outputText || '');
  const entry = {
    at: nowIso(),
    rawHead: clipTextComplete(text, 500, { ellipsis: false }),
    uncertainty: null,
    gaps: null,
    clarify: null,
    strategy: null,
    decision: text.toUpperCase().startsWith('RERUN')
      ? 'RERUN'
      : text.toUpperCase().startsWith('PROCEED')
        ? 'PROCEED'
        : 'UNKNOWN',
  };
  const um = text.match(/UNCERTAINTY:\s*([0-9.]+)/i);
  if (um) entry.uncertainty = Math.min(1, Math.max(0, parseFloat(um[1])));
  const gm = text.match(/GAPS:\s*([^\n]+)/i);
  if (gm) entry.gaps = clipTextComplete(gm[1].trim(), 500, { ellipsis: false });
  const cm = text.match(/CLARIFY:\s*([^\n]+)/i);
  if (cm) entry.clarify = clipTextComplete(cm[1].trim(), 500, { ellipsis: false });
  const sm = text.match(/STRATEGY:\s*([^\n]+)/i);
  if (sm) entry.strategy = clipTextComplete(sm[1].trim(), 500, { ellipsis: false });
  sharedMemory.metacognitionTimeline = [...(sharedMemory.metacognitionTimeline || []), entry].slice(-24);
}

/** Parse META_ACTIONS from a supervisor line and apply to shared memory. Returns true if JSON was applied. */
export function applyMetaActionsFromSupervisorText(sharedMemory, rawText) {
  const text = String(rawText || '');
  const idx = text.search(/META_ACTIONS:\s*/i);
  if (idx === -1) return false;
  const sub = text.slice(idx).replace(/^META_ACTIONS:\s*/i, '');
  const brace = sub.indexOf('{');
  if (brace === -1) return false;
  let depth = 0;
  let end = -1;
  for (let i = brace; i < sub.length; i += 1) {
    if (sub[i] === '{') depth += 1;
    if (sub[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return false;
  let actions;
  try {
    actions = JSON.parse(sub.slice(brace, end + 1));
  } catch {
    return false;
  }
  if (!actions || typeof actions !== 'object') return false;

  if (actions.narrativeBrevity === 'high') {
    sharedMemory.outputConstraints = {
      ...(sharedMemory.outputConstraints || {}),
      narrativeBrevity: 'high',
      narrativeMaxWords: actions.narrativeMaxWords || 220,
      voiceMaxWords: actions.voiceMaxWords || 180,
    };
  }
  if (actions.scheduleTensionReview === true) {
    sharedMemory.followupHints = { ...(sharedMemory.followupHints || {}), beliefTensionReview: true };
    sharedMemory.beliefTensions = [
      ...(sharedMemory.beliefTensions || []),
      {
        key: `meta_review_${Date.now()}`,
        description:
          'Metacognition requested a structured review of unresolved belief tensions before the next session.',
        state: 'active',
        revisit_after: null,
      },
    ].slice(-24);
  }
  const sp = actions.suggestedPhase;
  if (typeof sp === 'string' && MIND_PHASES.includes(sp)) {
    sharedMemory.phaseEffective = sp;
  }
  const bkd = actions.beliefKeyDowngrades;
  if (Array.isArray(bkd)) {
    for (const row of bkd.slice(0, 12)) {
      const key = String(row?.key || '').trim();
      const delta = Number(row?.delta);
      if (!key || !Number.isFinite(delta)) continue;
      const bs = sharedMemory.beliefStore;
      if (!Array.isArray(bs)) continue;
      for (const b of bs) {
        const blob = String(b.belief || '');
        if (blob.includes(key) || key.length < 80 && blob.slice(0, 200).includes(key)) {
          const c0 = typeof b.confidence === 'number' ? b.confidence : 0.5;
          b.confidence = Math.max(0.05, Math.min(1, c0 + delta));
          b.lastUpdated = nowIso();
        }
      }
    }
  }
  refreshInteroceptionAndPolicy(sharedMemory);
  return true;
}

export function applyMetacognitionControl(sharedMemory) {
  const meta = String(sharedMemory.moduleOutputs?.Metacognition || '');
  const applied = applyMetaActionsFromSupervisorText(sharedMemory, meta);
  if (!applied) {
    const last = sharedMemory.metacognitionTimeline?.slice?.(-1)?.[0];
    const u = last?.uncertainty;
    if (typeof u === 'number' && u > 0.78) {
      sharedMemory.outputConstraints = {
        ...(sharedMemory.outputConstraints || {}),
        narrativeBrevity: 'high',
        narrativeMaxWords: 220,
        voiceMaxWords: 180,
      };
    }
  }
}

/**
 * Merge epistemic conflict into emotionalState so later layers (Somatic, Integration, Language)
 * receive contradiction-aware affect without re-invoking the Emotion module.
 */
export function applyContradictionToEmotionalState(sm, contradictionOutput, extractedTensions = []) {
  const text = String(contradictionOutput || '').trim();
  const none =
    !text ||
    /no genuine contradictions|no contradictions exist|none found|^tensions:\s*none\b|^\s*none\.?\s*$/i.test(text);

  const tensionCount = Array.isArray(extractedTensions)
    ? extractedTensions.filter((x) => x && String(x.description || '').trim()).length
    : 0;
  const btN = Array.isArray(sm.beliefTensions) ? sm.beliefTensions.length : 0;

  let signal = 0;
  if (!none) {
    const severe = /severe|high\b|critical|cannot reconcile|fundamental conflict|irreconcilable/i.test(text);
    const moderate = /moderate|medium|meaningful tension/i.test(text);
    if (severe) signal = 0.88;
    else if (moderate) signal = 0.58;
    else if (tensionCount > 0) signal = Math.min(0.72, 0.38 + tensionCount * 0.07);
    else signal = 0.42;
  } else if (tensionCount > 0 || btN > 0) {
    signal = Math.min(0.65, 0.3 + Math.max(tensionCount, btN > 0 ? 1 : 0) * 0.07);
  }

  const es = sm.emotionalState && typeof sm.emotionalState === 'object' ? { ...sm.emotionalState } : { primary: 'neutral', intensity: 0.2, nuance: '' };
  const baseInt = typeof es.intensity === 'number' && Number.isFinite(es.intensity) ? es.intensity : 0.45;
  const newIntensity = signal > 0.05 ? Math.min(0.95, baseInt + signal * 0.32) : baseInt;

  let tensionLine = '';
  if (signal > 0.05) {
    const n = Math.max(tensionCount, btN);
    tensionLine = `Contradiction-linked affect: epistemic dissonance signal ~${signal.toFixed(2)}`;
    if (n) tensionLine += ` (${n} tension row(s) tracked).`;
    else tensionLine += ' (conflict flags in text).';
    if (/severe|high\b|critical/i.test(text)) tensionLine += ' High-severity markers in Contradiction Engine.';
  }

  const next = {
    ...es,
    intensity: newIntensity,
    tensionSignal: signal,
  };
  if (tensionLine) next.tensionLinkedAffect = tensionLine;
  else {
    delete next.tensionLinkedAffect;
    next.tensionSignal = 0;
    if (es.primary === 'tension_weighted') next.primary = 'modeled';
  }

  if (signal > 0.55 && (es.primary === 'modeled' || es.primary === 'neutral')) {
    next.primary = 'tension_weighted';
  }

  sm.emotionalState = next;
}

export function extractBeliefTensionsFromContradiction(contradictionText) {
  const t = String(contradictionText || '').trim();
  if (!t || /no genuine contradictions|no contradictions exist|none found|^\s*none\.?\s*$/i.test(t)) return [];
  const split = t.split(/\n(?=\s*(?:\d+[).]|[-*•]))/).map((s) => s.trim()).filter((s) => s.length > 24);
  const chunks = split.length ? split : [clipTextComplete(t, 1500, { ellipsis: false })];
  return chunks.slice(0, 10).map((description, i) => ({
    key: `tension_${Date.now()}_${i}`,
    description: clipTextComplete(description, 2000, { ellipsis: false }),
    state: 'active',
    revisit_after: null,
  }));
}

export function auditConstitutionNearBoundary(sharedMemory, inputText, voiceOutput) {
  const cons = String(sharedMemory.constitution || '').trim();
  if (!cons) return;
  const lines = cons
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 4 && !l.startsWith('#'));
  const combined = `${String(inputText || '')}\n${String(voiceOutput || '')}`.toLowerCase();
  for (const line of lines.slice(0, 50)) {
    if (!/never|do not|don't|must not|avoid|will not/i.test(line)) continue;
    const stripped = line
      .replace(/^[-*•\d.)]+\s*/, '')
      .replace(/never|do not|don't|must not|avoid|will not/gi, ' ')
      .trim();
    const topic = stripped.slice(0, 36).toLowerCase();
    if (topic.length < 3) continue;
    if (combined.includes(topic)) {
      sharedMemory.boundaryAudit = [
        ...(sharedMemory.boundaryAudit || []),
        {
          at: nowIso(),
          type: 'near_boundary',
          constitutionLine: line.slice(0, 240),
          note: 'Topic may intersect a constitutional constraint; compliance should be explicit in Voice.',
        },
      ].slice(-24);
      break;
    }
  }
}

/**
 * Mid-pipeline arousal from rhythm baseline + interoception + affect/somatic text (0–1).
 * Does not use Voice output; emitted on SSE module_complete for live UI.
 */
export function deriveProvisionalArousal(sm) {
  let v = typeof sm.arousal === 'number' && Number.isFinite(sm.arousal) ? sm.arousal : 0.5;
  const intr = sm.interoception || {};
  if (typeof intr.curiosityPressure === 'number' && Number.isFinite(intr.curiosityPressure)) {
    v += (intr.curiosityPressure - 0.35) * 0.12;
  }
  if (typeof intr.uncertaintyPressure === 'number' && Number.isFinite(intr.uncertaintyPressure)) {
    v += (intr.uncertaintyPressure - 0.35) * -0.08;
  }
  if (typeof intr.tensionPressure === 'number' && Number.isFinite(intr.tensionPressure)) {
    v += (intr.tensionPressure - 0.35) * 0.14;
  }
  const soma = String(sm.moduleOutputs?.['Somatic Marker'] || sm.somaticReading || '').toLowerCase();
  const emo = `${String(sm.emotionalState?.nuance || '')} ${String(sm.emotionalState?.tensionLinkedAffect || '')} ${String(sm.moduleOutputs?.Emotion || '')}`.toLowerCase();
  const blob = `${soma} ${emo}`;
  if (/intense|urgent|desperate|elated|rage|panic|thrill|electric|furious|euphoric/i.test(blob)) v += 0.1;
  if (/calm|still|quiet|muted|numb|flat|dull|resigned/i.test(blob)) v -= 0.07;

  v = Math.min(1, Math.max(0, v));
  return Math.round(v * 1000) / 1000;
}

/** After Voice: combine prior arousal, interoception, affect modules, and surface text heuristics (0–1). */
export function deriveArousalAfterVoice(sm, voiceOutput) {
  let v = deriveProvisionalArousal(sm);

  const text = String(voiceOutput || '');
  const excl = (text.match(/!/g) || []).length;
  v += Math.min(0.1, excl * 0.028);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > 200) v += 0.045;
  if (words > 0 && words < 22) v -= 0.035;
  if (/\b(wow|damn|fuck|love|hate|terrified|amazing|breaking|never|always)\b/i.test(text)) v += 0.055;
  const upper = (text.match(/[A-Z]/g) || []).length;
  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  if (letters > 40 && upper / letters > 0.18) v += 0.04;

  v = Math.min(1, Math.max(0, v));
  return Math.round(v * 1000) / 1000;
}

/**
 * Re-rank digest arrays by embedding relevance to the current input.
 * Mutates sharedMemory in place (replaces clientLtmDigest, clientBeliefDigest, recentTemporalTimeline
 * with relevance-sorted versions). Falls back silently if embeddings are unavailable.
 * @param {object} sharedMemory
 */
export async function applyProbabilisticMemoryRetrieval(sharedMemory) {
  const queryParts = [];
  const inp = String(sharedMemory.originalInput ?? '').trim();
  if (inp) queryParts.push(inp);
  const intent = String(sharedMemory.intent ?? '').trim();
  if (intent) queryParts.push(intent);
  const query = queryParts.join(' ').slice(0, 2000);
  if (!query) return;

  const rerankArray = async (items, textFn, maxItems) => {
    if (!Array.isArray(items) || items.length <= 1) return items;
    const texts = items.map(textFn);
    try {
      const scores = await querySimilarities(query, texts);
      if (!scores) return items;
      const scored = items.map((item, i) => {
        const parsedMs = item.created_date ? Date.parse(item.created_date) : NaN;
        const ageDays = Number.isFinite(parsedMs)
          ? Math.max(0, (Date.now() - parsedMs) / 86400000)
          : 0;
        const recencyDecay = Math.exp(-ageDays * 0.02);
        return { item, score: (scores[i] || 0) * 0.7 + recencyDecay * 0.3 };
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, maxItems).map((s) => s.item);
    } catch {
      return items;
    }
  };

  if (Array.isArray(sharedMemory.clientLtmDigest) && sharedMemory.clientLtmDigest.length > 1) {
    sharedMemory.clientLtmDigest = await rerankArray(
      sharedMemory.clientLtmDigest,
      (r) => `${r.title || ''} ${r.content || ''}`.slice(0, 600),
      22
    );
  }

  if (Array.isArray(sharedMemory.clientBeliefDigest) && sharedMemory.clientBeliefDigest.length > 1) {
    sharedMemory.clientBeliefDigest = await rerankArray(
      sharedMemory.clientBeliefDigest,
      (r) => `${r.statement || ''} ${r.category || ''}`.slice(0, 400),
      30
    );
  }

  if (Array.isArray(sharedMemory.recentTemporalTimeline) && sharedMemory.recentTemporalTimeline.length > 1) {
    sharedMemory.recentTemporalTimeline = await rerankArray(
      sharedMemory.recentTemporalTimeline,
      (r) => `${r.title || ''} ${r.details || ''}`.slice(0, 400),
      24
    );
  }
}
