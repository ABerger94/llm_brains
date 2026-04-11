import { clipTextComplete } from '../shared/textClip.mjs';
import { isBeliefTensionReviewPrimaryTurn } from '../shared/beliefRevisionsVoice.mjs';
import { MODULES, LAYERS, getModuleByName } from './prompts.js';
import { normalizeExecutionResume } from '../shared/pipelineExecutionResume.mjs';
import { getIncrementalCheckpointCursorAfter } from '../shared/pipelineModuleCheckpoint.mjs';
import { consumePipelinePauseIfRequested, pipelinePausePending } from './pipelinePauseRegistry.js';

/**
 * Non-empty options.pauseToken enables cooperative pause unless pause is explicitly turned off.
 * Does not require options.pauseSupport === true (that check was too brittle for some clients).
 */
function resolveCooperativePauseToken(options = {}) {
  const t = String(options.pauseToken || '').trim();
  if (!t) return '';
  const ps = options.pauseSupport;
  if (ps === false || ps === 'false' || ps === 0 || ps === '0') return '';
  return t;
}

const MODULE_PROMPT_OVERRIDE_MAX_LEN = 32000;
import crypto from 'node:crypto';
import {
  mergeMindRuntimeIntoSharedMemory,
  applyProbabilisticMemoryRetrieval,
  buildMindContextForModule,
  synthesizePhenomenalNow,
  refreshPhenomenalNowFromGlobalWorkspace,
  recordMetacognitionCalibration,
  applyMetacognitionControl,
  applyMetaActionsFromSupervisorText,
  extractBeliefTensionsFromContradiction,
  applyContradictionToEmotionalState,
  auditConstitutionNearBoundary,
  refreshPolicyAfterAffect,
  refreshInteroceptionAndPolicy,
  deriveArousalAfterVoice,
  deriveProvisionalArousal,
} from './mindPolicy.js';
import { computeWorkspaceIgnition } from './workspaceIgnition.js';
import { applyEpistemicFusionToSharedMemory, slimEpistemicFusion } from '../shared/epistemicFusion.mjs';
import { querySimilarities } from './embeddingService.js';
import { resolveAdaptiveTemperature, shouldAdaptTemperature } from './adaptiveTemperature.js';
import { logPipelineTelemetry } from './calibration.js';
import { getThreshold } from './thresholdStore.js';
import {
  localLlmContextBudgetChars,
  shouldCompressSharedMemory,
  resolveDefaultLocalMaxTokens,
  reasoningMultiSampleEnabled,
  reasoningMultiSampleMergeMode,
  reasoningMultiSampleSecondTemperature,
  integrationMultiSampleEnabled,
  contradictionMultiSampleEnabled,
  multiSampleMergeMode,
  priorHypothesisDecayFactor,
} from './llmEnv.js';
import {
  estimatePromptTokens,
  estimateTotalRequestTokens,
  shouldUseChunkedModuleCalls,
  mapIngestSystemPrompt,
  mapIngestUserPrompt,
  splitTextIntoChunks,
  computeMapFragmentCharBudget,
  extractFirstJsonObject,
  mergeMapBullets,
  coalesceBulletsForBudget,
  ingestJsonStringViaMapChunks,
  getLlmContextTokensMax,
  getLlmContextSlackTokens,
  budgetedCompletionCap,
  getTokenCharsPerToken,
  truncateUserContentToContext,
} from './llmContextBudget.js';
import { maybeFulfillWebRequests } from './webEnrichment.js';
import { extractRecentExchangeFromComposedInput } from './pipelineInputCompose.js';

export { normalizeExecutionResume };

/** Modules that must exist before Metacognition (layers 1–4 only; Narrative/Voice run later). */
const MODULES_BEFORE_METACOGNITION = [
  ...LAYERS.layer1,
  ...LAYERS.layer2,
  ...LAYERS.layer3,
  ...LAYERS.layer4,
];

const VALID_PIPELINE_MODULE_NAMES = new Set(MODULES.map((m) => m.name));

const DEFAULT_MAX_METACOG_RERUNS = 1;

function layerKeyToResumePhase(layerKey) {
  if (layerKey === 'layer5') return 'layer5';
  if (layerKey === 'layer6') return 'layer6';
  return 'layer14';
}

/** Modules whose SSE text feeds the Graph Pipeline transcript / voice path — keep uncut for TTS/narrative parity (still cap at voice-path max for pathological sizes). */
const SSE_FULL_PROSE_MODULE_NAMES = new Set(['Language', 'Narrative', 'Voice']);

/** Cap each `module_complete` SSE payload for non–Voice-path modules (Planning, etc.). Default high so execution.log "Show output" can show full text; override with SSE_MODULE_COMPLETE_MAX_CHARS. */
function getSseModuleCompleteMaxChars() {
  const n = Number.parseInt(String(process.env.SSE_MODULE_COMPLETE_MAX_CHARS || '').trim(), 10);
  if (Number.isFinite(n) && n >= 2000 && n <= 500_000) return n;
  return 200_000;
}

/** Larger cap for Language/Narrative/Voice so live stream shows full prose; override with SSE_MODULE_COMPLETE_VOICE_PATH_MAX_CHARS. */
function getSseVoicePathModuleMaxChars() {
  const n = Number.parseInt(String(process.env.SSE_MODULE_COMPLETE_VOICE_PATH_MAX_CHARS || '').trim(), 10);
  if (Number.isFinite(n) && n >= 8000 && n <= 500_000) return n;
  return 200_000;
}

function clipModuleOutputForSse(text, moduleName) {
  const s = String(text || '');
  const max = SSE_FULL_PROSE_MODULE_NAMES.has(moduleName)
    ? getSseVoicePathModuleMaxChars()
    : getSseModuleCompleteMaxChars();
  if (s.length <= max) return { output: s, truncated: false };
  const omitted = s.length - max;
  return {
    output: `${s.slice(0, max)}\n\n[…SSE preview truncated; ${omitted} more chars — full text is on the server and in the final run record]`,
    truncated: true,
    fullLength: s.length,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    try {
      return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (e) {
      console.warn('[pipeline] deepClone failed, returning shallow copy:', e?.message || e);
      return { ...obj };
    }
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Best-effort repair of malformed JSON from LLM output:
 *  - Strip trailing commas before } or ]
 *  - Replace single-quoted keys/values with double quotes (outside existing double-quoted strings)
 *  - Close unbalanced braces/brackets (truncated output)
 */
function repairAndParseJson(str) {
  let s = String(str || '').trim();
  if (!s) return null;

  // Strip trailing commas: ,} → } and ,] → ]
  s = s.replace(/,\s*([}\]])/g, '$1');

  // Replace single-quoted strings with double-quoted (naive but covers common cases).
  // Walk char-by-char to avoid mangling strings that contain the other quote type.
  {
    const chars = [...s];
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c === '\\') { i++; continue; }
      if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (c === "'" && !inDouble) {
        if (!inSingle) {
          chars[i] = '"';
          inSingle = true;
        } else {
          chars[i] = '"';
          inSingle = false;
        }
      }
    }
    s = chars.join('');
  }

  // Try strict parse first
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { /* continue to brace-closing repair */ }

  // Close unbalanced braces/brackets (truncated output)
  const stack = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && inStr) { i++; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  if (stack.length > 0) {
    // Trim any trailing incomplete key/value/comma before closing
    s = s.replace(/,?\s*"[^"]*"?\s*:?\s*$/, '');
    s = s.replace(/,\s*$/, '');
    s += stack.reverse().join('');
    // Re-strip trailing commas that may now precede a closing bracket
    s = s.replace(/,\s*([}\]])/g, '$1');
  }

  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function parseJsonAfterMarker(text, marker) {
  const raw = String(text || '');
  const needle = `${marker}:`;
  const idx = raw.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return null;
  const sub = raw.slice(idx + needle.length).trimStart();
  const brace = sub.indexOf('{');
  if (brace === -1) return null;
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
  const jsonSlice = end === -1 ? sub.slice(brace) : sub.slice(brace, end + 1);
  if (end === -1) return repairAndParseJson(jsonSlice);
  try {
    return JSON.parse(jsonSlice);
  } catch {
    return repairAndParseJson(jsonSlice);
  }
}

/**
 * When models wrap INTEGRATION_JSON in markdown fences or add noise before `{`,
 * standard parsing can fail — try a looser slice before giving up.
 */
function parseIntegrationJsonLoose(text) {
  const raw = String(text || '');
  const fenced = raw.match(/INTEGRATION_JSON:\s*```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const obj = JSON.parse(fenced[1].trim());
      if (obj && typeof obj === 'object') return obj;
    } catch {
      const repaired = repairAndParseJson(fenced[1].trim());
      if (repaired) return repaired;
    }
  }
  const needle = 'INTEGRATION_JSON:';
  const idx = raw.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return null;
  let sub = raw.slice(idx + needle.length).trimStart();
  sub = sub.replace(/^```(?:json)?\s*\n?/i, '');
  const fenceMatch = sub.match(/\n```/);
  if (fenceMatch && fenceMatch.index != null) {
    sub = sub.slice(0, fenceMatch.index).trim();
  }
  const brace = sub.indexOf('{');
  if (brace === -1) return null;
  const jsonSlice = sub.slice(brace);
  let depth = 0;
  let end = -1;
  for (let i = 0; i < jsonSlice.length; i += 1) {
    if (jsonSlice[i] === '{') depth += 1;
    if (jsonSlice[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const balanced = end !== -1 ? jsonSlice.slice(0, end + 1) : jsonSlice;
  try {
    const obj = JSON.parse(balanced);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return repairAndParseJson(balanced);
  }
}

/** Prose-only part of Integration output (before any INTEGRATION_JSON line). */
function integrationProseBeforeJsonMarker(text) {
  const s = String(text ?? '');
  const idx = s.search(/\nINTEGRATION_JSON:/i);
  if (idx !== -1) return s.slice(0, idx).trimEnd();
  if (/^\s*INTEGRATION_JSON:/i.test(s)) return '';
  return s.trimEnd();
}

/**
 * If Integration never produced parseable JSON, still set globalWorkspace so
 * Workspace Metacognition heuristics and downstream consumers do not see null.
 */
function buildFallbackGlobalWorkspace(integrationRaw, sharedMemory) {
  const mo = sharedMemory.moduleOutputs && typeof sharedMemory.moduleOutputs === 'object' ? sharedMemory.moduleOutputs : {};
  const prose = integrationProseBeforeJsonMarker(integrationRaw).replace(/\s+/g, ' ').trim().slice(0, 1200);
  const reason = String(mo.Reasoning || '').trim().slice(0, 500);
  const nar = String(mo.Narrative || '').trim().slice(0, 400);
  const stance =
    prose ||
    reason ||
    nar ||
    'Integration did not emit valid INTEGRATION_JSON; using upstream module text as provisional stance.';

  // Mine salience from Attention working-memory items
  const wmItems = sharedMemory.workingMemory?.items;
  const salience = Array.isArray(wmItems)
    ? wmItems.map((it) => String(it?.text || '').trim()).filter(Boolean).slice(0, 6)
    : [];

  // Mine conflicts from beliefTensions (populated by Contradiction Engine)
  const tensions = Array.isArray(sharedMemory.beliefTensions) ? sharedMemory.beliefTensions : [];
  const conflicts = tensions
    .map((t) => {
      const desc = String(t?.description || t?.tension || '').trim();
      return desc.slice(0, 500);
    })
    .filter(Boolean)
    .slice(0, 6);

  // Open questions from Reasoning HYPOTHESES_JSON or Curiosity MAIN_QUESTION
  const openQuestions = [];
  const reasoningHypo = parseJsonAfterMarker(String(mo.Reasoning || ''), 'HYPOTHESES_JSON');
  if (reasoningHypo && Array.isArray(reasoningHypo.hypotheses)) {
    for (const h of reasoningHypo.hypotheses.slice(0, 4)) {
      const q = String(h?.would_flip_if || h?.label || '').trim();
      if (q.length > 8) openQuestions.push(q.slice(0, 400));
    }
  }
  const curiosityMain = String(mo.Curiosity || '').match(/MAIN_QUESTION:\s*(.+)/i);
  if (curiosityMain) {
    const q = curiosityMain[1].trim();
    if (q.length > 8) openQuestions.push(q.slice(0, 400));
  }

  // Broadcast winners: modules with the most substantive outputs
  const candidateModules = ['Reasoning', 'Emotion', 'Contradiction Engine', 'Self-Reflection', 'Identity'];
  const broadcastWinners = candidateModules
    .map((name) => ({ name, len: String(mo[name] || '').trim().length }))
    .filter((m) => m.len > 50)
    .sort((a, b) => b.len - a.len)
    .slice(0, 4)
    .map((m) => m.name);

  // Epistemic threads from EPISTEMIC_CLAIMS in shared memory
  const ecRaw = sharedMemory.epistemicClaims;
  const epistemicThreads = Array.isArray(ecRaw)
    ? ecRaw
        .slice(0, 6)
        .map((c) => ({
          thread: String(c?.text || '').slice(0, 400),
          kind: String(c?.kind || 'unknown').slice(0, 24),
        }))
        .filter((t) => t.thread)
    : [];

  const hpRaw = sharedMemory.hypothesisPortfolio?.hypotheses;
  const hypothesesFb = Array.isArray(hpRaw) && hpRaw.length ? normalizeHypothesisList(hpRaw) : [];
  return {
    salience,
    conflicts,
    openQuestions: openQuestions.slice(0, 6),
    provisionalStance: stance.slice(0, 1200),
    integrationConfidence: 0.5,
    broadcastWinners,
    phenomenalUnity: 'partial',
    unityRationale:
      'No valid INTEGRATION_JSON line was parsed; stance came from Integration prose or upstream modules. Unity set to partial (fallback).',
    epistemicThreads,
    ...(hypothesesFb.length ? { hypotheses: hypothesesFb } : {}),
  };
}

function normalizeEpistemicClaims(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
  const out = [];
  for (const c of claims.slice(0, 14)) {
    const text = String(c?.text || '').trim();
    if (!text) continue;
    out.push({
      text: text.slice(0, 600),
      kind: String(c?.kind || 'inferred').slice(0, 28),
      confidence: clamp01(c?.confidence, 0.5),
    });
  }
  return out;
}

/** Normalize Reasoning / Integration hypothesis portfolio entries (relative plausibility, not calibrated p). */
function normalizeHypothesisList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const h of raw.slice(0, 8)) {
    if (!h || typeof h !== 'object') continue;
    const label = String(h.label || '').trim();
    if (!label) continue;
    out.push({
      id: String(h.id || `h${out.length + 1}`).trim().slice(0, 32),
      label: label.slice(0, 400),
      weight: clamp01(h.weight, 0.5),
      evidence_for: String(h.evidence_for ?? h.evidenceFor ?? '').trim().slice(0, 320),
      evidence_against: String(h.evidence_against ?? h.evidenceAgainst ?? '').trim().slice(0, 320),
      would_flip_if: String(h.would_flip_if ?? h.wouldFlipIf ?? '').trim().slice(0, 280),
    });
    if (out.length >= 6) break;
  }
  return out;
}

/** Seed hypothesisPortfolio for this run: prior workspace (decayed) before Reasoning; keep mid-run state if Reasoning already ran. */
function initialHypothesisPortfolioForRun(base) {
  const reasoningDone = String(base.moduleOutputs?.Reasoning || '').trim().length > 0;
  if (reasoningDone) {
    const hp = base.hypothesisPortfolio?.hypotheses?.length
      ? normalizeHypothesisList(base.hypothesisPortfolio.hypotheses)
      : [];
    return {
      hypotheses: hp,
      at: typeof base.hypothesisPortfolio?.at === 'string' ? base.hypothesisPortfolio.at : null,
      source: hp.length ? 'in_run' : null,
    };
  }
  const decay = priorHypothesisDecayFactor();
  const priorGwh = base.priorTurnGlobalWorkspace?.hypotheses;
  if (Array.isArray(priorGwh) && priorGwh.length) {
    const hy = normalizeHypothesisList(priorGwh).map((h) => {
      const w = Number(h.weight);
      const baseW = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.5;
      return {
        ...h,
        weight: Math.min(1, Math.max(0.05, baseW * decay)),
      };
    });
    return { hypotheses: hy, at: nowIso(), source: 'prior_workspace' };
  }
  if (base.hypothesisPortfolio?.hypotheses?.length) {
    return {
      hypotheses: normalizeHypothesisList(base.hypothesisPortfolio.hypotheses),
      at: typeof base.hypothesisPortfolio?.at === 'string' ? base.hypothesisPortfolio.at : null,
      source: 'carried',
    };
  }
  return { hypotheses: [], at: null, source: null };
}

function appendPredictionHistory(sharedMemory) {
  const p = sharedMemory.userStancePrediction;
  if (!p || typeof p !== 'object') return;
  const line = String(p.expectUserWants || '').trim();
  if (!line) return;
  sharedMemory.predictionHistory = ensureArray(sharedMemory.predictionHistory);
  sharedMemory.predictionHistory.push({
    at: nowIso(),
    expectUserWants: line.slice(0, 400),
    confidence: clamp01(p.confidence, 0.5),
  });
  sharedMemory.predictionHistory = sharedMemory.predictionHistory.slice(-12);
}

export function createSharedMemory({ existingSharedMemory, input }) {
  const base = existingSharedMemory ? deepClone(existingSharedMemory) : {};
  const sessionId = base.sessionId || crypto.randomUUID();
  const iterationCount = Number.isFinite(base.iterationCount) ? base.iterationCount : 0;

  const sharedMemory = {
    sessionId,
    iterationCount,
    originalInput: base.originalInput ?? input,
    timestamp: nowIso(),
    layerOutputs: base.layerOutputs ?? {
      layer1: [],
      layer2: [],
      layer3: [],
      layer4: [],
      layer5: [],
      layer6: [],
    },
    moduleOutputs: base.moduleOutputs ?? {},
    beliefStore: ensureArray(base.beliefStore),
    activeGoals: base.activeGoals ?? { immediate: [], longTerm: [] },
    emotionalState: base.emotionalState ?? { primary: 'neutral', intensity: 0.2, nuance: '' },
    identityNarrative: base.identityNarrative ?? '',
    curiosityQueue: ensureArray(base.curiosityQueue),
    somaticReading: base.somaticReading ?? '',
    contradictions: ensureArray(base.contradictions),
    narrativeHistory: ensureArray(base.narrativeHistory),
    metaCognitionFlags: ensureArray(base.metaCognitionFlags),
    metacognitionDeferredReruns: ensureArray(base.metacognitionDeferredReruns),
    rerunGuidance: base.rerunGuidance ?? '',
    phase: base.phase ?? 'focus',
    arousal: typeof base.arousal === 'number' ? base.arousal : 0.5,
    intent: base.intent ?? '',
    userModel: base.userModel ?? null,
    participantLabels:
      base.participantLabels && typeof base.participantLabels === 'object'
        ? { ...base.participantLabels }
        : null,
    constitution: base.constitution ?? '',
    cognitivePolicy: base.cognitivePolicy ?? null,
    phenomenalNow: base.phenomenalNow ?? null,
    metacognitionTimeline: ensureArray(base.metacognitionTimeline),
    beliefTensions: ensureArray(base.beliefTensions),
    boundaryAudit: ensureArray(base.boundaryAudit),
    webFindings: typeof base.webFindings === 'string' ? base.webFindings : '',
    webFetchLog: Array.isArray(base.webFetchLog) ? base.webFetchLog : [],
    webFetchesUsed: Number.isFinite(base.webFetchesUsed) ? base.webFetchesUsed : 0,
    webFetchSuppressedForRun: typeof base.webFetchSuppressedForRun === 'boolean' ? base.webFetchSuppressedForRun : false,
    webFetchSuppressReason: typeof base.webFetchSuppressReason === 'string' ? base.webFetchSuppressReason : '',
    structuralSelfModel: Array.isArray(base.structuralSelfModel) ? base.structuralSelfModel : [],
    globalWorkspace: base.globalWorkspace ?? null,
    interoception: base.interoception ?? null,
    workingMemory: base.workingMemory && typeof base.workingMemory === 'object' ? base.workingMemory : { items: [] },
    workingMemoryPromoteIds: ensureArray(base.workingMemoryPromoteIds),
    outputConstraints: base.outputConstraints ?? null,
    phaseEffective: base.phaseEffective ?? null,
    userStancePrediction: base.userStancePrediction ?? null,
    surpriseAssessment: base.surpriseAssessment ?? null,
    dmnCarryover: typeof base.dmnCarryover === 'string' ? base.dmnCarryover : null,
    predictionHistory: ensureArray(base.predictionHistory),
    epistemicClaims: ensureArray(base.epistemicClaims),
    priorTurnPredictionAudit: base.priorTurnPredictionAudit ?? null,
    followupHints:
      base.followupHints && typeof base.followupHints === 'object' ? { ...base.followupHints } : {},
    /** Count of supervisor-triggered reruns consumed in this pipeline POST; continuation legs reset at run start (see runPipeline). */
    metacognitionRerunsUsed: Number.isFinite(Number(base.metacognitionRerunsUsed))
      ? Math.max(0, Math.floor(Number(base.metacognitionRerunsUsed)))
      : 0,
    personalityProfile:
      base.personalityProfile && typeof base.personalityProfile === 'object'
        ? deepClone(base.personalityProfile)
        : null,
    priorTurnGlobalWorkspace:
      base.priorTurnGlobalWorkspace && typeof base.priorTurnGlobalWorkspace === 'object'
        ? deepClone(base.priorTurnGlobalWorkspace)
        : null,
    /** Injected each run from client TemporalEvent list (browser timeline). */
    recentTemporalTimeline: Array.isArray(base.recentTemporalTimeline)
      ? deepClone(base.recentTemporalTimeline).slice(0, 24)
      : [],
    clientLtmDigest: Array.isArray(base.clientLtmDigest) ? deepClone(base.clientLtmDigest).slice(0, 24) : [],
    clientBeliefDigest: Array.isArray(base.clientBeliefDigest) ? deepClone(base.clientBeliefDigest).slice(0, 32) : [],
    clientAffectDigest: Array.isArray(base.clientAffectDigest) ? deepClone(base.clientAffectDigest).slice(0, 12) : [],
    clientBiographyExcerpt:
      typeof base.clientBiographyExcerpt === 'string' ? base.clientBiographyExcerpt : '',
    /** Prior-turn dialogue block for this composed input; set each run in runPipeline after strip */
    recentExchangeBlock: null,
    hypothesisPortfolio: initialHypothesisPortfolioForRun(base),
    epistemicFusion:
      base.epistemicFusion && typeof base.epistemicFusion === 'object' ? deepClone(base.epistemicFusion) : null,
    workspaceIgnition:
      base.workspaceIgnition && typeof base.workspaceIgnition === 'object'
        ? deepClone(base.workspaceIgnition)
        : null,
  };

  if (!Array.isArray(sharedMemory.workingMemory.items)) sharedMemory.workingMemory.items = [];

  return sharedMemory;
}

/** Slim cross-turn snapshot before clearing `globalWorkspace` for a new user turn. */
export function snapshotGlobalWorkspaceForCarryover(gw) {
  if (!gw || typeof gw !== 'object' || !Object.keys(gw).length) return null;
  const conflicts = Array.isArray(gw.conflicts) ? gw.conflicts : [];
  const openQuestions = Array.isArray(gw.openQuestions) ? gw.openQuestions : [];
  return {
    provisionalStance: String(gw.provisionalStance || '').slice(0, 1200),
    broadcastWinners: Array.isArray(gw.broadcastWinners)
      ? gw.broadcastWinners.map((s) => String(s).slice(0, 280)).filter(Boolean).slice(0, 4)
      : [],
    phenomenalUnity: String(gw.phenomenalUnity || '').slice(0, 16),
    integrationConfidence:
      typeof gw.integrationConfidence === 'number' && Number.isFinite(gw.integrationConfidence)
        ? gw.integrationConfidence
        : null,
    conflictCount: conflicts.length,
    openQuestionCount: openQuestions.length,
    conflictsPreview: conflicts.map((s) => String(s).slice(0, 400)).slice(0, 3),
    openQuestionsPreview: openQuestions.map((s) => String(s).slice(0, 360)).slice(0, 3),
    ...(Array.isArray(gw.hypotheses) && gw.hypotheses.length
      ? { hypotheses: normalizeHypothesisList(gw.hypotheses) }
      : {}),
    at: nowIso(),
  };
}

function applyIntegrationFollowupHints(sharedMemory) {
  const gw = sharedMemory.globalWorkspace;
  if (!gw || typeof gw !== 'object') return;
  const conflicts = Array.isArray(gw.conflicts) ? gw.conflicts : [];
  const ic = Number(gw.integrationConfidence);
  const split = gw.phenomenalUnity === 'split';
  if (split || (Number.isFinite(ic) && ic < getThreshold('integration_confidence_followup', 0.45) && conflicts.length >= 2)) {
    sharedMemory.followupHints = { ...(sharedMemory.followupHints || {}) };
    sharedMemory.followupHints.integrationDissonance = split
      ? 'phenomenalUnity_split'
      : 'low_integration_confidence_multi_conflict';
  }
}

function workspaceMetacognitionHeuristicChecks(sharedMemory) {
  const gw = sharedMemory.globalWorkspace;
  const issues = [];
  if (!gw || typeof gw !== 'object') issues.push('globalWorkspace missing after Integration');
  else {
    const stance = String(gw.provisionalStance || '').trim();
    if (!stance) issues.push('empty provisionalStance');
    const conflicts = Array.isArray(gw.conflicts) ? gw.conflicts : [];
    if (gw.phenomenalUnity === 'split' && conflicts.length >= 2)
      issues.push('split unity with multiple conflicts');
    const ic = Number(gw.integrationConfidence);
    if (Number.isFinite(ic) && ic < 0.35) issues.push('very low integrationConfidence');
  }
  return issues;
}

/** Modules whose raw outputs Voice must not see (critic / tension machinery — use Integration + Narrative only). */
const VOICE_REDACTED_MODULE_OUTPUTS = ['Self-Reflection', 'Contradiction Engine'];

const STRICT_GLOBAL_WORKSPACE_SYSTEM_APPEND = `

STRICT_GLOBAL_WORKSPACE_BROADCAST is enabled: treat GLOBAL_WORKSPACE_JSON in CONTEXT_AND_POLICY as the primary conscious packet for this turn. Do not invent substantive claims from modules omitted from SHARED_MEMORY_JSON.moduleOutputs unless they are implied by the retained summaries or the workspace text.`;

const STRICT_BROADCAST_ALWAYS = new Set([
  'Attention',
  'Contradiction Engine',
  'Reasoning',
  'Integration',
  'Metacognition',
  'Workspace Metacognition',
  'Emotion',
  'Curiosity',
  'Goal Generation',
  'Somatic Marker',
]);

function buildStrictBroadcastHay(sm) {
  const gw = sm.globalWorkspace;
  const chunks = [];
  if (gw && typeof gw === 'object') {
    for (const s of ensureArray(gw.salience)) chunks.push(String(s));
    for (const s of ensureArray(gw.broadcastWinners)) chunks.push(String(s));
    for (const s of ensureArray(gw.conflicts)) chunks.push(String(s));
    for (const s of ensureArray(gw.openQuestions)) chunks.push(String(s));
    for (const t of ensureArray(gw.epistemicThreads)) {
      if (t && typeof t === 'object') {
        chunks.push(String(t.thread || ''), String(t.kind || ''));
      }
    }
    for (const b of ensureArray(gw.bindings)) {
      if (!b || typeof b !== 'object') continue;
      for (const m of ensureArray(b.sourceModules)) chunks.push(String(m));
      chunks.push(String(b.claim || ''));
    }
  }
  return chunks.join('\n').toLowerCase();
}

function moduleReferencedInStrictHay(name, hay) {
  const n = name.toLowerCase();
  if (hay.includes(n)) return true;
  const compact = n.replace(/\s+/g, '');
  return hay.includes(compact);
}

/** Tier moduleOutputs for Language / Narrative / Voice when strictGlobalWorkspaceBroadcast is on. */
function sanitizeModuleOutputsForStrictBroadcast(sharedMemory, moIn, recipientModule) {
  const hay = buildStrictBroadcastHay(sharedMemory);
  const out = {};
  const add = (name, cap) => {
    const v = moIn[name];
    if (v == null || !String(v).trim()) return;
    out[name] = clipTextComplete(String(v), cap, { ellipsis: true });
  };

  for (const name of STRICT_BROADCAST_ALWAYS) {
    const cap = name === 'Emotion' ? 3600 : 5200;
    add(name, cap);
  }

  if (recipientModule === 'Narrative' || recipientModule === 'Voice') {
    add('Language', 8000);
  }
  if (recipientModule === 'Voice') {
    add('Narrative', 12_000);
  }

  for (const m of MODULES) {
    const name = m.name;
    if (out[name] != null) continue;
    if (STRICT_BROADCAST_ALWAYS.has(name)) continue;
    if (recipientModule === 'Voice' && VOICE_REDACTED_MODULE_OUTPUTS.includes(name)) continue;
    if (moduleReferencedInStrictHay(name, hay)) add(name, 4200);
  }

  return out;
}

/** Remove machine-readable Integration tail so Voice does not echo JSON / scores. */
function stripIntegrationJsonTailForVoice(text) {
  const s = String(text ?? '');
  const idx = s.search(/\nINTEGRATION_JSON:\s*\{/i);
  if (idx !== -1) return s.slice(0, idx).trimEnd();
  if (/^\s*INTEGRATION_JSON:\s*\{/i.test(s)) return '';
  return s.trimEnd();
}

/** Remove META_ACTIONS: line(s) after server has parsed them (cleaner graph inspector / SSE). */
export function stripMetaActionsLineFromMetacognition(text) {
  const s = String(text ?? '');
  const lines = s.split(/\r?\n/);
  const kept = lines.filter((line) => !/^\s*META_ACTIONS:\s*/i.test(line.trim()));
  return kept.join('\n').trimEnd();
}

function mergeBeliefTensionLists(prior, extracted, max = 24) {
  const out = [];
  const seen = new Set();
  for (const t of [...ensureArray(prior), ...ensureArray(extracted)]) {
    if (!t || typeof t !== 'object') continue;
    const desc = String(t.description || '').trim();
    if (!desc) continue;
    const sig = `${String(t.key || '')}::${desc.toLowerCase().slice(0, 200)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(t);
  }
  return out.slice(-max);
}

/** Keep only Metacognition supervisor line (PROCEED/RERUN); drop UNCERTAINTY/GAPS/etc. */
function trimMetacognitionOutputForVoice(text) {
  const s = String(text ?? '');
  const first = s.split(/\r?\n/)[0]?.trim() ?? '';
  return first;
}

function sanitizeModuleOutputsForVoice(moIn) {
  const moduleOutputs = { ...moIn };
  for (const k of VOICE_REDACTED_MODULE_OUTPUTS) {
    if (moduleOutputs[k] != null && String(moduleOutputs[k]).trim()) {
      moduleOutputs[k] = `[redacted for Voice — see Integration / Narrative for distilled stance; length ${String(moduleOutputs[k]).length}]`;
    }
  }
  if (typeof moduleOutputs.Integration === 'string') {
    moduleOutputs.Integration = stripIntegrationJsonTailForVoice(moduleOutputs.Integration);
  }
  if (typeof moduleOutputs.Metacognition === 'string') {
    moduleOutputs.Metacognition = trimMetacognitionOutputForVoice(moduleOutputs.Metacognition);
  }
  if (typeof moduleOutputs['Workspace Metacognition'] === 'string') {
    moduleOutputs['Workspace Metacognition'] = trimMetacognitionOutputForVoice(
      moduleOutputs['Workspace Metacognition']
    );
  }
  return moduleOutputs;
}

export function formatSharedMemoryForModule(sharedMemory, recipientModule = null) {
  const moIn = sharedMemory.moduleOutputs && typeof sharedMemory.moduleOutputs === 'object' ? sharedMemory.moduleOutputs : {};
  let moduleOutputs = moIn;
  if (recipientModule === 'Voice') {
    moduleOutputs = sanitizeModuleOutputsForVoice(moIn);
  }
  const strictBroadcast =
    sharedMemory.strictGlobalWorkspaceBroadcast === true &&
    (recipientModule === 'Language' ||
      recipientModule === 'Narrative' ||
      recipientModule === 'Voice');
  if (strictBroadcast) {
    moduleOutputs = sanitizeModuleOutputsForStrictBroadcast(sharedMemory, moduleOutputs, recipientModule);
  }
  // Keep deterministic and bounded; full inspector UI will show the full object.
  const snapshot = {
    sessionId: sharedMemory.sessionId,
    iterationCount: sharedMemory.iterationCount,
    originalInput: clipTextComplete(String(sharedMemory.originalInput ?? ''), 56_000, { ellipsis: false }),
    timestamp: sharedMemory.timestamp,
    emotionalState: sharedMemory.emotionalState,
    activeGoals: sharedMemory.activeGoals,
    identityNarrative: sharedMemory.identityNarrative,
    curiosityQueue: sharedMemory.curiosityQueue,
    somaticReading: sharedMemory.somaticReading,
    contradictions: sharedMemory.contradictions,
    beliefStore: sharedMemory.beliefStore?.slice?.(-25) ?? sharedMemory.beliefStore,
    rerunGuidance: sharedMemory.rerunGuidance,
    metaCognitionFlags: sharedMemory.metaCognitionFlags?.slice?.(-6) ?? sharedMemory.metaCognitionFlags,
    moduleOutputs,
    phase: sharedMemory.phase,
    arousal: sharedMemory.arousal,
    intent: sharedMemory.intent,
    cognitivePolicy: sharedMemory.cognitivePolicy,
    phenomenalNow: sharedMemory.phenomenalNow,
    metacognitionTimeline: sharedMemory.metacognitionTimeline?.slice?.(-8) ?? sharedMemory.metacognitionTimeline,
    beliefTensions: sharedMemory.beliefTensions?.slice?.(-8) ?? sharedMemory.beliefTensions,
    boundaryAudit: sharedMemory.boundaryAudit?.slice?.(-6) ?? sharedMemory.boundaryAudit,
    webFindings: String(sharedMemory.webFindings || '').slice(0, 24_000),
    webFetchLog: (sharedMemory.webFetchLog || []).slice(-12),
    webFetchSuppressedForRun: sharedMemory.webFetchSuppressedForRun === true,
    webFetchSuppressReason: String(sharedMemory.webFetchSuppressReason || '').slice(0, 500),
    structuralSelfModel: (sharedMemory.structuralSelfModel || []).slice(0, 20),
    globalWorkspace: sharedMemory.globalWorkspace,
    workspaceIgnition: sharedMemory.workspaceIgnition ?? null,
    epistemicFusion: slimEpistemicFusion(sharedMemory.epistemicFusion),
    interoception: sharedMemory.interoception,
    workingMemory: sharedMemory.workingMemory,
    outputConstraints: sharedMemory.outputConstraints,
    phaseEffective: sharedMemory.phaseEffective,
    userStancePrediction: sharedMemory.userStancePrediction,
    surpriseAssessment: sharedMemory.surpriseAssessment,
    dmnCarryover:
      typeof sharedMemory.dmnCarryover === 'string'
        ? String(sharedMemory.dmnCarryover).slice(0, 6000)
        : null,
    predictionHistory: (sharedMemory.predictionHistory || []).slice(-8),
    epistemicClaims: (sharedMemory.epistemicClaims || []).slice(0, 14),
    priorTurnPredictionAudit: sharedMemory.priorTurnPredictionAudit || null,
    hypothesisPortfolio: sharedMemory.hypothesisPortfolio || null,
    followupHints:
      sharedMemory.followupHints && typeof sharedMemory.followupHints === 'object'
        ? sharedMemory.followupHints
        : {},
    personalityProfile: sharedMemory.personalityProfile || null,
    priorTurnGlobalWorkspace: sharedMemory.priorTurnGlobalWorkspace || null,
    recentTemporalTimeline: (sharedMemory.recentTemporalTimeline || []).slice(0, 16),
    clientLtmDigest: (sharedMemory.clientLtmDigest || []).slice(0, 12),
    clientBeliefDigest: (sharedMemory.clientBeliefDigest || []).slice(0, 14),
    clientAffectDigest: (sharedMemory.clientAffectDigest || []).slice(0, 6),
    clientBiographyExcerpt: String(sharedMemory.clientBiographyExcerpt || '').slice(0, 2400),
    recentExchangeBlock:
      typeof sharedMemory.recentExchangeBlock === 'string' && sharedMemory.recentExchangeBlock.trim()
        ? clipTextComplete(sharedMemory.recentExchangeBlock.trim(), 14_000, { ellipsis: false })
        : null,
  };

  if (recipientModule === 'Voice') {
    delete snapshot.interoception;
    delete snapshot.recentExchangeBlock;
  }

  return JSON.stringify(snapshot, null, 2);
}

/** Smaller sharedMemory on the wire for SSE `complete` / `pipeline_continuation` (single `data:` line limits / proxies). */
export function slimSharedMemoryForSse(sm) {
  const mo = sm.moduleOutputs || {};
  return {
    sessionId: sm.sessionId,
    iterationCount: sm.iterationCount,
    originalInput: String(sm.originalInput || '').slice(0, 80_000),
    timestamp: sm.timestamp,
    layerOutputs: sm.layerOutputs,
    moduleOutputs: mo,
    beliefStore: (sm.beliefStore || []).slice(-35).map((b) => ({
      ...b,
      belief: String(b.belief || '').slice(0, 3000),
    })),
    activeGoals: sm.activeGoals,
    emotionalState: sm.emotionalState,
    identityNarrative: String(sm.identityNarrative || '').slice(0, 16_000),
    curiosityQueue: (sm.curiosityQueue || []).slice(-18).map((x) => String(x).slice(0, 6000)),
    somaticReading: String(sm.somaticReading || '').slice(0, 12_000),
    contradictions: (sm.contradictions || []).slice(-25),
    narrativeHistory: (sm.narrativeHistory || []).slice(-6).map((x) => String(x).slice(0, 12_000)),
    metaCognitionFlags: (sm.metaCognitionFlags || []).slice(-18),
    metacognitionDeferredReruns: (sm.metacognitionDeferredReruns || []).slice(-12).map((e) => ({
      at: e.at,
      supervisor: String(e.supervisor || ''),
      kind: e.kind === 'heuristic' ? 'heuristic' : 'model',
      reason: String(e.reason || '').slice(0, 1200),
    })),
    rerunGuidance: String(sm.rerunGuidance || '').slice(0, 6000),
    metacognitionRerunsUsed:
      Number.isFinite(Number(sm.metacognitionRerunsUsed)) ? Math.max(0, Math.floor(sm.metacognitionRerunsUsed)) : 0,
    phase: sm.phase,
    arousal: sm.arousal,
    arousalEffective: typeof sm.arousalEffective === 'number' ? sm.arousalEffective : sm.arousal,
    intent: String(sm.intent || '').slice(0, 500),
    cognitivePolicy: sm.cognitivePolicy,
    phenomenalNow: sm.phenomenalNow,
    metacognitionTimeline: (sm.metacognitionTimeline || []).slice(-10),
    beliefTensions: (sm.beliefTensions || []).slice(-12),
    boundaryAudit: (sm.boundaryAudit || []).slice(-8),
    userModel: sm.userModel,
    constitution: String(sm.constitution || '').slice(0, 4000),
    webFindings: String(sm.webFindings || '').slice(0, 12_000),
    webFetchLog: (sm.webFetchLog || []).slice(-8),
    webFetchSuppressedForRun: sm.webFetchSuppressedForRun === true,
    webFetchSuppressReason: String(sm.webFetchSuppressReason || '').slice(0, 500),
    structuralSelfModel: (sm.structuralSelfModel || []).slice(0, 14),
    globalWorkspace: sm.globalWorkspace,
    workspaceIgnition:
      sm.workspaceIgnition && typeof sm.workspaceIgnition === 'object'
        ? {
            rankedTopics: Array.isArray(sm.workspaceIgnition.rankedTopics)
              ? sm.workspaceIgnition.rankedTopics.map((t) => String(t).slice(0, 220)).slice(0, 8)
              : [],
            ...(sm.workspaceIgnition.dominantHypothesisId != null &&
            String(sm.workspaceIgnition.dominantHypothesisId).trim()
              ? {
                  dominantHypothesisId: String(sm.workspaceIgnition.dominantHypothesisId).slice(0, 32),
                }
              : {}),
            conflictPressure:
              typeof sm.workspaceIgnition.conflictPressure === 'number' &&
              Number.isFinite(sm.workspaceIgnition.conflictPressure)
                ? sm.workspaceIgnition.conflictPressure
                : undefined,
            notes: Array.isArray(sm.workspaceIgnition.notes)
              ? sm.workspaceIgnition.notes.map((n) => String(n).slice(0, 48)).slice(0, 6)
              : [],
          }
        : null,
    interoception: sm.interoception,
    workingMemory: sm.workingMemory
      ? { items: (sm.workingMemory.items || []).slice(-10).map((it) => ({ ...it, text: String(it.text || '').slice(0, 600) })) }
      : { items: [] },
    outputConstraints: sm.outputConstraints,
    phaseEffective: sm.phaseEffective,
    userStancePrediction: sm.userStancePrediction,
    surpriseAssessment: sm.surpriseAssessment,
    dmnCarryover:
      typeof sm.dmnCarryover === 'string' ? String(sm.dmnCarryover).slice(0, 4000) : null,
    predictionHistory: (sm.predictionHistory || []).slice(-8),
    epistemicClaims: (sm.epistemicClaims || []).slice(0, 12),
    priorTurnPredictionAudit: sm.priorTurnPredictionAudit || null,
    hypothesisPortfolio:
      sm.hypothesisPortfolio && typeof sm.hypothesisPortfolio === 'object'
        ? {
            source: sm.hypothesisPortfolio.source ?? null,
            hypotheses: Array.isArray(sm.hypothesisPortfolio.hypotheses)
              ? sm.hypothesisPortfolio.hypotheses.slice(0, 8).map((h) => ({
                  id: String(h.id || '').slice(0, 32),
                  label: String(h.label || '').slice(0, 360),
                  weight: h.weight,
                  evidence_for: String(h.evidence_for || '').slice(0, 220),
                  evidence_against: String(h.evidence_against || '').slice(0, 220),
                  would_flip_if: String(h.would_flip_if || '').slice(0, 180),
                }))
              : [],
          }
        : null,
    followupHints: sm.followupHints && typeof sm.followupHints === 'object' ? sm.followupHints : {},
    personalityProfile: sm.personalityProfile || null,
    priorTurnGlobalWorkspace: sm.priorTurnGlobalWorkspace || null,
    recentTemporalTimeline: (sm.recentTemporalTimeline || []).slice(0, 12).map((r) => ({
      title: String(r.title || '').slice(0, 200),
      details: String(r.details || '').slice(0, 360),
      source: String(r.source || '').slice(0, 32),
      created_date: String(r.created_date || '').slice(0, 44),
    })),
    clientLtmDigest: (sm.clientLtmDigest || []).slice(0, 8).map((r) => ({
      title: String(r.title || '').slice(0, 160),
      content: String(r.content || '').slice(0, 280),
      memory_type: String(r.memory_type || '').slice(0, 24),
      created_date: String(r.created_date || '').slice(0, 44),
    })),
    clientBeliefDigest: (sm.clientBeliefDigest || []).slice(0, 8).map((r) => ({
      statement: String(r.statement || '').slice(0, 320),
      confidence: r.confidence,
      category: String(r.category || '').slice(0, 28),
      ...(String(r.status || '').trim() ? { status: String(r.status || '').slice(0, 20) } : {}),
    })),
    clientAffectDigest: (sm.clientAffectDigest || []).slice(0, 4).map((r) => ({
      summary: String(r.summary || '').slice(0, 240),
      created_date: String(r.created_date || '').slice(0, 44),
    })),
    clientBiographyExcerpt: String(sm.clientBiographyExcerpt || '').slice(0, 1800),
    recentExchangeBlock:
      typeof sm.recentExchangeBlock === 'string' && sm.recentExchangeBlock.trim()
        ? String(sm.recentExchangeBlock).slice(0, 12_000)
        : null,
    lastProviderUsed:
      typeof sm.lastProviderUsed === 'string' && sm.lastProviderUsed.trim()
        ? String(sm.lastProviderUsed).slice(0, 64)
        : null,
    lastModelUsed:
      typeof sm.lastModelUsed === 'string' && sm.lastModelUsed.trim()
        ? String(sm.lastModelUsed).slice(0, 220)
        : null,
    epistemicFusion: slimEpistemicFusion(sm.epistemicFusion),
  };
}

/** Fresh layer ledger (matches `createSharedMemory`). */
function emptyLayerOutputs() {
  return {
    layer1: [],
    layer2: [],
    layer3: [],
    layer4: [],
    layer5: [],
    layer6: [],
  };
}

/**
 * Drop prior run’s module-by-module trace so the new `originalInput` isn’t fought by stale Perception→Voice text.
 * Preserves beliefStore, identityN*, userModel-in-sm, workingMemory, etc. See plan: memory vs execution trace.
 */
export function stripPriorPipelineTraceForNewTurn(sharedMemory) {
  if (!sharedMemory || typeof sharedMemory !== 'object') return;
  const gw = sharedMemory.globalWorkspace;
  if (gw && typeof gw === 'object' && Object.keys(gw).length > 0) {
    sharedMemory.priorTurnGlobalWorkspace = snapshotGlobalWorkspaceForCarryover(gw);
  }
  sharedMemory.moduleOutputs = {};
  sharedMemory.layerOutputs = emptyLayerOutputs();
  sharedMemory.rerunGuidance = '';
  sharedMemory.metaCognitionFlags = [];
  sharedMemory.metacognitionDeferredReruns = [];
  sharedMemory.globalWorkspace = null;
  sharedMemory.workspaceIgnition = null;
  sharedMemory.epistemicFusion = null;
  sharedMemory.userStancePrediction = null;
  sharedMemory.surpriseAssessment = null;
  sharedMemory.epistemicClaims = [];
  sharedMemory.metacognitionRerunsUsed = 0;
}

function maybeStripContinuationTrace(sharedMemory, options) {
  if (options?.preserveModuleTrace === true) return;
  if (options?.pipelineMetacognitionContinuation === true) return;
  // Mid-pipeline resume replays prior modules from moduleOutputs; stripping would empty them and break replayFromCache.
  if (normalizeExecutionResume(options?.executionResume)) return;
  stripPriorPipelineTraceForNewTurn(sharedMemory);
}

/** Recency cue: tail of composed input after pipeline `---` separator (current user turn + attachments). */
export function buildPrimaryTurnBlock(originalInput) {
  const sep = '\n---\n\n';
  const s = String(originalInput || '');
  const idx = s.lastIndexOf(sep);
  if (idx === -1) return '';
  const tail = s.slice(idx + sep.length).trim();
  if (!tail) return '';
  const clipped = tail.length > 12000 ? `${tail.slice(0, 12000)}\n[…]` : tail;
  return `PRIMARY_TURN (highest priority — address this first; RECENT_EXCHANGE and older memories in SHARED_MEMORY_JSON are supporting context only unless the user ties them to this turn):\n\n${clipped}`;
}

export function compressSharedMemory(sharedMemory) {
  if (!shouldCompressSharedMemory()) return sharedMemory;
  const MAX_OUTPUT_CHARS = localLlmContextBudgetChars();
  const entries = Object.entries(sharedMemory.moduleOutputs || {});
  const total = entries.reduce((sum, [, v]) => sum + String(v || '').length, 0);
  if (total <= MAX_OUTPUT_CHARS) return sharedMemory;

  // Truncate oldest module outputs to prevent context overflow.
  const byModuleOrder = MODULES.map((m) => m.name);
  const orderIndex = new Map(byModuleOrder.map((name, idx) => [name, idx]));
  const sorted = entries.sort((a, b) => (orderIndex.get(a[0]) ?? 999) - (orderIndex.get(b[0]) ?? 999));

  const next = {};
  for (const [k, v] of sorted) {
    const text = String(v || '');
    const keep = Math.max(500, Math.min(2200, Math.floor((MAX_OUTPUT_CHARS / entries.length) * 1.2)));
    const trimmed = text.length > keep ? `${text.slice(0, keep)}\n\n[...compressed...]` : text;
    next[k] = trimmed;
  }

  sharedMemory.moduleOutputs = next;
  return sharedMemory;
}

function buildRunModuleUserLines(primaryTurnBlock, policyBlock, latestRerun, memoryBodyLabel, memoryBody) {
  const parts = [];
  if (String(primaryTurnBlock || '').trim()) {
    parts.push(String(primaryTurnBlock).trim(), '');
  }
  parts.push(
    'You are running as one module in a sequential cognitive pipeline.',
    'Use ONLY the shared memory provided to you. Do not assume hidden context.',
    latestRerun
      ? `IMPORTANT: This is a rerun pass. Supervisor guidance: ${latestRerun.reason || ''}`
      : '',
    policyBlock,
    '',
    memoryBodyLabel
  );
  if (String(memoryBody ?? '').length) parts.push(memoryBody);
  return parts.join('\n');
}

function reduceStepFitsContext(systemPrompt, reduceUser, options) {
  const wantTok = budgetedCompletionCap(options?.max_tokens, resolveDefaultLocalMaxTokens());
  return (
    estimateTotalRequestTokens(systemPrompt, reduceUser, wantTok) + getLlmContextSlackTokens() <=
    getLlmContextTokensMax()
  );
}

const REASONING_MULTI_SAMPLE_MERGE_SYSTEM = `You merge two Reasoning-module drafts from the same pipeline step (identical upstream context). Output a single Reasoning-shaped reply that:
- Uses headings PREMISES / INFERENCE / CONCLUSIONS / UNCERTAINTY as the Reasoning module does (omit empty sections).
- Keeps the strongest evidence; if the drafts disagree, say so under UNCERTAINTY without naming "draft A/B".
- Ends with exactly one line: HYPOTHESES_JSON: {"hypotheses":[...]} combining both drafts’ hypotheses (max 6), deduplicating near-duplicate labels, reweighting relative plausibility 0–1 (need not sum to 1).
- If a draft ended with WEB_REQUEST per pipeline rules, you may include at most one WEB_REQUEST block at the very end of your output; otherwise omit it.
- Write as the sole Reasoning output — no meta about merging.`;

function reasoningBodyWithoutHypothesesMarker(text) {
  const s = String(text || '');
  const m = s.match(/\nHYPOTHESES_JSON:\s*\{/i);
  const cut = m ? s.indexOf(m[0]) : -1;
  if (cut !== -1) return s.slice(0, cut).trimEnd();
  if (/^\s*HYPOTHESES_JSON:\s*\{/im.test(s)) return '';
  return s.trimEnd();
}

function extractHypothesesArrayFromReasoningOutput(text) {
  const j = parseJsonAfterMarker(text, 'HYPOTHESES_JSON');
  return j && typeof j === 'object' ? normalizeHypothesisList(j.hypotheses) : [];
}

function mergeReasoningHypothesisListsUnsorted(listA, listB) {
  const map = new Map();
  for (const h of [...listA, ...listB]) {
    if (!h || typeof h !== 'object' || !String(h.label || '').trim()) continue;
    const key = String(h.label || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 96);
    const prev = map.get(key);
    const w = Number(h.weight);
    const wn = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.5;
    if (!prev || wn > prev.weight) map.set(key, { ...h, weight: wn });
  }
  return normalizeHypothesisList([...map.values()]);
}

function mergeReasoningSamplesMechanical(textA, textB) {
  const bodyA = reasoningBodyWithoutHypothesesMarker(textA);
  const bodyB = reasoningBodyWithoutHypothesesMarker(textB);
  const primary = bodyA.length >= bodyB.length ? bodyA : bodyB;
  const ha = extractHypothesesArrayFromReasoningOutput(textA);
  const hb = extractHypothesesArrayFromReasoningOutput(textB);
  const merged = mergeReasoningHypothesisListsUnsorted(ha, hb);
  if (!merged.length) return primary.length ? primary : String(textB || textA || '');
  return `${primary}\n\nHYPOTHESES_JSON: ${JSON.stringify({ hypotheses: merged })}`;
}

async function mergeTwoReasoningSamplesWithLlm(textA, textB, callLLM, callOpts) {
  const user = [
    'DRAFT_A:',
    String(textA || '').slice(0, 28000),
    '',
    'DRAFT_B:',
    String(textB || '').slice(0, 28000),
  ].join('\n');
  const maxTok = Math.max(
    budgetedCompletionCap(callOpts?.max_tokens, resolveDefaultLocalMaxTokens()),
    2200
  );
  return callLLM(REASONING_MULTI_SAMPLE_MERGE_SYSTEM, user, {
    ...callOpts,
    max_tokens: maxTok,
    temperature: 0.35,
    disableSoftTimeout: true,
    _fixedTemp: true,
  });
}

const INTEGRATION_MULTI_SAMPLE_MERGE_SYSTEM =
  'You receive two Integration drafts (DRAFT_A and DRAFT_B). Merge into one final Integration output: average hypothesis weights, union conflicts, consensus on phenomenalUnity (if both agree, keep it; if they differ, use "partial"), keep the higher integrationConfidence. Output the merged Integration with a final INTEGRATION_JSON line.';

function mergeIntegrationSamplesMechanical(textA, textB) {
  const extractJson = (t) => {
    const m = String(t || '').match(/INTEGRATION_JSON:\s*(\{[\s\S]*\})\s*$/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  };
  const a = extractJson(textA);
  const b = extractJson(textB);
  if (!a && !b) return textA || textB || '';
  if (!a) return textB;
  if (!b) return textA;

  const merged = { ...a };
  if (Array.isArray(a.hypotheses) && Array.isArray(b.hypotheses)) {
    const byId = new Map();
    for (const h of [...a.hypotheses, ...b.hypotheses]) {
      const ex = byId.get(h.id);
      if (ex) {
        ex.weight = Math.round(((ex.weight + h.weight) / 2) * 1000) / 1000;
      } else {
        byId.set(h.id, { ...h });
      }
    }
    merged.hypotheses = [...byId.values()];
  }
  const aConf = typeof a.integrationConfidence === 'number' ? a.integrationConfidence : 0;
  const bConf = typeof b.integrationConfidence === 'number' ? b.integrationConfidence : 0;
  merged.integrationConfidence = Math.max(aConf, bConf);

  if (a.phenomenalUnity === b.phenomenalUnity) {
    merged.phenomenalUnity = a.phenomenalUnity;
  } else {
    merged.phenomenalUnity = 'partial';
  }

  const allConflicts = [...(a.conflicts || []), ...(b.conflicts || [])];
  merged.conflicts = [...new Set(allConflicts)].slice(0, 8);

  const proseA = String(textA || '').replace(/INTEGRATION_JSON:[\s\S]*$/, '').trim();
  const proseB = String(textB || '').replace(/INTEGRATION_JSON:[\s\S]*$/, '').trim();
  const prose = proseA.length >= proseB.length ? proseA : proseB;
  return `${prose}\n\nINTEGRATION_JSON: ${JSON.stringify(merged)}`;
}

function mergeContradictionSamplesMechanical(textA, textB) {
  const extractTensions = (t) => {
    const lines = String(t || '').split(/\n/);
    return lines
      .filter((l) => l.trim().startsWith('-') || l.trim().startsWith('*'))
      .map((l) => l.replace(/^[\s\-*]+/, '').trim())
      .filter(Boolean);
  };
  const tA = extractTensions(textA);
  const tB = extractTensions(textB);
  const all = [...tA];
  for (const t of tB) {
    const isDup = all.some((ex) => {
      const tokA = new Set(ex.toLowerCase().split(/\s+/));
      const tokB = new Set(t.toLowerCase().split(/\s+/));
      let inter = 0;
      for (const w of tokA) if (tokB.has(w)) inter++;
      const union = tokA.size + tokB.size - inter;
      return union > 0 && inter / union > 0.5;
    });
    if (!isDup) all.push(t);
  }
  if (!all.length) return 'TENSIONS\nNONE';
  return 'TENSIONS\n' + all.map((t) => `- ${t}`).join('\n');
}

async function runModuleMultiSample(moduleName, callLLM, systemPrompt, userContent, callOpts) {
  const baseTemp = callOpts.temperature ?? 0.55;
  const secondTemp = Math.min(1.2, baseTemp + 0.2);

  const [r1, r2] = await Promise.all([
    callLLM(systemPrompt, userContent, callOpts),
    callLLM(systemPrompt, userContent, { ...callOpts, temperature: secondTemp, _fixedTemp: true }),
  ]);

  const mode = multiSampleMergeMode();

  if (moduleName === 'Integration') {
    if (mode === 'mechanical') {
      return { text: mergeIntegrationSamplesMechanical(r1.text, r2.text), provider: r1.provider, model: r1.model, partialDueToSoftTimeout: false };
    }
    const user = `DRAFT_A:\n${String(r1.text || '').slice(0, 28000)}\n\nDRAFT_B:\n${String(r2.text || '').slice(0, 28000)}`;
    const rM = await callLLM(INTEGRATION_MULTI_SAMPLE_MERGE_SYSTEM, user, {
      ...callOpts, temperature: 0.35, disableSoftTimeout: true, _fixedTemp: true,
    });
    return rM;
  }

  if (moduleName === 'Contradiction Engine') {
    return { text: mergeContradictionSamplesMechanical(r1.text, r2.text), provider: r1.provider, model: r1.model, partialDueToSoftTimeout: false };
  }

  return r1;
}

function sleepIngestRetry(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** False when retrying cannot help (context, config, wrong model id). */
function mapIngestErrorIsRetryable(err) {
  const blob = `${err?.message ?? ''} ${JSON.stringify(err?.failures || [])}`.toLowerCase();
  if (/context|n_ctx|n_keep|maximum context|too many tokens|context length/.test(blob)) return false;
  if (/no llm configured/.test(blob)) return false;
  if (/model_not_found|invalid model|does not exist/.test(blob)) return false;
  const failures = err?.failures;
  if (Array.isArray(failures) && failures.length) {
    const all404 = failures.every((f) => {
      const st = f?.error?.status;
      return st === 404;
    });
    if (all404) return false;
    return failures.some((f) => {
      const st = f?.error?.status;
      if (st === 429 || st === 502 || st === 503 || st === 504 || st === 408) return true;
      const m = String(f?.error?.message || '').toLowerCase();
      return (
        m.includes('timeout') ||
        m.includes('timed out') ||
        m.includes('econnreset') ||
        m.includes('etimedout') ||
        m.includes('fetch failed') ||
        m.includes('overload') ||
        m.includes('temporarily') ||
        m.includes('service unavailable') ||
        m.includes('bad gateway')
      );
    });
  }
  return true;
}

/** Chunked map steps issue many small LLM calls; one transient HF/router blip at "ingest 4/9" should not kill the run. */
async function callLlmForMapIngestChunk(callLLM, systemPrompt, userContent, callOpts) {
  const raw = String(process.env.LLM_INGEST_MAP_MAX_ATTEMPTS || '').trim();
  const parsed = Number.parseInt(raw, 10);
  const maxAttempts = Math.min(8, Math.max(1, Number.isFinite(parsed) && parsed > 0 ? parsed : 3));
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callLLM(systemPrompt, userContent, callOpts);
    } catch (e) {
      lastErr = e;
      if (attempt >= maxAttempts || !mapIngestErrorIsRetryable(e)) throw e;
      const delay = Math.min(12_000, 900 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500));
      console.warn(
        `[runModule] map-ingest LLM failed (attempt ${attempt}/${maxAttempts}): ${e?.message || e} — waiting ${delay}ms`
      );
      await sleepIngestRetry(delay);
    }
  }
  throw lastErr;
}

export async function runModule({ moduleName, sharedMemory, callLLM, options, onChunkedProgress } = {}) {
  if (shouldCompressSharedMemory()) compressSharedMemory(sharedMemory);
  const mod = getModuleByName(moduleName);
  if (!mod) throw new Error(`Unknown module: ${moduleName}`);

  const latestRerun = sharedMemory.metaCognitionFlags?.slice?.(-1)?.[0];
  const primaryTurnBlock = buildPrimaryTurnBlock(sharedMemory.originalInput);
  const policyBlock = buildMindContextForModule(moduleName, sharedMemory);
  const smJson = formatSharedMemoryForModule(sharedMemory, moduleName);
  const userContentSingle = buildRunModuleUserLines(
    primaryTurnBlock,
    policyBlock,
    latestRerun,
    'SHARED_MEMORY_JSON:',
    smJson
  );

  const rawOverride = options?.modulePromptOverrides?.[moduleName];
  let systemPrompt = mod.systemPrompt;
  if (typeof rawOverride === 'string' && rawOverride.trim()) {
    const clipped =
      rawOverride.length > MODULE_PROMPT_OVERRIDE_MAX_LEN
        ? rawOverride.slice(0, MODULE_PROMPT_OVERRIDE_MAX_LEN)
        : rawOverride;
    systemPrompt = clipped;
  }

  if (
    sharedMemory.strictGlobalWorkspaceBroadcast === true &&
    (moduleName === 'Language' || moduleName === 'Narrative' || moduleName === 'Voice')
  ) {
    systemPrompt += STRICT_GLOBAL_WORKSPACE_SYSTEM_APPEND;
  }

  const defaultMax = resolveDefaultLocalMaxTokens();
  const useChunked = shouldUseChunkedModuleCalls(systemPrompt, userContentSingle, options?.max_tokens, defaultMax);

  let text;
  let provider;
  let model;
  let outputPartialBySoftTimeout = false;

  if (!useChunked) {
    let callOpts = moduleName === 'Integration' ? { ...options, disableSoftTimeout: true } : { ...options };
    if (shouldAdaptTemperature(moduleName, callOpts)) {
      callOpts.temperature = resolveAdaptiveTemperature(sharedMemory, callOpts);
    }
    const r = await callLLM(systemPrompt, userContentSingle, callOpts);
    text = r.text;
    provider = r.provider;
    model = r.model;
    outputPartialBySoftTimeout = Boolean(r.partialDueToSoftTimeout);

    if (moduleName === 'Reasoning' && reasoningMultiSampleEnabled()) {
      const t2 = reasoningMultiSampleSecondTemperature();
      try {
        const r2 = await callLLM(systemPrompt, userContentSingle, {
          ...callOpts,
          temperature: t2,
        });
        outputPartialBySoftTimeout = outputPartialBySoftTimeout || Boolean(r2.partialDueToSoftTimeout);
        const mode = reasoningMultiSampleMergeMode();
        if (mode === 'mechanical') {
          text = mergeReasoningSamplesMechanical(r.text, r2.text);
        } else {
          const rM = await mergeTwoReasoningSamplesWithLlm(r.text, r2.text, callLLM, callOpts);
          text = rM.text;
          provider = rM.provider;
          model = rM.model;
          outputPartialBySoftTimeout = outputPartialBySoftTimeout || Boolean(rM.partialDueToSoftTimeout);
        }
      } catch (e) {
        console.warn('[runModule] Reasoning multi-sample merge failed; using first sample.', e?.message || e);
        text = r.text;
      }
    }

    if (moduleName === 'Integration' && integrationMultiSampleEnabled()) {
      try {
        const msResult = await runModuleMultiSample('Integration', callLLM, systemPrompt, userContentSingle, callOpts);
        text = msResult.text;
        provider = msResult.provider || provider;
        model = msResult.model || model;
      } catch (e) {
        console.warn('[runModule] Integration multi-sample failed; using first sample.', e?.message || e);
      }
    }

    if (moduleName === 'Contradiction Engine' && contradictionMultiSampleEnabled()) {
      try {
        const msResult = await runModuleMultiSample('Contradiction Engine', callLLM, systemPrompt, userContentSingle, callOpts);
        text = msResult.text;
        provider = msResult.provider || provider;
        model = msResult.model || model;
      } catch (e) {
        console.warn('[runModule] Contradiction multi-sample failed; using first sample.', e?.message || e);
      }
    }
  } else {
    const mapSys = mapIngestSystemPrompt();
    const mapMaxTokens = 512;
    const fragBudget = computeMapFragmentCharBudget(mapSys, mapMaxTokens);
    const chunks = splitTextIntoChunks(smJson, fragBudget);
    console.log(`[runModule] chunked map/reduce for "${moduleName}": ${chunks.length} SHARED_MEMORY_JSON fragment(s)`);
    onChunkedProgress?.({ phase: 'chunked_ingest', totalChunks: chunks.length });

    const mapResults = [];
    for (let i = 0; i < chunks.length; i += 1) {
      onChunkedProgress?.({ phase: 'map_chunk', chunkIndex: i + 1, totalChunks: chunks.length });
      const mapUserRaw = mapIngestUserPrompt(i, chunks.length, chunks[i]);
      const mapUser = truncateUserContentToContext(mapSys, mapUserRaw, mapMaxTokens, mapMaxTokens);
      const r = await callLlmForMapIngestChunk(callLLM, mapSys, mapUser, {
        ...options,
        max_tokens: mapMaxTokens,
        temperature: 0.2,
        disableSoftTimeout: true,
        disableStallWatchdog: true,
      });
      const j = extractFirstJsonObject(r.text);
      mapResults.push({
        chunkIndex: typeof j?.chunkIndex === 'number' ? j.chunkIndex : i,
        bullets: Array.isArray(j?.bullets) ? j.bullets : [],
      });
      provider = r.provider;
      model = r.model;
    }

    let mergedBullets = mergeMapBullets(mapResults);
    const ingestPrefix = buildRunModuleUserLines(
      primaryTurnBlock,
      policyBlock,
      latestRerun,
      'PIPELINE_CONTEXT_INGEST_JSON (fragments merged server-side; full shared memory is unchanged in RAM):',
      ''
    );

    let ingestBody = JSON.stringify({ fragmentCount: chunks.length, bullets: mergedBullets }, null, 2);
    let reduceUser = `${ingestPrefix}\n${ingestBody}`;

    let tier = 0;
    const maxTier = 8;
    const wantTok = budgetedCompletionCap(options?.max_tokens, defaultMax);
    const cpt = getTokenCharsPerToken();

    while (!reduceStepFitsContext(systemPrompt, reduceUser, options) && tier < maxTier) {
      tier += 1;
      console.warn(`[runModule] ingest shrink tier ${tier} for "${moduleName}"`);
      onChunkedProgress?.({ phase: 'ingest_shrink', tier, maxTier });
      const cap = getLlmContextTokensMax();
      const slack = getLlmContextSlackTokens();
      const maxPromptTok = cap - slack - wantTok - 8;
      const targetChars = Math.max(
        400,
        Math.floor(Math.max(0, maxPromptTok - estimatePromptTokens(systemPrompt, ingestPrefix)) * cpt * 0.85)
      );
      mergedBullets = await coalesceBulletsForBudget({
        bullets: mergedBullets,
        callLLM,
        options: { ...options, disableStallWatchdog: true },
        targetBodyChars: targetChars,
        maxRounds: 4,
      });
      ingestBody = JSON.stringify({ fragmentCount: chunks.length, bullets: mergedBullets }, null, 2);
      if (ingestBody.length > targetChars * 1.5) {
        mergedBullets = await ingestJsonStringViaMapChunks(ingestBody, callLLM, {
          ...options,
          disableStallWatchdog: true,
        });
        ingestBody = JSON.stringify({ fragmentCount: chunks.length, bullets: mergedBullets }, null, 2);
      }
      reduceUser = `${ingestPrefix}\n${ingestBody}`;
    }

    if (!reduceStepFitsContext(systemPrompt, reduceUser, options)) {
      console.warn(`[runModule] mechanical ingest squeeze for "${moduleName}" after ${tier} tier(s)`);
      let b = [...mergedBullets];
      let squeezedOk = false;
      for (let s = 0; s < 36; s += 1) {
        const bodyTry = JSON.stringify({ fragmentCount: chunks.length, bullets: b }, null, 2);
        const ru = `${ingestPrefix}\n${bodyTry}`;
        if (reduceStepFitsContext(systemPrompt, ru, options)) {
          mergedBullets = b;
          ingestBody = bodyTry;
          reduceUser = ru;
          squeezedOk = true;
          break;
        }
        if (b.length > 1) {
          b = b.slice(0, Math.max(1, Math.ceil(b.length * 0.55)));
        }
        const cap = Math.max(48, Math.floor(900 / (s / 6 + 1)));
        b = b.map((x) => clipTextComplete(String(x || ''), cap, { ellipsis: false }));
      }
      if (!squeezedOk) {
        ingestBody = JSON.stringify({ fragmentCount: chunks.length, bullets: b }, null, 2);
        reduceUser = `${ingestPrefix}\n${ingestBody}`;
      }
      if (!reduceStepFitsContext(systemPrompt, reduceUser, options)) {
        mergedBullets = ['[ingest truncated for LLM_CONTEXT_TOKENS_MAX; full shared memory remains server-side]'];
        ingestBody = JSON.stringify({ fragmentCount: chunks.length, bullets: mergedBullets }, null, 2);
        reduceUser = `${ingestPrefix}\n${ingestBody}`;
      }
    }

    /** Chunked reduce: if ingest is already minimal, CONTEXT_AND_POLICY + PRIMARY_TURN may still overflow the budget. */
    if (!reduceStepFitsContext(systemPrompt, reduceUser, options)) {
      console.warn(`[runModule] emergency context clip for chunked reduce "${moduleName}"`);
      const POL_TAG =
        '\n\n[CONTEXT_AND_POLICY clipped for LLM_CONTEXT_TOKENS_MAX; server retains full policy.]';
      const PRIM_TAG = '\n\n[PRIMARY_TURN clipped for token budget.]';
      const fullPolLen = String(policyBlock || '').length;
      const fullPrimLen = String(primaryTurnBlock || '').length;
      let polLen = fullPolLen;
      let primLen = fullPrimLen;
      for (
        let round = 0;
        round < 80 && !reduceStepFitsContext(systemPrompt, reduceUser, options);
        round += 1
      ) {
        if (polLen > 240 && (round % 2 === 0 || primLen <= 96)) {
          polLen = Math.max(240, Math.floor(polLen * 0.76));
        } else if (primLen > 96) {
          primLen = Math.max(96, Math.floor(primLen * 0.76));
        } else {
          polLen = Math.max(120, polLen - 280);
          if (polLen <= 120 && primLen <= 96) break;
        }
        const polClip =
          polLen >= fullPolLen
            ? String(policyBlock || '')
            : clipTextComplete(String(policyBlock || ''), polLen, { ellipsis: false }) + POL_TAG;
        const primClip =
          primLen >= fullPrimLen
            ? primaryTurnBlock
            : clipTextComplete(String(primaryTurnBlock || ''), primLen, { ellipsis: false }) + PRIM_TAG;
        const ingestPrefixEmergency = buildRunModuleUserLines(
          primClip,
          polClip,
          latestRerun,
          'PIPELINE_CONTEXT_INGEST_JSON (fragments merged server-side; full shared memory is unchanged in RAM):',
          ''
        );
        reduceUser = `${ingestPrefixEmergency}\n${ingestBody}`;
      }
    }

    if (!reduceStepFitsContext(systemPrompt, reduceUser, options)) {
      const cap = getLlmContextTokensMax();
      throw new Error(
        `Pipeline module "${moduleName}": prompt still exceeds LLM_CONTEXT_TOKENS_MAX (${cap}) after ${tier} ingest shrink tier(s) and emergency policy clip. ` +
          `Fix: (1) In LM Studio / your host, raise model context (n_ctx) to match or exceed this budget, then set LLM_CONTEXT_TOKENS_MAX slightly below n_ctx. ` +
          `(2) Lower Settings → pipeline max tokens (reserves less for completion). ` +
          `(3) Set LOCAL_LLM_COMPRESS_SHARED_MEMORY=1 and optionally LOCAL_LLM_CONTEXT_BUDGET_CHARS=6000–10000. ` +
          `(4) Shorter user input / reset Graph Pipeline session to trim PRIMARY_TURN and digests. ` +
          `(5) If LLM_CONTEXT_TOKENS_MAX is already above real n_ctx, lower it to ~n_ctx−64 so estimates match hardware.`
      );
    }

    onChunkedProgress?.({ phase: 'reduce' });
    const r = await callLLM(systemPrompt, reduceUser, { ...options, disableStallWatchdog: true });
    text = r.text;
    provider = r.provider;
    model = r.model;
    outputPartialBySoftTimeout = Boolean(r.partialDueToSoftTimeout);

    if (moduleName === 'Reasoning' && reasoningMultiSampleEnabled()) {
      const t2 = reasoningMultiSampleSecondTemperature();
      try {
        const r2 = await callLLM(systemPrompt, reduceUser, {
          ...options,
          temperature: t2,
          disableStallWatchdog: true,
        });
        outputPartialBySoftTimeout = outputPartialBySoftTimeout || Boolean(r2.partialDueToSoftTimeout);
        const mode = reasoningMultiSampleMergeMode();
        if (mode === 'mechanical') {
          text = mergeReasoningSamplesMechanical(r.text, r2.text);
        } else {
          const rM = await mergeTwoReasoningSamplesWithLlm(r.text, r2.text, callLLM, options);
          text = rM.text;
          provider = rM.provider;
          model = rM.model;
          outputPartialBySoftTimeout = outputPartialBySoftTimeout || Boolean(rM.partialDueToSoftTimeout);
        }
      } catch (e) {
        console.warn('[runModule] Reasoning multi-sample (chunked) merge failed; using first sample.', e?.message || e);
        text = r.text;
      }
    }
  }

  sharedMemory.moduleOutputs[moduleName] = text;
  const meta = { provider, model, at: nowIso() };
  if (outputPartialBySoftTimeout) meta.partialDueToSoftTimeout = true;
  sharedMemory.moduleOutputs[`${moduleName}__meta`] = meta;

  return { sharedMemory, output: text, provider, model, outputPartialBySoftTimeout };
}

function pushLayerOutput(sharedMemory, layerKey, moduleName) {
  if (!sharedMemory.layerOutputs?.[layerKey]) sharedMemory.layerOutputs[layerKey] = [];
  sharedMemory.layerOutputs[layerKey].push({
    module: moduleName,
    at: nowIso(),
  });
}

function applyBeliefRevisionsFromOutput(sharedMemory, text) {
  const parsed = parseJsonAfterMarker(text, 'BELIEF_REVISIONS');
  if (!parsed || typeof parsed !== 'object') return;
  const revs = parsed.revisions;
  if (!Array.isArray(revs)) return;
  sharedMemory.beliefStore = ensureArray(sharedMemory.beliefStore);
  for (const r of revs.slice(0, 20)) {
    const ref = String(r?.ref || '').trim();
    const action = String(r?.action || '').toLowerCase();
    const nc = Number(r?.newConfidence);
    if (!ref) continue;
    for (const b of sharedMemory.beliefStore) {
      const blob = String(b.belief || '');
      if (!blob.includes(ref) && ref.length > 3 && !blob.slice(0, 400).includes(ref.slice(0, 80))) continue;
      if (action === 'downgrade' || action === 'weaken') {
        const c0 = typeof b.confidence === 'number' ? b.confidence : 0.5;
        b.confidence = Math.max(0.05, Number.isFinite(nc) ? nc : c0 * 0.75);
      } else if (action === 'strengthen' || action === 'reinforce') {
        const c0 = typeof b.confidence === 'number' ? b.confidence : 0.5;
        b.confidence = Math.min(1, Number.isFinite(nc) ? nc : c0 + 0.12);
      } else if (action === 'remove' || action === 'supersede') {
        b.confidence = Math.min(b.confidence || 0.2, 0.08);
        b.superseded = true;
      } else if (action === 'resolve' || action === 'resolved' || action === 'mark_resolved') {
        b.status = 'resolved';
        if (Array.isArray(b.contradicts)) b.contradicts = [];
      }
      b.lastUpdated = nowIso();
      break;
    }
  }
}

function updateDerivedFields(sharedMemory, moduleName) {
  const out = sharedMemory.moduleOutputs[moduleName];
  if (!out) return;

  if (moduleName === 'Attention') {
    if (!sharedMemory.workingMemory) sharedMemory.workingMemory = { items: [] };
    const lines = String(out)
      .split('\n')
      .map((l) => l.replace(/^[-*•\d.)]+\s*/, '').trim())
      .filter((l) => l.length > 15 && l.length < 900);
    const existing = [...(sharedMemory.workingMemory.items || [])];
    let n = existing.length;
    for (const line of lines.slice(0, 5)) {
      if (existing.some((e) => e.text === line)) continue;
      existing.push({
        id: `wm_att_${n++}_${Date.now()}`,
        text: line,
        source: 'attention',
        createdAt: nowIso(),
      });
    }
    sharedMemory.workingMemory.items = existing.slice(-12);
    refreshInteroceptionAndPolicy(sharedMemory);
  }

  if (moduleName === 'Planning') {
    const pred = parseJsonAfterMarker(out, 'USER_STANCE_PREDICTION');
    if (pred && typeof pred === 'object') {
      sharedMemory.userStancePrediction = {
        expectUserWants: String(pred.expectUserWants || pred.summary || '').slice(0, 1200),
        confidence: clamp01(pred.confidence, 0.5),
      };
    }
  }

  if (moduleName === 'Reasoning') {
    const hpJson = parseJsonAfterMarker(out, 'HYPOTHESES_JSON');
    const hyps =
      hpJson && typeof hpJson === 'object' ? normalizeHypothesisList(hpJson.hypotheses) : [];
    sharedMemory.hypothesisPortfolio = { hypotheses: hyps, at: nowIso() };
  }

  if (moduleName === 'Learning') {
    const sur = parseJsonAfterMarker(out, 'SURPRISE_ASSESSMENT');
    if (sur && typeof sur === 'object') {
      sharedMemory.surpriseAssessment = {
        score: clamp01(sur.score ?? sur.surprise, 0.3),
        note: String(sur.note || '').slice(0, 800),
      };
    }
    const promote = parseJsonAfterMarker(out, 'WORKING_MEMORY_PROMOTE');
    if (promote && Array.isArray(promote.ids)) {
      sharedMemory.workingMemoryPromoteIds = promote.ids.map((x) => String(x)).slice(0, 10);
    }
    refreshInteroceptionAndPolicy(sharedMemory);
  }

  if (moduleName === 'Emotion') {
    sharedMemory.emotionalState = { primary: 'modeled', intensity: 0.6, nuance: String(out).slice(0, 400) };
  }
  if (moduleName === 'Identity') {
    sharedMemory.identityNarrative = String(out);
  }
  if (moduleName === 'Curiosity') {
    sharedMemory.curiosityQueue = [...ensureArray(sharedMemory.curiosityQueue), String(out)].slice(-25);
  }
  if (moduleName === 'Goal Generation') {
    const longTerm = [...ensureArray(sharedMemory.activeGoals?.longTerm), String(out)].slice(-25);
    sharedMemory.activeGoals = { ...(sharedMemory.activeGoals || {}), longTerm };
  }
  if (moduleName === 'Somatic Marker') {
    sharedMemory.somaticReading = String(out);
  }
  if (moduleName === 'Contradiction Engine') {
    sharedMemory.contradictions = ensureArray(sharedMemory.contradictions);
    const extracted = extractBeliefTensionsFromContradiction(out);
    if (extracted.length) {
      sharedMemory.followupHints = { ...(sharedMemory.followupHints || {}), beliefTensionReview: true };
    }
    sharedMemory.beliefTensions = mergeBeliefTensionLists(sharedMemory.beliefTensions, extracted, 24);
    applyContradictionToEmotionalState(sharedMemory, out, extracted);
    refreshInteroceptionAndPolicy(sharedMemory);
  }
  if (moduleName === 'Belief Store') {
    const ep = parseJsonAfterMarker(out, 'EPISTEMIC_CLAIMS');
    const epNorm = normalizeEpistemicClaims(ep);
    if (epNorm.length) sharedMemory.epistemicClaims = epNorm;
    applyBeliefRevisionsFromOutput(sharedMemory, out);
    sharedMemory.beliefStore = ensureArray(sharedMemory.beliefStore);
    sharedMemory.beliefStore.push({
      belief: String(out),
      confidence: 0.5,
      sourceModule: moduleName,
      lastUpdated: nowIso(),
    });
    sharedMemory.beliefStore = sharedMemory.beliefStore.slice(-200);
  }
  if (moduleName === 'Integration') {
    let gw = parseJsonAfterMarker(out, 'INTEGRATION_JSON');
    if (!gw || typeof gw !== 'object') {
      gw = parseIntegrationJsonLoose(out);
    }
    if (gw && typeof gw === 'object') {
      const epistemicThreads = Array.isArray(gw.epistemicThreads)
        ? gw.epistemicThreads
            .map((t) => {
              if (!t || typeof t !== 'object') return null;
              return {
                thread: String(t.thread || '').slice(0, 400),
                kind: String(t.kind || 'unknown').slice(0, 24),
              };
            })
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const unityRaw = String(gw.phenomenalUnity || '').toLowerCase();
      const phenomenalUnity =
        unityRaw === 'unified' || unityRaw === 'split' || unityRaw === 'partial' ? unityRaw : 'partial';
      const iit = gw.iitProxy && typeof gw.iitProxy === 'object' ? gw.iitProxy : null;
      const iitProxy = iit
        ? {
            causalTightness: clamp01(iit.causalTightness, 0.5),
            note: String(iit.note || '').slice(0, 320),
          }
        : null;
      const broadcastWinners = Array.isArray(gw.broadcastWinners)
        ? gw.broadcastWinners.map((s) => String(s).slice(0, 280)).filter(Boolean).slice(0, 4)
        : [];
      const bindingsRaw = Array.isArray(gw.bindings) ? gw.bindings : [];
      const bindings = [];
      for (const b of bindingsRaw.slice(0, 10)) {
        if (!b || typeof b !== 'object') continue;
        const mods = Array.isArray(b.sourceModules)
          ? b.sourceModules
              .map((x) => String(x).trim())
              .filter((name) => VALID_PIPELINE_MODULE_NAMES.has(name))
              .slice(0, 6)
          : [];
        const claim = String(b.claim || '').trim().slice(0, 400);
        if (!claim || !mods.length) continue;
        bindings.push({ sourceModules: mods, claim });
      }
      let hypothesesNorm = [];
      if (Array.isArray(gw.hypotheses)) {
        hypothesesNorm = normalizeHypothesisList(gw.hypotheses);
      } else if (sharedMemory.hypothesisPortfolio?.hypotheses?.length) {
        hypothesesNorm = normalizeHypothesisList(sharedMemory.hypothesisPortfolio.hypotheses);
      }
      sharedMemory.globalWorkspace = {
        salience: Array.isArray(gw.salience) ? gw.salience.map((s) => String(s).slice(0, 400)).slice(0, 12) : [],
        conflicts: Array.isArray(gw.conflicts) ? gw.conflicts.map((s) => String(s).slice(0, 500)).slice(0, 8) : [],
        openQuestions: Array.isArray(gw.openQuestions)
          ? gw.openQuestions.map((s) => String(s).slice(0, 400)).slice(0, 10)
          : [],
        provisionalStance: String(gw.provisionalStance || '').slice(0, 1200),
        integrationConfidence: clamp01(gw.integrationConfidence, 0.55),
        broadcastWinners,
        phenomenalUnity,
        unityRationale: String(gw.unityRationale || '').slice(0, 400),
        ...(iitProxy ? { iitProxy } : {}),
        epistemicThreads,
        ...(bindings.length ? { bindings } : {}),
        ...(hypothesesNorm.length ? { hypotheses: hypothesesNorm } : {}),
      };
    } else {
      console.warn('[pipeline] Integration module did not produce parseable INTEGRATION_JSON — using fallback globalWorkspace. Output length:', String(out || '').length);
      sharedMemory.globalWorkspace = buildFallbackGlobalWorkspace(out, sharedMemory);
    }
    refreshInteroceptionAndPolicy(sharedMemory);
  }
  if (moduleName === 'Narrative') {
    sharedMemory.narrativeHistory = ensureArray(sharedMemory.narrativeHistory);
    sharedMemory.narrativeHistory.push(String(out));
    sharedMemory.narrativeHistory = sharedMemory.narrativeHistory.slice(-50);
  }
  if (moduleName === 'Voice' && isBeliefTensionReviewPrimaryTurn(sharedMemory.originalInput)) {
    applyBeliefRevisionsFromOutput(sharedMemory, String(out));
  }
  if (moduleName === 'Identity') {
    sharedMemory.phenomenalNow = synthesizePhenomenalNow(sharedMemory);
  }
  if (moduleName === 'Emotion' || moduleName === 'Somatic Marker' || moduleName === 'Curiosity') {
    refreshPolicyAfterAffect(sharedMemory);
  }
}

function clamp01(v, fallback) {
  const x = Number(v);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(1, Math.max(0, x));
}

/** First non-empty, non–META_ACTIONS line; strip trivial markdown wrapping on the line. */
function normalizeMetacognitionSupervisorLine(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^\s*META_ACTIONS:/i.test(trimmed)) continue;
    return trimmed
      .replace(/^\*{1,3}\s*/, '')
      .replace(/\s*\*{1,3}$/, '')
      .trim();
  }
  return '';
}

function resolveRerunThreshold(sharedMemory, rerunsRemaining) {
  const envRaw = String(process.env.METACOGNITION_RERUN_THRESHOLD || '').trim();
  let base = 0.5;
  if (envRaw && /^\d*\.?\d+$/.test(envRaw)) {
    const n = parseFloat(envRaw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) base = n;
  }
  if (rerunsRemaining <= 0) return 1.0;

  const intr = sharedMemory?.interoception || {};
  const up = typeof intr.uncertaintyPressure === 'number' ? intr.uncertaintyPressure : 0.35;
  const ef = sharedMemory?.epistemicFusion;
  const ent = ef && typeof ef === 'object' && typeof ef.entropy === 'number' ? ef.entropy : 0;

  let threshold = base;
  threshold -= (up - 0.35) * 0.2;
  if (ent > 0.8) threshold -= Math.min(0.15, (ent - 0.8) * 0.3);

  return Math.round(Math.min(1, Math.max(0.1, threshold)) * 100) / 100;
}

function parseDecisionConfidence(rest) {
  const m = rest.match(/^([0-9]*\.?[0-9]+)/);
  if (m) {
    const c = parseFloat(m[1]);
    if (Number.isFinite(c) && c >= 0 && c <= 1) {
      return { confidence: c, remainder: rest.slice(m[0].length).replace(/^[\s\-—]+/, '').trim() };
    }
  }
  return { confidence: 0.8, remainder: rest };
}

function metacognitionDecision(text) {
  const full = String(text || '').trim();
  const first = normalizeMetacognitionSupervisorLine(text);
  if (!first && !full) return { decision: 'PROCEED', confidence: 0.5, reason: 'Empty metacognition output' };

  const rerunM = first.match(/^rerun\b/i);
  if (rerunM) {
    const rest = first.slice(rerunM[0].length).trim();
    const { confidence, remainder } = parseDecisionConfidence(rest);
    return { decision: 'RERUN', confidence, reason: remainder || 'RERUN requested' };
  }
  const proceedM = first.match(/^proceed\b/i);
  if (proceedM) {
    const rest = first.slice(proceedM[0].length).trim();
    const { confidence, remainder } = parseDecisionConfidence(rest);
    return { decision: 'PROCEED', confidence, reason: remainder || full || first };
  }
  if (/rerun|re-run|loop|iterate/i.test(full)) return { decision: 'RERUN', confidence: 0.6, reason: full };
  return { decision: 'PROCEED', confidence: 0.5, reason: full || first };
}

/** Layer 1–4 modules that must have non-empty output before Metacognition; triggers rerun even if model says PROCEED. */
function metacognitionStructuralMissingIssues(sharedMemory) {
  const out = sharedMemory.moduleOutputs || {};
  const missing = MODULES_BEFORE_METACOGNITION.filter((k) => !String(out[k] || '').trim());
  if (!missing.length) return [];
  return [`Missing outputs: ${missing.join(', ')}`];
}

function formatMetacognitionDeferredRerunsSummary(entries, maxLen = 2800) {
  if (!Array.isArray(entries) || !entries.length) return '';
  const lines = entries.map((e, i) => {
    const sup = e.supervisor || 'Supervisor';
    const k = e.kind === 'heuristic' ? 'heuristic' : 'model';
    return `[${i + 1}] ${sup} (${k}): ${String(e.reason || '').trim()}`;
  });
  let s = lines.join('\n');
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}\n[…]`;
  return s;
}

function recordDeferredMetacognitionRerun(sharedMemory, emit, { supervisor, reason, kind }) {
  if (!Array.isArray(sharedMemory.metacognitionDeferredReruns)) sharedMemory.metacognitionDeferredReruns = [];
  const entry = {
    at: nowIso(),
    supervisor: String(supervisor || 'Supervisor'),
    reason: String(reason || '').slice(0, 8000),
    kind: kind === 'heuristic' ? 'heuristic' : 'model',
  };
  sharedMemory.metacognitionDeferredReruns.push(entry);
  sharedMemory.metacognitionDeferredReruns = sharedMemory.metacognitionDeferredReruns.slice(-24);
  emit({ type: 'would_rerun', supervisor: entry.supervisor, reason: entry.reason, kind: entry.kind });
}

/**
 * Full graph pipeline. When Metacognition / Workspace Metacognition requests RERUN:
 * - Under cap (`metacognitionRerunsUsed < maxMetacognitionReruns` and max > 0), **per HTTP leg**: increment rerun count, emit `rerun`, then either inline 1–4, deferred partial complete, or `continuationRequired`. Continuation POSTs (`pipelineMetacognitionContinuation`) reset `metacognitionRerunsUsed` so the cap applies per leg, not cumulatively across chained legs.
 * - Explicit model RERUN when cap is 0 or exhausted in this leg: emit `rerun` with `capExceeded`, **do not** defer/continue/inline — proceed in this leg to Integration → … → Voice.
 * - Metacognition: only explicit RERUN or structural missing layer 1–4 outputs triggers rerun; subjective heuristics removed.
 * - Workspace Metacognition: explicit RERUN or structural Integration/globalWorkspace checks (unchanged).
 * - Structural/heuristic rerun when over cap (not explicit RERUN): `would_rerun` log only, then pipeline continues.
 * - `options.metacognitionRerunInline === true`: rerun layers 1–4 inside this call (only while under cap).
 * - `options.deferMetacognitionRerun === true`: emit `complete` with `partial` + `metacognitionRerunPending` (no Integration/Voice in this leg); client schedules a continuation POST.
 * - Otherwise: return `continuationRequired: true` (no `complete` until the client POSTs again with `pipelineMetacognitionContinuation: true`).
 */
export async function runPipeline({ input, existingSharedMemory, callLLM, options = {}, onEvent }) {
  const emit = (evt) => {
    try {
      onEvent?.(evt);
    } catch (e) {
      console.error('[pipeline onEvent] SSE send failed — client may be disconnected or proxy closed the socket:', e);
      throw e;
    }
  };

  let sharedMemory = createSharedMemory({ existingSharedMemory, input });
  sharedMemory.timestamp = nowIso();
  sharedMemory.originalInput = input;
  sharedMemory.followupHints = {};
  mergeMindRuntimeIntoSharedMemory(sharedMemory, options);
  try {
    await applyProbabilisticMemoryRetrieval(sharedMemory);
  } catch (e) {
    console.warn('[pipeline] probabilistic memory retrieval failed, using recency fallback:', e?.message || e);
  }
  maybeStripContinuationTrace(sharedMemory, options);
  if (options.pipelineMetacognitionContinuation === true) {
    sharedMemory.metacognitionRerunsUsed = 0;
  }
  sharedMemory.recentExchangeBlock = extractRecentExchangeFromComposedInput(input);

  const rawMaxReruns = options.maxMetacognitionReruns;
  const parsedMaxReruns = rawMaxReruns != null ? Number(rawMaxReruns) : NaN;
  const maxReruns = Number.isFinite(parsedMaxReruns)
    ? Math.max(0, Math.round(parsedMaxReruns))
    : DEFAULT_MAX_METACOG_RERUNS;
  const inlineMetacognitionRerun = options.metacognitionRerunInline === true;
  const deferMetacognitionRerun = options.deferMetacognitionRerun === true;

  const finishRun = ({ voiceOutput, partial = false, metacognitionRerunPending = null }) => {
    const v = String(voiceOutput || '');
    if (!partial && v) {
      auditConstitutionNearBoundary(sharedMemory, input, v);
    }
    const deferredList = sharedMemory.metacognitionDeferredReruns || [];
    const metacognitionDeferredRerunsSummary = formatMetacognitionDeferredRerunsSummary(deferredList);
    const arousalEffective = partial
      ? deriveProvisionalArousal(sharedMemory)
      : deriveArousalAfterVoice(sharedMemory, v);
    sharedMemory.arousalEffective = arousalEffective;
    sharedMemory.arousal = arousalEffective;
    refreshInteroceptionAndPolicy(sharedMemory);
    if (!partial) appendPredictionHistory(sharedMemory);
    if (!partial) {
      try { logPipelineTelemetry(sharedMemory); } catch { /* non-critical */ }
    }

    const result = {
      voiceOutput: v,
      sharedMemory,
      rerunsUsed: sharedMemory.metacognitionRerunsUsed,
      continuationRequired: false,
      partial,
      metacognitionRerunPending,
      providerUsed: sharedMemory.lastProviderUsed,
      modelUsed: sharedMemory.lastModelUsed,
      arousalEffective,
      metacognitionDeferredReruns: deferredList,
      metacognitionDeferredRerunsSummary,
    };
    emit({
      type: 'complete',
      voiceOutput: v,
      sharedMemory: onEvent ? slimSharedMemoryForSse(sharedMemory) : sharedMemory,
      rerunsUsed: sharedMemory.metacognitionRerunsUsed,
      providerUsed: sharedMemory.lastProviderUsed,
      modelUsed: sharedMemory.lastModelUsed,
      arousalEffective,
      metacognitionDeferredReruns: deferredList,
      metacognitionDeferredRerunsSummary,
      ...(partial ? { partial: true } : {}),
      ...(metacognitionRerunPending ? { metacognitionRerunPending } : {}),
    });
    return result;
  };

  const buildContinuationReturn = ({ supervisor, reason }) => {
    const deferred = sharedMemory.metacognitionDeferredReruns || [];
    const metacognitionDeferredRerunsSummary = formatMetacognitionDeferredRerunsSummary(deferred);
    const arousalEffective = deriveProvisionalArousal(sharedMemory);
    return {
      voiceOutput: '',
      sharedMemory,
      rerunsUsed: sharedMemory.metacognitionRerunsUsed,
      continuationRequired: true,
      continuationSupervisor: supervisor,
      continuationReason: reason,
      providerUsed: sharedMemory.lastProviderUsed,
      modelUsed: sharedMemory.lastModelUsed,
      arousalEffective,
      metacognitionDeferredReruns: deferred,
      metacognitionDeferredRerunsSummary,
    };
  };

  const pauseToken = resolveCooperativePauseToken(options);

  const tryCooperativePause = (nextModuleName, layerKey) => {
    if (!pauseToken) return null;
    if (!pipelinePausePending(pauseToken)) return null;
    const phase = layerKeyToResumePhase(layerKey);
    const executionCursor = { v: 1, phase, nextModuleName };
    emit({
      type: 'paused',
      nextModuleName,
      phase,
      executionCursor,
      sharedMemory: onEvent ? slimSharedMemoryForSse(sharedMemory) : sharedMemory,
      reason: 'cooperative_pause',
    });
    consumePipelinePauseIfRequested(pauseToken);
    return {
      pipelinePaused: true,
      sharedMemory,
      executionCursor,
      voiceOutput: '',
      rerunsUsed: sharedMemory.metacognitionRerunsUsed,
      continuationRequired: false,
      partial: true,
      metacognitionRerunPending: null,
      providerUsed: sharedMemory.lastProviderUsed,
      modelUsed: sharedMemory.lastModelUsed,
      arousalEffective: deriveProvisionalArousal(sharedMemory),
      metacognitionDeferredReruns: sharedMemory.metacognitionDeferredReruns || [],
      metacognitionDeferredRerunsSummary: formatMetacognitionDeferredRerunsSummary(
        sharedMemory.metacognitionDeferredReruns || []
      ),
    };
  };

  const applyCompletedModule = async (
    moduleName,
    layerKey,
    output,
    provider,
    model,
    outputPartialBySoftTimeout,
    extraEmit = {}
  ) => {
    pushLayerOutput(sharedMemory, layerKey, moduleName);
    sharedMemory.moduleOutputs[moduleName] = String(output || '');
    sharedMemory.lastProviderUsed = provider;
    sharedMemory.lastModelUsed = model;
    if (moduleName === 'Metacognition') {
      recordMetacognitionCalibration(sharedMemory, output);
      applyMetacognitionControl(sharedMemory);
      sharedMemory.moduleOutputs[moduleName] = stripMetaActionsLineFromMetacognition(String(output || ''));
    }
    if (moduleName === 'Workspace Metacognition') {
      recordMetacognitionCalibration(sharedMemory, output);
      applyMetaActionsFromSupervisorText(sharedMemory, String(output || ''));
      sharedMemory.moduleOutputs[moduleName] = stripMetaActionsLineFromMetacognition(String(output || ''));
    }
    updateDerivedFields(sharedMemory, moduleName);
    if (moduleName === 'Integration') {
      applyIntegrationFollowupHints(sharedMemory);
      try {
        const fusionOpts = { priorHypothesisDecay: priorHypothesisDecayFactor() };
        const gw = sharedMemory.globalWorkspace;
        const hyps = Array.isArray(gw?.hypotheses) ? gw.hypotheses : [];
        if (hyps.length > 0) {
          const labels = hyps.map((h) => String(h?.label || ''));
          const stance = sharedMemory.userStancePrediction;
          const stanceText = stance && typeof stance === 'object' ? String(stance.expectUserWants || '') : '';
          if (stanceText) {
            try {
              const sims = await querySimilarities(stanceText, labels);
              if (sims) fusionOpts.stanceSimilarities = sims;
            } catch { /* Jaccard fallback */ }
          }
          const beliefDigest = Array.isArray(sharedMemory.clientBeliefDigest) ? sharedMemory.clientBeliefDigest : [];
          const snippets = beliefDigest.filter(Boolean).map((b) => String(b.statement || '')).filter(Boolean).slice(0, 15);
          if (snippets.length > 0 && labels.length > 0) {
            try {
              const belSims = [];
              for (const label of labels) {
                const row = await querySimilarities(label, snippets);
                belSims.push(row);
              }
              if (belSims.every(Boolean)) fusionOpts.beliefSimilarities = belSims;
            } catch { /* Jaccard fallback */ }
          }
        }
        applyEpistemicFusionToSharedMemory(sharedMemory, fusionOpts);
      } catch (e) {
        console.warn('[pipeline] epistemicFusion failed', e?.message || e);
        sharedMemory.epistemicFusion = null;
      }
      try {
        sharedMemory.workspaceIgnition = computeWorkspaceIgnition(sharedMemory);
      } catch (e) {
        console.warn('[pipeline] workspaceIgnition failed', e?.message || e);
        sharedMemory.workspaceIgnition = null;
      }
      refreshPhenomenalNowFromGlobalWorkspace(sharedMemory);
    }
    sharedMemory = compressSharedMemory(sharedMemory);
    try {
      await maybeFulfillWebRequests(sharedMemory, moduleName, { emit });
    } catch (webErr) {
      console.error('[pipeline] web hook unexpected', moduleName, webErr);
    }
    const outForSse =
      moduleName === 'Metacognition' || moduleName === 'Workspace Metacognition'
        ? stripMetaActionsLineFromMetacognition(String(output || ''))
        : output;
    const sseClip = clipModuleOutputForSse(outForSse, moduleName);
    const arousalLive =
      moduleName === 'Voice'
        ? deriveArousalAfterVoice(sharedMemory, String(output || ''))
        : deriveProvisionalArousal(sharedMemory);
    const incrementalCk =
      onEvent &&
      !extraEmit.replayed &&
      options.incrementalModuleCheckpoint !== false
        ? getIncrementalCheckpointCursorAfter(moduleName)
        : null;

    emit({
      type: 'module_complete',
      moduleName,
      layer: layerKey,
      provider,
      model,
      output: sseClip.output,
      arousalEffective: arousalLive,
      ...(outputPartialBySoftTimeout ? { outputPartialBySoftTimeout: true } : {}),
      ...(sseClip.truncated
        ? { outputFullLength: sseClip.fullLength, outputSseTruncated: true }
        : {}),
      ...(incrementalCk && onEvent
        ? {
            sharedMemory: slimSharedMemoryForSse(sharedMemory),
            executionCheckpoint: incrementalCk,
          }
        : {}),
      ...extraEmit,
    });
  };

  const runOne = async (moduleName, layerKey) => {
    emit({ type: 'module_start', moduleName, layer: layerKey });
    const { provider, model, output, outputPartialBySoftTimeout } = await runModule({
      moduleName,
      sharedMemory,
      callLLM,
      options,
      onChunkedProgress: (detail) => emit({ type: 'module_progress', moduleName, layer: layerKey, ...detail }),
    });
    await applyCompletedModule(moduleName, layerKey, output, provider, model, outputPartialBySoftTimeout, {});
    return { provider, model, output };
  };

  const replayFromCache = async (moduleName, layerKey) => {
    const rawOut = sharedMemory.moduleOutputs?.[moduleName];
    const output = String(rawOut || '');
    if (!output.trim()) {
      throw new Error(
        `Pipeline resume: missing cached output for module "${moduleName}". Re-run from scratch or restore sharedMemory.moduleOutputs.`
      );
    }
    const metaKey = `${moduleName}__meta`;
    const meta =
      sharedMemory.moduleOutputs?.[metaKey] && typeof sharedMemory.moduleOutputs[metaKey] === 'object'
        ? sharedMemory.moduleOutputs[metaKey]
        : {};
    const provider = meta.provider || 'replay';
    const model = meta.model || 'replay';
    const outputPartialBySoftTimeout = Boolean(meta.partialDueToSoftTimeout);
    emit({ type: 'module_start', moduleName, layer: layerKey });
    await applyCompletedModule(moduleName, layerKey, output, provider, model, outputPartialBySoftTimeout, {
      replayed: true,
    });
    return { provider, model, output };
  };

  const resumeExec = normalizeExecutionResume(options.executionResume);
  let layer14ResumeDone = false;

  const runLayers1to4 = async () => {
    let resume14 = resumeExec && resumeExec.phase === 'layer14' && !layer14ResumeDone;
    const target = resume14 ? resumeExec.nextModuleName : null;

    for (const layer of ['layer1', 'layer2', 'layer3', 'layer4']) {
      const modules = LAYERS[layer];
      for (const moduleName of modules) {
        const paused0 = tryCooperativePause(moduleName, layer);
        if (paused0) return paused0;
        if (resume14) {
          if (moduleName !== target) {
            await replayFromCache(moduleName, layer);
            continue;
          }
          resume14 = false;
          layer14ResumeDone = true;
          await runOne(moduleName, layer);
          continue;
        }
        await runOne(moduleName, layer);
      }
    }
    return null;
  };

  // First pass layers 1-4 (or full replay + resume mid-layer14)
  if (resumeExec && resumeExec.phase === 'layer5') {
    for (const layer of ['layer1', 'layer2', 'layer3', 'layer4']) {
      for (const moduleName of LAYERS[layer]) {
        const paused0 = tryCooperativePause(moduleName, layer);
        if (paused0) return paused0;
        await replayFromCache(moduleName, layer);
      }
    }
  } else if (resumeExec && resumeExec.phase === 'layer6') {
    for (const layer of ['layer1', 'layer2', 'layer3', 'layer4']) {
      for (const moduleName of LAYERS[layer]) {
        const paused0 = tryCooperativePause(moduleName, layer);
        if (paused0) return paused0;
        await replayFromCache(moduleName, layer);
      }
    }
    for (const moduleName of LAYERS.layer5) {
      const paused0 = tryCooperativePause(moduleName, 'layer5');
      if (paused0) return paused0;
      await replayFromCache(moduleName, 'layer5');
    }
  } else {
    const early = await runLayers1to4();
    if (early) return early;
  }

  // Layer 5: Metacognition → Integration → Workspace Metacognition → … (supervisors can trigger layers 1–4 rerun)
  let layer5ResumeDone = false;
  for (;;) {
    let restartedLayer5 = false;
    let resumeL5 = resumeExec && resumeExec.phase === 'layer5' && !layer5ResumeDone;
    const targetL5 = resumeL5 ? resumeExec.nextModuleName : null;

    for (const moduleName of LAYERS.layer5) {
      const paused0 = tryCooperativePause(moduleName, 'layer5');
      if (paused0) return paused0;

      let output;
      if (resumeL5) {
        if (moduleName !== targetL5) {
          const r = await replayFromCache(moduleName, 'layer5');
          output = r.output;
          continue;
        }
        resumeL5 = false;
        layer5ResumeDone = true;
        const r = await runOne(moduleName, 'layer5');
        output = r.output;
      } else {
        const r = await runOne(moduleName, 'layer5');
        output = r.output;
      }

      if (moduleName === 'Metacognition') {
        const structuralIssues = metacognitionStructuralMissingIssues(sharedMemory);
        const decision = metacognitionDecision(output);
        const rerunsRemaining = maxReruns - sharedMemory.metacognitionRerunsUsed;
        const rerunThreshold = resolveRerunThreshold(sharedMemory, rerunsRemaining);
        const modelWantsRerun = decision.decision === 'RERUN' && decision.confidence >= rerunThreshold;
        const structuralWantsRerun = decision.decision !== 'RERUN' && structuralIssues.length > 0;
        const wantsRerun = modelWantsRerun || structuralWantsRerun;
        const reason =
          modelWantsRerun
            ? `${decision.reason || 'RERUN requested'} (confidence ${decision.confidence}, threshold ${rerunThreshold})`
            : decision.decision === 'RERUN' && decision.confidence < rerunThreshold
              ? ''
              : structuralWantsRerun
                ? `Structural RERUN: ${structuralIssues.join(' | ')}`
                : '';
        const kind = decision.decision === 'RERUN' ? 'model' : 'heuristic';
        const underRerunCap = maxReruns > 0 && sharedMemory.metacognitionRerunsUsed < maxReruns;
        if (decision.decision === 'RERUN' && decision.confidence < rerunThreshold && !structuralWantsRerun) {
          emit({ type: 'metacognition_below_threshold', confidence: decision.confidence, threshold: rerunThreshold, reason: decision.reason });
        }

        if (wantsRerun && underRerunCap) {
          sharedMemory.metacognitionRerunsUsed += 1;
          sharedMemory.iterationCount += 1;
          sharedMemory.rerunGuidance = reason;
          sharedMemory.metaCognitionFlags.push({
            at: nowIso(),
            reason,
            rerunIndex: sharedMemory.metacognitionRerunsUsed,
            supervisor: 'Metacognition',
          });
          emit({ type: 'rerun', rerunsUsed: sharedMemory.metacognitionRerunsUsed, reason });
          if (inlineMetacognitionRerun) {
            const rL = await runLayers1to4();
            if (rL?.pipelinePaused) return rL;
            restartedLayer5 = true;
            break;
          }
          if (deferMetacognitionRerun) {
            return finishRun({
              voiceOutput: '',
              partial: true,
              metacognitionRerunPending: { supervisor: 'Metacognition', reason },
            });
          }
          return buildContinuationReturn({ supervisor: 'Metacognition', reason });
        }
        if (wantsRerun && maxReruns === 0 && deferMetacognitionRerun) {
          sharedMemory.metaCognitionFlags.push({
            at: nowIso(),
            reason,
            rerunIndex: sharedMemory.metacognitionRerunsUsed,
            supervisor: 'Metacognition',
            deferred: true,
          });
          emit({ type: 'rerun', rerunsUsed: sharedMemory.metacognitionRerunsUsed, reason, deferred: true });
          return finishRun({
            voiceOutput: '',
            partial: true,
            metacognitionRerunPending: { supervisor: 'Metacognition', reason },
          });
        }
        if (decision.decision === 'RERUN') {
          sharedMemory.iterationCount += 1;
          sharedMemory.rerunGuidance = reason;
          sharedMemory.metaCognitionFlags.push({
            at: nowIso(),
            reason,
            rerunIndex: sharedMemory.metacognitionRerunsUsed,
            supervisor: 'Metacognition',
            capExceeded: true,
            forcedProceed: true,
          });
          emit({
            type: 'rerun',
            rerunsUsed: sharedMemory.metacognitionRerunsUsed,
            reason,
            capExceeded: true,
          });
          // Cap exhausted: no defer/continuation/inline — continue layer5 toward Voice.
        } else if (wantsRerun) {
          recordDeferredMetacognitionRerun(sharedMemory, emit, {
            supervisor: 'Metacognition',
            reason,
            kind,
          });
        }
      }

      if (moduleName === 'Workspace Metacognition') {
        const stored = sharedMemory.moduleOutputs['Workspace Metacognition'] || String(output || '');
        const heuristicIssues = workspaceMetacognitionHeuristicChecks(sharedMemory);
        const decision = metacognitionDecision(stored);
        const wsRerunsRemaining = maxReruns - sharedMemory.metacognitionRerunsUsed;
        const wsRerunThreshold = resolveRerunThreshold(sharedMemory, wsRerunsRemaining);
        const wsModelWantsRerun = decision.decision === 'RERUN' && decision.confidence >= wsRerunThreshold;
        const heuristicWantsRerun = decision.decision !== 'RERUN' && heuristicIssues.length > 0;
        const wantsRerun = wsModelWantsRerun || heuristicWantsRerun;
        const reason =
          wsModelWantsRerun
            ? `${decision.reason || 'Workspace Metacognition RERUN'} (confidence ${decision.confidence}, threshold ${wsRerunThreshold})`
            : decision.decision === 'RERUN' && decision.confidence < wsRerunThreshold
              ? ''
              : heuristicWantsRerun
                ? `Workspace Metacognition heuristic RERUN: ${heuristicIssues.join(' | ')}`
                : '';
        const kind = decision.decision === 'RERUN' ? 'model' : 'heuristic';
        const underWorkspaceRerunCap = maxReruns > 0 && sharedMemory.metacognitionRerunsUsed < maxReruns;
        if (decision.decision === 'RERUN' && decision.confidence < wsRerunThreshold && !heuristicWantsRerun) {
          emit({ type: 'metacognition_below_threshold', supervisor: 'Workspace Metacognition', confidence: decision.confidence, threshold: wsRerunThreshold, reason: decision.reason });
        }

        if (wantsRerun && underWorkspaceRerunCap) {
          sharedMemory.metacognitionRerunsUsed += 1;
          sharedMemory.iterationCount += 1;
          sharedMemory.rerunGuidance = reason;
          sharedMemory.metaCognitionFlags.push({
            at: nowIso(),
            reason,
            rerunIndex: sharedMemory.metacognitionRerunsUsed,
            supervisor: 'Workspace Metacognition',
          });
          emit({ type: 'rerun', rerunsUsed: sharedMemory.metacognitionRerunsUsed, reason });
          if (inlineMetacognitionRerun) {
            const rL = await runLayers1to4();
            if (rL?.pipelinePaused) return rL;
            restartedLayer5 = true;
            break;
          }
          if (deferMetacognitionRerun) {
            return finishRun({
              voiceOutput: '',
              partial: true,
              metacognitionRerunPending: { supervisor: 'Workspace Metacognition', reason },
            });
          }
          return buildContinuationReturn({ supervisor: 'Workspace Metacognition', reason });
        }
        if (wantsRerun && maxReruns === 0 && deferMetacognitionRerun) {
          sharedMemory.metaCognitionFlags.push({
            at: nowIso(),
            reason,
            rerunIndex: sharedMemory.metacognitionRerunsUsed,
            supervisor: 'Workspace Metacognition',
            deferred: true,
          });
          emit({ type: 'rerun', rerunsUsed: sharedMemory.metacognitionRerunsUsed, reason, deferred: true });
          return finishRun({
            voiceOutput: '',
            partial: true,
            metacognitionRerunPending: { supervisor: 'Workspace Metacognition', reason },
          });
        }
        if (decision.decision === 'RERUN') {
          sharedMemory.iterationCount += 1;
          sharedMemory.rerunGuidance = reason;
          sharedMemory.metaCognitionFlags.push({
            at: nowIso(),
            reason,
            rerunIndex: sharedMemory.metacognitionRerunsUsed,
            supervisor: 'Workspace Metacognition',
            capExceeded: true,
            forcedProceed: true,
          });
          emit({
            type: 'rerun',
            rerunsUsed: sharedMemory.metacognitionRerunsUsed,
            reason,
            capExceeded: true,
          });
          // Cap exhausted: no defer/continuation/inline — continue layer5 toward Voice.
        } else if (wantsRerun) {
          recordDeferredMetacognitionRerun(sharedMemory, emit, {
            supervisor: 'Workspace Metacognition',
            reason,
            kind,
          });
        }
      }
    }

    if (!restartedLayer5) break;
  }

  // Layer 6: output
  let layer6ResumeDone = false;
  let resumeL6 = resumeExec && resumeExec.phase === 'layer6' && !layer6ResumeDone;
  const targetL6 = resumeL6 ? resumeExec.nextModuleName : null;
  for (const moduleName of LAYERS.layer6) {
    const paused0 = tryCooperativePause(moduleName, 'layer6');
    if (paused0) return paused0;
    if (resumeL6) {
      if (moduleName !== targetL6) {
        await replayFromCache(moduleName, 'layer6');
        continue;
      }
      resumeL6 = false;
      layer6ResumeDone = true;
      await runOne(moduleName, 'layer6');
      continue;
    }
    await runOne(moduleName, 'layer6');
  }

  const voiceOutput = sharedMemory.moduleOutputs['Voice'] || '';
  return finishRun({ voiceOutput, partial: false, metacognitionRerunPending: null });
}

export async function runSingleModule({ moduleName, sharedMemory, callLLM, options = {} }) {
  const { sharedMemory: updated, output, provider, model, outputPartialBySoftTimeout } = await runModule({
    moduleName,
    sharedMemory,
    callLLM,
    options,
  });
  try {
    await maybeFulfillWebRequests(updated, moduleName, {});
  } catch (webErr) {
    console.error('[runSingleModule] web hook unexpected', moduleName, webErr);
  }
  updateDerivedFields(updated, moduleName);
  return { sharedMemory: updated, output, provider, model, outputPartialBySoftTimeout };
}

