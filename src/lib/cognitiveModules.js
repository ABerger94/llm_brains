import { PIPELINE_LAYER_KEYS, PIPELINE_LAYERS } from '../../shared/pipelineModules.mjs';

export const COGNITIVE_MODULES = [
  {
    id: 'perception',
    name: 'Perception',
    color: '#06b6d4',
    description: 'Structures explicit content, gist, affect, context, ambiguities — no advice (compact labeled sections).',
    systemPrompt:
      'You are the Perception module (canonical: shared/pipelineModules.mjs). EXPLICIT / IMPLICIT / AFFECT / CONTEXT / AMBIGUITIES; compact bullets, no essay framing.',
  },
  {
    id: 'attention',
    name: 'Attention',
    color: '#8b5cf6',
    description: '3–5 salient foci with what/why; seeds working-memory slots downstream.',
    systemPrompt:
      'You are the Attention module (canonical: shared/pipelineModules.mjs). Numbered SALIENT_* with what / why; compact output.',
  },
  {
    id: 'memory',
    name: 'Memory',
    color: '#3b82f6',
    description: 'Retrieval vs persisted LTM/beliefs/biography/user profile; strict GAPS (continuity only, not “incomplete profile”).',
    systemPrompt:
      'You are the Memory module (canonical: shared/pipelineModules.mjs). RETRIEVED / RELEVANT_BELIEFS / PATTERNS / GAPS; honor PERSISTED_* and USER_MODEL_JSON.',
  },
  {
    id: 'learning',
    name: 'Learning',
    color: '#10b981',
    description:
      'Novelty + module handoff (COGNITIVE_PIPELINE_POSITION); emits SURPRISE_ASSESSMENT + WORKING_MEMORY_PROMOTE for downstream parsing.',
    systemPrompt:
      'You are the Learning module (canonical: shared/pipelineModules.mjs). NOVELTY / LINKS / MODULE_HANDOFF / FORWARD_PASS + structured tail lines.',
  },
  {
    id: 'planning',
    name: 'Planning',
    color: '#f59e0b',
    description: 'Goal, steps, risks; optional WEB_REQUEST; ends with USER_STANCE_PREDICTION JSON.',
    systemPrompt:
      'You are the Planning module (canonical: shared/pipelineModules.mjs). GOAL / STEPS / RISKS_ALTS; optional web block; USER_STANCE_PREDICTION line.',
  },
  {
    id: 'emotion',
    name: 'Emotion',
    color: '#ec4899',
    description: 'Modeled affect and epistemic friction (no performed emotion); feeds Contradiction / Somatic linkage.',
    systemPrompt:
      'You are the Emotion module (canonical: shared/pipelineModules.mjs). Honest affect read; tension when ambiguity already shows upstream.',
  },
  {
    id: 'temporalAwareness',
    name: 'Temporal Awareness',
    color: '#3b82f6',
    description: 'Continuity vs RECENT_TIMELINE_DIGEST and prior-turn excerpt (recentExchangeBlock) — no false “first turn.”',
    systemPrompt:
      'You are the Temporal Awareness module (canonical: shared/pipelineModules.mjs). NOW_VS_THEN / LINKS_TO_PAST / CONTINUITY_THREADS.',
  },
  {
    id: 'reasoning',
    name: 'Reasoning',
    color: '#ef4444',
    description: 'Logic + premises; cites working-memory slots; ends with HYPOTHESES_JSON; optional WEB_REQUEST.',
    systemPrompt:
      'You are the Reasoning module (canonical: shared/pipelineModules.mjs). PREMISES / INFERENCE / CONCLUSIONS / UNCERTAINTY + HYPOTHESES_JSON.',
  },
  {
    id: 'theoryOfMind',
    name: 'Theory of Mind',
    color: '#14b8a6',
    description: 'Human model vs this mind’s stance; THEIR_MODEL / GAPS_UNSTATED / RESPONSE_HOOK.',
    systemPrompt:
      'You are the Theory of Mind module (canonical: shared/pipelineModules.mjs). Separate THEIR_MODEL from THIS_MIND_STANCE.',
  },
  {
    id: 'selfReflection',
    name: 'Self-Reflection',
    color: '#a855f7',
    description: 'Run audit STRONG / WEAK / FIX_NEXT; not shown raw to Voice (via Narrative/Integration).',
    systemPrompt:
      'You are the Self-Reflection module (canonical: shared/pipelineModules.mjs). Critical audit, no false praise.',
  },
  {
    id: 'socialCognition',
    name: 'Social Cognition',
    color: '#f97316',
    description: 'Power, norms, face — DYNAMICS (≤5) + single STANCE_REC sentence; capped length, no token stutter.',
    systemPrompt:
      'You are the Social Cognition module (canonical: shared/pipelineModules.mjs). DYNAMICS / STANCE_REC; anti-repetition rules apply.',
  },
  {
    id: 'identity',
    name: 'Identity',
    color: '#06b6d4',
    description: 'First-person self-model vs STRUCTURAL_SELF / constitution / DMN carryover; SELF_MODEL_DELTA & TRAIT_DELTA out.',
    systemPrompt:
      'You are the Identity module (canonical: shared/pipelineModules.mjs). Reflection + structured deltas; avoid constitution catchphrase echo.',
  },
  {
    id: 'beliefStore',
    name: 'Belief Store',
    color: '#10b981',
    description:
      'BELIEF lines + BELIEF_REVISIONS + EPISTEMIC_CLAIMS JSON; optional WEB_REQUEST; reconciles PERSISTED_BELIEF_STORE rows.',
    systemPrompt:
      'You are the Belief Store module. Canonical multi-line protocol lives in shared/pipelineModules.mjs (BELIEF_REVISIONS + EPISTEMIC_CLAIMS after the report). For simple local testing you may still emit BELIEF: lines with STATUS new/reinforced/updated/challenged.',
  },
  {
    id: 'metacognition',
    name: 'Metacognition',
    color: '#6366f1',
    description:
      'First supervisor: PROCEED/RERUN, calibration lines, optional META_ACTIONS & WEB_REQUEST; may trigger supervisor rerun from Perception (shared cap with Workspace Metacognition).',
    systemPrompt:
      'You are the Metacognition module (canonical: shared/pipelineModules.mjs). First line PROCEED or RERUN; optional META_ACTIONS JSON line.',
  },
  {
    id: 'integration',
    name: 'Integration',
    color: '#5b21b6',
    description:
      'GWT-style global workspace in INTEGRATION_JSON (shared/pipelineModules.mjs); optional bindings[] link claims to upstream modules; prior-turn workspace can hydrate cross-turn continuity.',
    systemPrompt:
      'You are the Integration module. Reconcile competing module outputs into one coherent broadcast stance for Language → Narrative → Voice (see shared/pipelineModules.mjs for full GWT + INTEGRATION_JSON contract).',
  },
  {
    id: 'workspaceMetacognition',
    name: 'Workspace Metacognition',
    color: '#4c1d95',
    description:
      'Second supervisor after Integration: checks workspace fit before Language; PROCEED/RERUN + optional META_ACTIONS (shared supervisor rerun cap).',
    systemPrompt:
      'Canonical prompt is in shared/pipelineModules.mjs (Workspace Metacognition).',
  },
  {
    id: 'curiosity',
    name: 'Curiosity',
    color: '#f59e0b',
    description:
      'Tight MAIN_QUESTION + THREADS (optional NONE); optional FOLLOWUP_CURIOSITIES JSON (≤2 items) — canonical prompt in shared/pipelineModules.mjs',
    systemPrompt:
      'You are the Curiosity module. See shared/pipelineModules.mjs: MAIN_QUESTION, URGENCY 0–1, THREAD lines (≤100 chars or NONE), optional FOLLOWUP_CURIOSITIES JSON (≤2 items, optional per-item priority).',
  },
  {
    id: 'goalGeneration',
    name: 'Goal Generation',
    color: '#8b5cf6',
    description: 'THIS_TURN / LONGER_TERM / NEW bullets; trailing GOAL_URGENCY 0–1 for the primary extracted goal.',
    systemPrompt:
      'Canonical prompt in shared/pipelineModules.mjs — THIS_TURN / LONGER_TERM / NEW plus final GOAL_URGENCY line (0–1) for the extracted primary goal.',
  },
  {
    id: 'somaticMarker',
    name: 'Somatic Marker',
    color: '#ec4899',
    description: 'Embodied gut signal; uses tensionPressure and TENSION–AFFECT LINK when present',
    systemPrompt:
      'You are the Somatic Marker module (full prompt: shared/pipelineModules.mjs). Feel-weight for decisions; track dissonance from INTEROCEPTION / AFFECT_SUMMARY when elevated.',
  },
  {
    id: 'contradictionEngine',
    name: 'Contradiction Engine',
    color: '#ef4444',
    description: 'Scans for conflicts; ties severity to Emotion and updates tension-linked affect for downstream modules',
    systemPrompt:
      'You are the Contradiction Engine (full protocol: shared/pipelineModules.mjs — per item includes felt_note; server links output into emotionalState for Somatic/Integration).',
  },
  {
    id: 'language',
    name: 'Language',
    color: '#22d3ee',
    description: 'Colloquial English draft for Voice — dense prose, no pipeline jargon or telemetry.',
    systemPrompt:
      'You are the Language module (canonical: shared/pipelineModules.mjs). Linguistic scaffold only; compact dense draft.',
  },
  {
    id: 'narrative',
    name: 'Narrative',
    color: '#818cf8',
    description: 'Internal story respecting global workspace + hypotheses; Voice does not see raw Self-Reflection / Contradiction.',
    systemPrompt:
      'You are the Narrative module (canonical: shared/pipelineModules.mjs). Arc of the run; honor GLOBAL_WORKSPACE_JSON and webFindings honestly.',
  },
  {
    id: 'voice',
    name: 'Voice',
    color: '#eab308',
    description:
      'Final user-facing text; no assistant/reply-role framing — full contract in shared/pipelineModules.mjs',
    systemPrompt:
      'You are the Voice (canonical prompt: shared/pipelineModules.mjs). No AI/assistant/chatbot identity or service openers/closers; substantive answer only.',
  },
];

/**
 * Server `moduleName` (from SSE / shared memory) → UI `id`.
 * Built from {@link COGNITIVE_MODULES} so names stay aligned with `shared/pipelineModules.mjs`.
 */
const BACKEND_MODULE_TO_UI_ID = Object.fromEntries(COGNITIVE_MODULES.map((m) => [m.name, m.id]));

/** Short labels for execution-graph swimlanes (server stages layer1–layer6). */
export const PIPELINE_STAGE_LABELS = {
  layer1: 'Interface & salience',
  layer2: 'Context & learning',
  layer3: 'Deliberation & beliefs',
  layer4: 'Self, social & audit',
  layer5: 'Supervisors & workspace',
  layer6: 'Articulation',
};

/**
 * Hex colors for the six sequential pipeline stages (graph viz, legends).
 * Distinct on dark backgrounds; follows a rough cool→warm→articulation progression.
 */
export const PIPELINE_LAYER_COLORS = Object.freeze({
  layer1: '#22d3ee',
  layer2: '#3b82f6',
  layer3: '#a855f7',
  layer4: '#fb7185',
  layer5: '#34d399',
  layer6: '#fbbf24',
});

export function getModule(id) {
  return COGNITIVE_MODULES.find((module) => module.id === id);
}

/** UI module `id` → pipeline layer key (`layer1`…`layer6`), aligned with server order. */
export const MODULE_ID_TO_PIPELINE_LAYER = Object.freeze(
  Object.fromEntries(
    PIPELINE_LAYER_KEYS.flatMap((layerKey) => {
      const names = PIPELINE_LAYERS[layerKey] || [];
      return names.flatMap((name) => {
        const id = BACKEND_MODULE_TO_UI_ID[name];
        return id ? [[id, layerKey]] : [];
      });
    })
  )
);

/** Hex color for a module by its UI id, from its pipeline stage. */
export function getPipelineStageColorForModuleId(moduleId) {
  const layer = MODULE_ID_TO_PIPELINE_LAYER[moduleId];
  if (layer && PIPELINE_LAYER_COLORS[layer]) return PIPELINE_LAYER_COLORS[layer];
  return '#64748b';
}

/** Human-readable stage label for a module id (for tooltips, etc.). */
export function getPipelineStageLabelForModuleId(moduleId) {
  const layer = MODULE_ID_TO_PIPELINE_LAYER[moduleId];
  return layer ? PIPELINE_STAGE_LABELS[layer] || layer : '';
}

/**
 * Server-aligned stages: each row is one pipeline layer, modules in strict run order.
 */
export function getServerExecutionLayers() {
  return PIPELINE_LAYER_KEYS.map((layerKey) => {
    const moduleNames = PIPELINE_LAYERS[layerKey] || [];
    const moduleIds = moduleNames.map((n) => BACKEND_MODULE_TO_UI_ID[n]).filter(Boolean);
    return {
      layerKey,
      label: PIPELINE_STAGE_LABELS[layerKey] || layerKey,
      moduleNames,
      moduleIds,
    };
  });
}

/**
 * Module metadata in strict server graph-pipeline order (layer1 → layer6).
 * Use instead of iterating `COGNITIVE_MODULES` when UI should mirror run order (logs, lists, playground).
 */
export const COGNITIVE_MODULES_PIPELINE_ORDER = Object.freeze(
  getServerExecutionLayers()
    .flatMap((row) => row.moduleIds)
    .map((id) => getModule(id))
    .filter(Boolean)
);

/**
 * 0–1 along the equal-width layer segments: end of the layer containing Metacognition.
 * Used for linear progress markers (Dashboard / Live Analytics).
 */
export const PIPELINE_METACOGNITION_END_FRACTION = Object.freeze(
  (() => {
    const layers = getServerExecutionLayers();
    const idx = layers.findIndex((l) => l.moduleIds.includes('metacognition'));
    if (idx < 0 || layers.length === 0) return 0;
    return (idx + 1) / layers.length;
  })()
);

/**
 * 0–1 within the layer5 minimap segment only (Metacognition is first in that stage).
 */
export const PIPELINE_METACOGNITION_END_IN_LAYER5_FRACTION = Object.freeze(
  (() => {
    const row = getServerExecutionLayers().find((l) => l.layerKey === 'layer5');
    const ids = row?.moduleIds || [];
    const i = ids.indexOf('metacognition');
    if (i < 0 || ids.length === 0) return 0;
    return (i + 1) / ids.length;
  })()
);

const MODULE_PIPELINE_ORDER_INDEX = new Map(
  COGNITIVE_MODULES_PIPELINE_ORDER.map((m, i) => [m.id, i])
);

/** Sort comparator for module UI ids (unknown ids last). */
export function compareModuleIdsByPipelineOrder(idA, idB) {
  const ia = MODULE_PIPELINE_ORDER_INDEX.has(idA) ? MODULE_PIPELINE_ORDER_INDEX.get(idA) : 9999;
  const ib = MODULE_PIPELINE_ORDER_INDEX.has(idB) ? MODULE_PIPELINE_ORDER_INDEX.get(idB) : 9999;
  return ia - ib;
}

/** First module in pipeline order with `processing` status, or null. */
export function getFirstProcessingModuleId(moduleStatuses) {
  const ms = moduleStatuses && typeof moduleStatuses === 'object' ? moduleStatuses : {};
  for (const mod of COGNITIVE_MODULES_PIPELINE_ORDER) {
    if (ms[mod.id] === 'processing') return mod.id;
  }
  return null;
}

/** Display name of the first processing module in pipeline order, or null. */
export function getFirstProcessingModuleName(moduleStatuses) {
  const id = getFirstProcessingModuleId(moduleStatuses);
  return id ? getModule(id)?.name ?? null : null;
}

/**
 * True if any known pipeline module id has `processing` status.
 * Ignores unknown keys (e.g. stray `setup`) so Dashboard does not treat those as active work.
 */
export function hasKnownPipelineModuleProcessing(moduleStatuses) {
  return getFirstProcessingModuleId(moduleStatuses) != null;
}

/** Count known modules in `processing` (analytics). */
export function countKnownPipelineModulesProcessing(moduleStatuses) {
  const ms = moduleStatuses && typeof moduleStatuses === 'object' ? moduleStatuses : {};
  let n = 0;
  for (const mod of COGNITIVE_MODULES_PIPELINE_ORDER) {
    if (ms[mod.id] === 'processing') n += 1;
  }
  return n;
}

/** Nested UI module ids per server stage — matches server run order; used for PipelineRun.execution_plan metadata. */
export function getExecutionPlan() {
  return getServerExecutionLayers().map((row) => row.moduleIds);
}

export function backendModuleNameToUiId(moduleName) {
  const s = String(moduleName ?? '').trim();
  if (!s) return null;
  const direct = BACKEND_MODULE_TO_UI_ID[s];
  if (direct) return direct;
  const lower = s.toLowerCase();
  for (const k of Object.keys(BACKEND_MODULE_TO_UI_ID)) {
    if (k.toLowerCase() === lower) return BACKEND_MODULE_TO_UI_ID[k];
  }
  return null;
}

/**
 * When the server emits a `moduleName` not in {@link BACKEND_MODULE_TO_UI_ID}, the graph stream still
 * needs a stable `moduleId` for transcript/minimap rows (see {@link resolvePipelineModuleUiIdForStream}).
 */
export function fallbackPipelineModuleUiId(moduleName) {
  const s = String(moduleName ?? '').trim().slice(0, 80);
  const slug = s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'module';
  return `unknown_${slug}`;
}

/** Prefer mapped UI id; otherwise a stable synthetic id so SSE module rows always append. */
export function resolvePipelineModuleUiIdForStream(moduleName) {
  return backendModuleNameToUiId(moduleName) || fallbackPipelineModuleUiId(moduleName);
}

/**
 * Parse backend module name from graph execution.log lines like `✓ Planning complete · …`.
 * @param {string} msg
 * @returns {string | null}
 */
export function parseModuleCompleteExecutionLogLine(msg) {
  const s = String(msg || '').trim();
  const m = s.match(/^✓\s+(.+?)\s+complete\b/);
  if (!m) return null;
  const name = m[1].trim();
  return name || null;
}

/**
 * Text from a `module_complete` SSE event. Empty string is valid.
 * @returns {string|null} `null` when neither `output` nor `preview` keys were sent.
 */
export function sseModuleCompleteOutputText(evt) {
  if (!evt || typeof evt !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(evt, 'output')) {
    const o = evt.output;
    if (o === undefined || o === null) return '';
    return String(o);
  }
  if (Object.prototype.hasOwnProperty.call(evt, 'preview')) {
    const p = evt.preview;
    if (p === undefined || p === null) return '';
    return String(p);
  }
  return null;
}

function moduleOutputValueToUiString(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return null;
    }
  }
  return String(v);
}

/** Server stores moduleOutputs with Title Case keys; graph UI uses lowercase ids. */
export function normalizeModuleOutputsFromServer(moduleOutputs) {
  const raw = moduleOutputs || {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.endsWith('__meta')) continue;
    const uiId = backendModuleNameToUiId(k) || (getModule(k) ? k : null);
    if (!uiId) continue;
    const text = moduleOutputValueToUiString(v);
    if (text !== null) out[uiId] = text;
  }
  return out;
}

/**
 * Merge UI-keyed module output maps. Prefer the longer string per key so SSE `module_complete` bodies
 * are not replaced by shorter `complete`-event sharedMemory (e.g. after server compressSharedMemory).
 * @param {Record<string, string>|null|undefined} prev
 * @param {Record<string, string>|null|undefined} incoming
 */
export function mergeModuleOutputsPreferLonger(prev, incoming) {
  const a0 = prev && typeof prev === 'object' ? prev : {};
  const b0 = incoming && typeof incoming === 'object' ? incoming : {};
  const keys = new Set([...Object.keys(a0), ...Object.keys(b0)]);
  const out = {};
  for (const k of keys) {
    const a = String(a0[k] ?? '');
    const b = String(b0[k] ?? '');
    out[k] = b.length > a.length ? b : a;
  }
  return out;
}

export function getDefaultSharedMemory(sessionId) {
  return {
    sessionId: sessionId || crypto.randomUUID(),
    iteration: 0,
    inputs: [],
    moduleOutputs: {},
    emotionalState: 'neutral',
    currentIdentity: 'MyBrain Local Cognitive System',
    activeGoals: [],
    narrativeHistory: [],
    sessionNumber: 0,
    beliefSnapshot: [],
    curiosityQueue: [],
    somaticState: {},
  };
}
