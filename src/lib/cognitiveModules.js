import { PIPELINE_LAYER_KEYS, PIPELINE_LAYERS } from '../../shared/pipelineModules.mjs';

export const COGNITIVE_MODULES = [
  {
    id: 'sensorySalience',
    name: 'SensorySalience',
    color: '#06b6d4',
    description: 'Perception + attention ingress: explicit/implicit content and SALIENT_* foci; seeds working memory.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — EXPLICIT/IMPLICIT/AFFECT + numbered SALIENT lines.',
  },
  {
    id: 'contextMemory',
    name: 'ContextMemory',
    color: '#3b82f6',
    description: 'Memory + learning + temporal: RETRIEVED/GAPS, NOVELTY, SURPRISE_ASSESSMENT, continuity threads.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — merged Memory/Learning/Temporal Awareness contract.',
  },
  {
    id: 'deliberation',
    name: 'Deliberation',
    color: '#f59e0b',
    description: 'Planning + reasoning + affect + ToM: GOAL/STEPS, PREMISES/HYPOTHESES, USER_STANCE_PREDICTION.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — single deliberation stage with machine-readable tails.',
  },
  {
    id: 'beliefs',
    name: 'Beliefs',
    color: '#10b981',
    description: 'Belief ledger: BELIEF lines, BELIEF_REVISIONS, EPISTEMIC_CLAIMS; reconciles PERSISTED_BELIEF_STORE.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs (legacy Belief Store protocol).',
  },
  {
    id: 'selfRelationTension',
    name: 'SelfRelationTension',
    color: '#a855f7',
    description: 'Self-reflection + identity + social + contradiction audit; TENSIONS; not raw to Voice.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — STRONG/WEAK, IDENTITY_REFLECTION, DYNAMICS, TENSIONS.',
  },
  {
    id: 'integration',
    name: 'Integration',
    color: '#5b21b6',
    description: 'GWT round 1 (draft): INTEGRATION_JSON broadcast packet after specialists + executive review input.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — WORKSPACE_ROUND 1 draft.',
  },
  {
    id: 'executiveGate',
    name: 'ExecutiveGate',
    color: '#6366f1',
    description: 'Unified supervisor: PROCEED/RERUN after draft workspace; structural + workspace heuristics.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — merges legacy Metacognition + Workspace Metacognition.',
  },
  {
    id: 'integrationFinalize',
    name: 'IntegrationFinalize',
    color: '#4c1d95',
    description: 'GWT round 2 (final): refines GLOBAL_WORKSPACE_JSON for Motivation → Narrative → Voice.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — final INTEGRATION_JSON merge.',
  },
  {
    id: 'motivation',
    name: 'Motivation',
    color: '#f97316',
    description: 'Curiosity + goals + somatic: MAIN_QUESTION, GOAL_URGENCY, embodied read.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — merged Curiosity / Goal Generation / Somatic Marker.',
  },
  {
    id: 'narrative',
    name: 'Narrative',
    color: '#818cf8',
    description: 'Linguistic scaffold + internal arc; honors GLOBAL_WORKSPACE_JSON before Voice.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — LINGUISTIC_SCAFFOLD + INTERNAL_ARC.',
  },
  {
    id: 'voice',
    name: 'Voice',
    color: '#eab308',
    description: 'Final user-facing text; no assistant framing.',
    systemPrompt:
      'Canonical: shared/pipelineModules.mjs — Voice contract.',
  },
];

/**
 * Server `moduleName` (from SSE / shared memory) → UI `id`.
 * Built from {@link COGNITIVE_MODULES} so names stay aligned with `shared/pipelineModules.mjs`.
 */
const BACKEND_MODULE_TO_UI_ID = Object.fromEntries(COGNITIVE_MODULES.map((m) => [m.name, m.id]));

/** Pre–schema-v2 names → closest UI id for displaying historical `moduleOutputs` keys. */
const LEGACY_BACKEND_MODULE_TO_UI_ID = {
  Perception: 'sensorySalience',
  Attention: 'sensorySalience',
  Memory: 'contextMemory',
  Learning: 'contextMemory',
  'Temporal Awareness': 'contextMemory',
  Planning: 'deliberation',
  Reasoning: 'deliberation',
  Emotion: 'deliberation',
  'Theory of Mind': 'deliberation',
  'Self-Reflection': 'selfRelationTension',
  Identity: 'selfRelationTension',
  'Social Cognition': 'selfRelationTension',
  'Contradiction Engine': 'selfRelationTension',
  'Belief Store': 'beliefs',
  Metacognition: 'executiveGate',
  'Workspace Metacognition': 'executiveGate',
  Curiosity: 'motivation',
  'Goal Generation': 'motivation',
  'Somatic Marker': 'motivation',
  Language: 'narrative',
};

/** Short labels for execution-graph swimlanes (server stages layer1–layer6). */
export const PIPELINE_STAGE_LABELS = {
  layer1: 'Interface & salience',
  layer2: 'Context & continuity',
  layer3: 'Deliberation & beliefs',
  layer4: 'Self & tension',
  layer5: 'Global workspace & drives',
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
 * 0–1 along the equal-width layer segments: right edge of layer5 /
 * boundary before layer6 (Articulation). Used for linear progress markers (Dashboard / Live Analytics).
 */
export const PIPELINE_LAYER5_END_FRACTION = Object.freeze(
  (() => {
    const layers = getServerExecutionLayers();
    const idx = layers.findIndex((l) => l.layerKey === 'layer5');
    if (idx < 0 || layers.length === 0) return 0;
    return (idx + 1) / layers.length;
  })()
);

/**
 * @deprecated Alias for {@link PIPELINE_LAYER5_END_FRACTION} — executive + workspace stages run in layer5.
 */
export const PIPELINE_METACOGNITION_END_FRACTION = PIPELINE_LAYER5_END_FRACTION;

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
  const legacy = LEGACY_BACKEND_MODULE_TO_UI_ID[s];
  if (legacy) return legacy;
  const lower = s.toLowerCase();
  for (const k of Object.keys(BACKEND_MODULE_TO_UI_ID)) {
    if (k.toLowerCase() === lower) return BACKEND_MODULE_TO_UI_ID[k];
  }
  for (const k of Object.keys(LEGACY_BACKEND_MODULE_TO_UI_ID)) {
    if (k.toLowerCase() === lower) return LEGACY_BACKEND_MODULE_TO_UI_ID[k];
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
    const uiId = backendModuleNameToUiId(k) || fallbackPipelineModuleUiId(k);
    const text = moduleOutputValueToUiString(v);
    if (text !== null) {
      const prior = out[uiId] ? String(out[uiId]) : '';
      const next = String(text);
      out[uiId] = next.length > prior.length ? next : prior || next;
    }
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
    currentIdentity: 'MetaSelf-CognitiveStack Local Cognitive System',
    activeGoals: [],
    narrativeHistory: [],
    sessionNumber: 0,
    beliefSnapshot: [],
    curiosityQueue: [],
    somaticState: {},
  };
}
