import { normalizeBeliefMapCategory } from '../../shared/beliefMapCategory.mjs';
import { clipTextComplete } from '../../shared/textClip.mjs';
import { isBeliefTensionReviewPrimaryTurn } from '../../shared/beliefRevisionsVoice.mjs';
import {
  collectPipelineEmergenceMarkers,
  derivePipelineBiographyIdentityFields,
  EVIDENCE_QUOTE_MAX,
  extractNarrativeSections,
  mergeDedupedStrings,
} from '../../shared/biographyIdentityExtract.mjs';
import {
  getMindEntityStores,
  getMindEntityStoresForProfile,
  getActiveMindEntityProfile,
  setActiveMindEntityProfile,
  normalizeScheduledTaskMindStorageProfile,
  MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
} from './mindEntityContext';
import { isCheckpointPipelineRun } from './pipelineRunCheckpoint';
import { openrouterRequestFields } from './llmClientOptions';
import { getRuntimeSettings, saveRuntimeSettings } from './runtimeSettings';
import { notifyMindStorageChanged } from './mindStorageEvents';
import { invokeLLM } from './llm';
import {
  buildWorldModelCreatePayload,
  buildWorldModelUpdatePayload,
  humanizeUnityRationaleForDisplay,
  itemKeyForRecord,
  normalizeWorldModelCategory,
  stableWorldModelKey,
} from './worldModelSchema';
import {
  beliefStatementsForDisplay,
  isJunkBeliefStatement,
  isUnparsedBeliefModuleReport,
  parseBeliefModuleOutput,
} from './beliefReportParse';
import { PIPELINE_BIOGRAPHY_SNAPSHOT_EVERY_N_RUNS } from './cognitiveHealthDerived';
import {
  formatPipelineRunContextForBiography,
  generateMindBiographyViaLlm,
  persistMindBiographyVersion,
} from './mindBiographyLlm.js';
import { finalizeNewCuriosityRoot } from './curiosityLineage';
import { finalizeNewGoalRoot } from './goalLineage';
import {
  maybeQueueBeliefTensionReviewFromPipeline,
  maybeQueueMetaFollowupsFromPipeline,
} from './mindFollowThroughQueue';
import { removeBeliefIdFromOthersContradicts } from './beliefStoreContradictionUtils';
import { isValidIndexedDbRecordKey } from './browserStorage.js';
import {
  computeFollowUpPriority,
  DEFAULT_CURIOUS_PIPELINE_PRIORITY,
  DEFAULT_GOAL_PIPELINE_PRIORITY,
  parseCuriosityUrgencyFromOutput,
  parseFollowupCuriositiesFromModuleOutput,
  parseGoalUrgencyFromOutput,
} from './priorityUtils';

const E = () => getMindEntityStores();

function storesForPipelineLoad(opts = {}) {
  if (opts.mindStorageProfile !== undefined) {
    return getMindEntityStoresForProfile(normalizeScheduledTaskMindStorageProfile(opts.mindStorageProfile));
  }
  return getMindEntityStores();
}

export { clipTextComplete };

export const MIND_PHASE_OPTIONS = [
  { id: 'wake', label: 'Wake — orient' },
  { id: 'focus', label: 'Focus — engage' },
  { id: 'drift', label: 'Drift — idle association' },
  { id: 'sleep', label: 'Sleep — consolidate' },
];

function truncate(s, n) {
  return clipTextComplete(s, n, { ellipsis: true });
}

/** Bounded payload for `options.structuralSelf` on pipeline POST (E().WorldModel rows, category self). */
export async function loadStructuralSelfForPipeline({ maxItems = 12, mindStorageProfile } = {}) {
  const all = await storesForPipelineLoad({ mindStorageProfile }).WorldModel.list('-updated_date', 120);
  const rows = all.filter((w) => {
    if (w.archived) return false;
    return normalizeWorldModelCategory(w.category) === 'self';
  });
  return rows.slice(0, maxItems).map((w) => ({
    key: itemKeyForRecord(w),
    label: clipTextComplete(String(w.label || w.name || ''), 200, { ellipsis: false }),
    description: clipTextComplete(String(w.description || w.value || ''), 1200, { ellipsis: false }),
    confidence: typeof w.confidence === 'number' && Number.isFinite(w.confidence) ? w.confidence : 0.65,
  }));
}

/** Non-self E().WorldModel rows for pipeline POST (environment, relationship, goal, belief, event). */
export async function loadWorldModelEnvironmentForPipeline({ maxItems = 14, mindStorageProfile } = {}) {
  const all = await storesForPipelineLoad({ mindStorageProfile }).WorldModel.list('-updated_date', 120);
  const rows = all.filter((w) => {
    if (w.archived) return false;
    return normalizeWorldModelCategory(w.category) !== 'self';
  });
  return rows.slice(0, maxItems).map((w) => ({
    category: normalizeWorldModelCategory(w.category),
    key: itemKeyForRecord(w),
    label: clipTextComplete(String(w.label || w.name || ''), 200, { ellipsis: false }),
    description: clipTextComplete(String(w.description || w.value || ''), 900, { ellipsis: true }),
    confidence: typeof w.confidence === 'number' && Number.isFinite(w.confidence) ? w.confidence : 0.65,
  }));
}

/** Open / pursuing curiosity items for pipeline prep (bounded). */
export async function loadCuriosityRowsForPipeline({ maxItems = 10, mindStorageProfile } = {}) {
  const all = await storesForPipelineLoad({ mindStorageProfile }).CuriosityItem.list('-created_date', 50);
  const open = all.filter((c) => {
    const s = c.status || 'open';
    return s === 'open' || s === 'pursuing';
  });
  return open
    .slice(0, maxItems)
    .map((c) => ({
      question: clipTextComplete(String(c.question || '').trim(), 420, { ellipsis: true }),
      status: String(c.status || 'open').slice(0, 20),
      priority:
        typeof c.priority === 'number' && Number.isFinite(c.priority) ? Math.min(1, Math.max(0, c.priority)) : null,
    }))
    .filter((x) => x.question);
}

/** Open / pursuing goal items for pipeline prep (bounded). */
export async function loadGoalRowsForPipeline({ maxItems = 8, mindStorageProfile } = {}) {
  const all = await storesForPipelineLoad({ mindStorageProfile }).GoalItem.list('-created_date', 80);
  const open = all.filter((g) => {
    const s = g.status || 'open';
    return s === 'open' || s === 'pursuing';
  });
  return open
    .slice(0, maxItems)
    .map((g) => ({
      statement: clipTextComplete(String(g.goal_statement || '').trim(), 520, { ellipsis: true }),
      status: String(g.status || 'open').slice(0, 20),
      priority:
        typeof g.priority === 'number' && Number.isFinite(g.priority) ? Math.min(1, Math.max(0, g.priority)) : null,
    }))
    .filter((x) => x.statement);
}

/** Volatile working-memory slots: current user message + optional pinned lines from settings. */
export function buildWorkingMemorySeed(userInput, pinnedList) {
  const items = [];
  const u = String(userInput || '').trim();
  if (u) items.push({ text: clipTextComplete(u, 6000, { ellipsis: false }), source: 'current_input' });
  const pins = Array.isArray(pinnedList) ? pinnedList : [];
  for (const p of pins.slice(0, 8)) {
    const t = typeof p === 'string' ? p.trim() : '';
    if (t) items.push({ text: clipTextComplete(t, 2000, { ellipsis: false }), source: 'pinned' });
  }
  return items;
}

export function parseUserModelDelta(theoryOfMindText) {
  const raw = String(theoryOfMindText || '');
  const idx = raw.search(/USER_MODEL_DELTA:/i);
  if (idx === -1) return null;
  const sub = raw.slice(idx).replace(/^USER_MODEL_DELTA:\s*/i, '');
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
  if (end === -1) return null;
  try {
    return JSON.parse(sub.slice(brace, end + 1));
  } catch {
    return null;
  }
}

function clipUserModelField(curRaw, deltaRaw, maxLen) {
  if (deltaRaw !== undefined && deltaRaw !== null) {
    const t = String(deltaRaw).trim();
    if (t.length > 0) {
      return clipTextComplete(t, maxLen, { ellipsis: false });
    }
  }
  return clipTextComplete(String(curRaw ?? '').trim(), maxLen, { ellipsis: false });
}

/**
 * Merge Theory of Mind USER_MODEL_DELTA into persisted userModel.
 * Empty or whitespace-only delta fields keep prior values (models often send template blanks).
 * Returns null if nothing would change (no save / no snapshot).
 */
export function mergeUserModelDelta(currentUserModel, delta) {
  if (!delta || typeof delta !== 'object') return null;
  const cur = currentUserModel && typeof currentUserModel === 'object' ? currentUserModel : {};
  const next = {
    display_name: clipUserModelField(cur.display_name, delta.display_name, 120),
    goals: clipUserModelField(cur.goals, delta.goals, 2000),
    expertise: clipUserModelField(cur.expertise, delta.expertise, 2000),
    emotional_state: clipUserModelField(cur.emotional_state, delta.emotional_state, 1000),
    communication_style: clipUserModelField(
      cur.communication_style,
      delta.communication_style,
      1000
    ),
  };
  const baseline = {
    display_name: clipUserModelField(cur.display_name, undefined, 120),
    goals: clipUserModelField(cur.goals, undefined, 2000),
    expertise: clipUserModelField(cur.expertise, undefined, 2000),
    emotional_state: clipUserModelField(cur.emotional_state, undefined, 1000),
    communication_style: clipUserModelField(cur.communication_style, undefined, 1000),
  };
  const unchanged =
    next.display_name === baseline.display_name &&
    next.goals === baseline.goals &&
    next.expertise === baseline.expertise &&
    next.emotional_state === baseline.emotional_state &&
    next.communication_style === baseline.communication_style;
  if (unchanged) return null;
  const baseVersion = Number(cur.version) || 0;
  return { ...next, version: baseVersion + 1 };
}

export function parseSelfModelDelta(identityText) {
  const raw = String(identityText || '');
  const idx = raw.search(/SELF_MODEL_DELTA:/i);
  if (idx === -1) return null;
  const sub = raw.slice(idx).replace(/^SELF_MODEL_DELTA:\s*/i, '');
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
  if (end === -1) return null;
  try {
    return JSON.parse(sub.slice(brace, end + 1));
  } catch {
    return null;
  }
}

const TRAIT_TRIGGERS = new Set(['user_tone', 'user_content', 'self_reflection', 'constitution_tension']);

const PERSONALITY_FACET_TARGET_MODULES = new Set([
  'SelfRelationTension',
  'Integration',
  'IntegrationFinalize',
  'Narrative',
  'Voice',
  'ExecutiveGate',
]);

function normalizeFacetModulesForClient(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw.slice(0, 6)) {
    const m = String(x || '').trim();
    if (PERSONALITY_FACET_TARGET_MODULES.has(m)) out.push(m);
  }
  return out;
}

export function parseTraitDelta(identityText) {
  const raw = String(identityText || '');
  const idx = raw.search(/TRAIT_DELTA:/i);
  if (idx === -1) return null;
  const sub = raw.slice(idx).replace(/^TRAIT_DELTA:\s*/i, '');
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
  if (end === -1) return null;
  let parsed;
  try {
    parsed = JSON.parse(sub.slice(brace, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}

const CONSTITUTION_TOTAL_CAP = 12000;
const CONSTITUTION_DELTA_CHUNK_CAP = 4000;

export function parseConstitutionDelta(identityText) {
  const raw = String(identityText || '');
  const idx = raw.search(/CONSTITUTION_DELTA:/i);
  if (idx === -1) return null;
  const sub = raw.slice(idx).replace(/^CONSTITUTION_DELTA:\s*/i, '');
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
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(sub.slice(brace, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const MIND_DISPLAY_NAME_MAX = 120;

export function parseMindDisplayNameDelta(identityText) {
  const raw = String(identityText || '');
  const idx = raw.search(/MIND_DISPLAY_NAME_DELTA:/i);
  if (idx === -1) return null;
  const sub = raw.slice(idx).replace(/^MIND_DISPLAY_NAME_DELTA:\s*/i, '');
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
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(sub.slice(brace, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Merge Identity CONSTITUTION_DELTA into persisted mindConstitution (bounded). Returns null if no change. */
export function applyConstitutionDelta(currentMindConstitution, delta) {
  if (!delta || typeof delta !== 'object') return null;
  const modeRaw = String(delta.mode ?? 'append').toLowerCase();
  const mode = modeRaw === 'replace' ? 'replace' : 'append';
  const text = String(delta.text ?? '').trim();
  if (!text) return null;
  const chunk = clipTextComplete(text, CONSTITUTION_DELTA_CHUNK_CAP, { ellipsis: false });
  const cur = String(currentMindConstitution ?? '').trim();
  let merged;
  if (mode === 'replace') {
    merged = chunk;
  } else {
    merged = cur ? `${cur}\n${chunk}` : chunk;
  }
  const out = clipTextComplete(merged, CONSTITUTION_TOTAL_CAP, { ellipsis: false });
  if (out === cur) return null;
  return out;
}

const MODULE_PROMPT_DELTA_TEXT_CAP = 2000;
const MODULE_PROMPT_DELTA_MAX_DELTAS = 2;

const VALID_PIPELINE_MODULE_NAMES = new Set([
  'SensorySalience',
  'ContextMemory',
  'Deliberation',
  'Beliefs',
  'SelfRelationTension',
  'Integration',
  'ExecutiveGate',
  'IntegrationFinalize',
  'Motivation',
  'Narrative',
  'Voice',
]);

export function parseModulePromptDelta(identityText) {
  const raw = String(identityText || '');
  const idx = raw.search(/MODULE_PROMPT_DELTA:/i);
  if (idx === -1) return null;
  const sub = raw.slice(idx).replace(/^MODULE_PROMPT_DELTA:\s*/i, '');
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
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(sub.slice(brace, end + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    const deltas = Array.isArray(parsed.deltas) ? parsed.deltas : [];
    const valid = [];
    for (const d of deltas.slice(0, MODULE_PROMPT_DELTA_MAX_DELTAS)) {
      const mod = String(d.module || '').trim();
      if (!mod || !VALID_PIPELINE_MODULE_NAMES.has(mod)) continue;
      const action = String(d.action || '').toLowerCase();
      if (!['append', 'replace', 'clear'].includes(action)) continue;
      const text = action === 'clear' ? '' : String(d.text || '').trim();
      if (action !== 'clear' && !text) continue;
      valid.push({
        module: mod,
        action,
        text: clipTextComplete(text, MODULE_PROMPT_DELTA_TEXT_CAP, { ellipsis: false }),
        rationale: String(d.rationale || '').trim().slice(0, 500),
      });
    }
    return valid.length ? valid : null;
  } catch {
    return null;
  }
}

/**
 * Apply parsed MODULE_PROMPT_DELTA entries into the existing modulePromptOverrides map.
 * Returns a new overrides object if changes were made, or null if no change.
 */
export function applyModulePromptDeltas(currentOverrides, deltas) {
  if (!Array.isArray(deltas) || !deltas.length) return null;
  const overrides = { ...(currentOverrides && typeof currentOverrides === 'object' ? currentOverrides : {}) };
  let changed = false;
  for (const d of deltas) {
    const { module: mod, action, text } = d;
    if (action === 'clear') {
      if (overrides[mod]) {
        delete overrides[mod];
        changed = true;
      }
    } else if (action === 'replace') {
      if (text) {
        overrides[mod] = text;
        changed = true;
      }
    } else if (action === 'append') {
      if (text) {
        const cur = String(overrides[mod] || '').trim();
        const merged = cur ? `${cur}\n\n${text}` : text;
        overrides[mod] = clipTextComplete(merged, 32000, { ellipsis: false });
        changed = true;
      }
    }
  }
  return changed ? overrides : null;
}

function stableFacetKey(id, label) {
  const i = String(id || '').trim().toLowerCase();
  if (i) return i;
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

/**
 * Merge Identity TRAIT_DELTA into the persisted personality profile (bounded, client-side).
 */
export function applyTraitDeltaToProfile(profile, delta) {
  const base =
    profile && typeof profile === 'object'
      ? profile
      : { version: 0, facets: [], relationalStance: null, systemTreatmentNotes: '' };
  if (!delta || typeof delta !== 'object') return base;
  const deprecate = new Set(
    Array.isArray(delta.deprecateFacetIds) ? delta.deprecateFacetIds.map((x) => String(x).trim().toLowerCase()) : []
  );
  let facets = Array.isArray(base.facets) ? [...base.facets] : [];
  facets = facets.filter((f) => !deprecate.has(String(f.id || '').trim().toLowerCase()));

  const updates = Array.isArray(delta.facets) ? delta.facets.slice(0, 8) : [];
  const byKey = new Map();
  for (const f of facets) {
    const k = stableFacetKey(f.id, f.label);
    if (k) byKey.set(k, f);
  }
  for (const u of updates) {
    if (!u || typeof u !== 'object') continue;
    const label = clipTextComplete(String(u.label || u.id || '').trim(), 80, { ellipsis: false });
    const id = clipTextComplete(String(u.id || label || '').trim(), 80, { ellipsis: false });
    if (!label && !id) continue;
    const key = stableFacetKey(id, label);
    const prev = byKey.get(key) || {};
    const trig = String(u.trigger || '').trim();
    const trigger = TRAIT_TRIGGERS.has(trig) ? trig : 'self_reflection';
    const strength = Number(u.strength);
    const confidence = Number(u.confidence);
    const row = {
      id: id || label,
      label: label || id,
      strength: Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0.5,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
      evidence: clipTextComplete(String(u.evidence || ''), 400, { ellipsis: false }),
      trigger,
      updatedAt: new Date().toISOString(),
    };
    row.core = typeof u.core === 'boolean' ? u.core : !!prev.core;
    if ('modules' in u && Array.isArray(u.modules)) {
      const mods = normalizeFacetModulesForClient(u.modules);
      if (mods.length) row.modules = mods;
      else delete row.modules;
    } else if (Array.isArray(prev.modules) && prev.modules.length) {
      row.modules = prev.modules.filter((m) => PERSONALITY_FACET_TARGET_MODULES.has(String(m)));
    }
    byKey.set(key, row);
  }
  facets = [...byKey.values()].slice(0, 24);

  let relationalStance = base.relationalStance && typeof base.relationalStance === 'object' ? base.relationalStance : {};
  if (delta.relationalStance && typeof delta.relationalStance === 'object') {
    const rs = delta.relationalStance;
    relationalStance = {
      ...relationalStance,
      towardUser: clipTextComplete(String(rs.towardUser ?? relationalStance.towardUser ?? ''), 120, {
        ellipsis: false,
      }),
      notes: clipTextComplete(String(rs.notes ?? relationalStance.notes ?? ''), 400, { ellipsis: false }),
      confidence: Number.isFinite(Number(rs.confidence))
        ? Math.min(1, Math.max(0, Number(rs.confidence)))
        : relationalStance.confidence,
    };
  }

  const systemTreatmentNotes =
    typeof delta.systemTreatmentNotes === 'string'
      ? clipTextComplete(delta.systemTreatmentNotes, 800, { ellipsis: false })
      : base.systemTreatmentNotes || '';

  return {
    version: (Number(base.version) || 0) + 1,
    facets,
    relationalStance: Object.keys(relationalStance).length ? relationalStance : null,
    systemTreatmentNotes: systemTreatmentNotes || '',
    ...(base.suppressBundledPersonalityDefaults === true ? { suppressBundledPersonalityDefaults: true } : {}),
  };
}

export async function applySelfModelDeltaToWorldModel(delta) {
  if (!delta || typeof delta !== 'object') return;
  const items = Array.isArray(delta.items) ? delta.items : [];
  for (const it of items.slice(0, 16)) {
    if (!it || typeof it !== 'object') continue;
    const label = clipTextComplete(String(it.label || '').trim(), 200, { ellipsis: false });
    if (!label) continue;
    const description = clipTextComplete(String(it.description || it.value || ''), 2000, { ellipsis: false });
    const confidenceRaw = Number(it.confidence);
    const confidence =
      Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0.05, confidenceRaw)) : 0.65;
    const canon = 'self';
    const key =
      it.key && String(it.key).trim()
        ? clipTextComplete(String(it.key).trim(), 160, { ellipsis: false })
        : stableWorldModelKey(canon, label);
    const all = await E().WorldModel.list('-updated_date', 200);
    const existing = all.find((i) => itemKeyForRecord(i) === key);
    if (existing) {
      const patch = buildWorldModelUpdatePayload(
        existing,
        {
          description,
          confidence,
          evidence: 'identity SELF_MODEL_DELTA',
          category: canon,
          label,
          name: label,
          key,
          last_updated_by: 'identity',
        },
        'identity',
        'SELF_MODEL_DELTA'
      );
      await E().WorldModel.update(existing.id, patch);
    } else {
      await E().WorldModel.create(
        buildWorldModelCreatePayload({
          category: canon,
          label,
          description,
          confidence,
          last_updated_by: 'identity',
          evidence: 'SELF_MODEL_DELTA',
          extra: { key },
        })
      );
    }
  }
}

/**
 * Downgrade confidence on stale world-model rows; archive when below floor.
 */
export async function applyWorldModelDecay({
  staleDays = 45,
  factor = 0.92,
  minConfidence = 0.12,
  archiveBelow = 0.1,
} = {}) {
  const all = await E().WorldModel.list('-updated_date', 500);
  const cutoff = Date.now() - staleDays * 86400000;
  let touched = 0;
  for (const rec of all) {
    if (rec.archived) continue;
    const u = rec.updated_date ? new Date(rec.updated_date).getTime() : 0;
    if (!u || u >= cutoff) continue;
    const c0 = typeof rec.confidence === 'number' ? rec.confidence : 0.65;
    const c1 = Math.max(minConfidence, c0 * factor);
    const archived = c1 <= archiveBelow;
    await E().WorldModel.update(rec.id, {
      confidence: archived ? archiveBelow : c1,
      archived,
      last_updated_by: 'decay',
    });
    touched += 1;
  }
  return touched;
}

export function extractIntegrationJsonObject(text) {
  const raw = String(text || '');
  const idx = raw.search(/INTEGRATION_JSON:\s*/i);
  if (idx === -1) return null;
  const sub = raw.slice(idx).replace(/^INTEGRATION_JSON:\s*/i, '');
  const brace = sub.indexOf('{');
  if (brace === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = brace; i < sub.length; i += 1) {
    if (sub[i] === '{') depth += 1;
    else if (sub[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    const j = JSON.parse(sub.slice(brace, end + 1));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function normalizeGlobalWorkspaceFields(gw) {
  if (!gw || typeof gw !== 'object') return null;
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
  const unityRaw = String(gw.phenomenalUnity || 'partial').toLowerCase();
  const phenomenalUnity = ['unified', 'partial', 'split'].includes(unityRaw) ? unityRaw : 'partial';
  const rawIit = gw.iitProxy && typeof gw.iitProxy === 'object' ? gw.iitProxy : null;
  const ct = Number(rawIit?.causalTightness);
  const iitProxy = rawIit
    ? {
        causalTightness: Number.isFinite(ct) ? Math.min(1, Math.max(0, ct)) : 0.5,
        note: String(rawIit.note || '').slice(0, 320),
      }
    : null;
  const broadcastWinners = Array.isArray(gw.broadcastWinners)
    ? gw.broadcastWinners.map((s) => String(s).slice(0, 280)).filter(Boolean).slice(0, 4)
    : [];
  const bindingsRaw = Array.isArray(gw.bindings) ? gw.bindings : [];
  const bindings = [];
  for (const b of bindingsRaw.slice(0, 10)) {
    if (!b || typeof b !== 'object') continue;
    const sourceModules = Array.isArray(b.sourceModules)
      ? b.sourceModules.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
      : [];
    const claim = String(b.claim || '').trim().slice(0, 400);
    if (!claim || !sourceModules.length) continue;
    bindings.push({ sourceModules, claim });
  }
  const hypotheses = Array.isArray(gw.hypotheses)
    ? gw.hypotheses
        .map((h) => {
          if (!h || typeof h !== 'object') return null;
          const label = String(h.label || '').trim();
          if (!label) return null;
          const w = Number(h.weight);
          return {
            id: String(h.id || '').trim().slice(0, 32),
            label: label.slice(0, 400),
            weight: Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.5,
            evidence_for: String(h.evidence_for || h.evidenceFor || '').trim().slice(0, 320),
            evidence_against: String(h.evidence_against || h.evidenceAgainst || '').trim().slice(0, 320),
            would_flip_if: String(h.would_flip_if || h.wouldFlipIf || '').trim().slice(0, 280),
          };
        })
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const suppressedOrPeripheral = Array.isArray(gw.suppressedOrPeripheral)
    ? gw.suppressedOrPeripheral.map((s) => String(s).slice(0, 220)).filter(Boolean).slice(0, 6)
    : [];
  return {
    salience: Array.isArray(gw.salience) ? gw.salience.map((s) => String(s).slice(0, 400)) : [],
    conflicts: Array.isArray(gw.conflicts) ? gw.conflicts.map((s) => String(s).slice(0, 500)) : [],
    openQuestions: Array.isArray(gw.openQuestions) ? gw.openQuestions.map((s) => String(s).slice(0, 400)) : [],
    provisionalStance: String(gw.provisionalStance || '').slice(0, 1200),
    integrationConfidence:
      typeof gw.integrationConfidence === 'number' && Number.isFinite(gw.integrationConfidence)
        ? Math.min(1, Math.max(0, gw.integrationConfidence))
        : 0.55,
    broadcastWinners,
    phenomenalUnity,
    unityRationale: String(gw.unityRationale || '').slice(0, 400),
    ...(iitProxy ? { iitProxy } : {}),
    epistemicThreads,
    ...(bindings.length ? { bindings } : {}),
    ...(suppressedOrPeripheral.length ? { suppressedOrPeripheral } : {}),
    ...(hypotheses.length ? { hypotheses } : {}),
  };
}

/** Normalize Integration JSON whether already on sharedMemory.globalWorkspace or only in module text. */
function getGlobalWorkspaceFromSharedMemory(sm) {
  const g = sm?.globalWorkspace;
  const hasG =
    g &&
    typeof g === 'object' &&
    (Array.isArray(g.salience) ||
      Array.isArray(g.conflicts) ||
      Array.isArray(g.openQuestions) ||
      (typeof g.provisionalStance === 'string' && g.provisionalStance.trim()) ||
      Array.isArray(g.broadcastWinners) ||
      Array.isArray(g.suppressedOrPeripheral) ||
      typeof g.phenomenalUnity === 'string' ||
      Array.isArray(g.hypotheses) ||
      Array.isArray(g.bindings));
  if (hasG) return normalizeGlobalWorkspaceFields(g);
  const gw = extractIntegrationJsonObject(sm?.moduleOutputs?.Integration);
  if (!gw) return null;
  return normalizeGlobalWorkspaceFields(gw);
}

function parseJsonAfterMarkerLocal(text, marker) {
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
    else if (sub[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(sub.slice(brace, end + 1));
  } catch {
    return null;
  }
}

/** Apply one BELIEF_REVISIONS JSON object to persisted E().BeliefStore rows (fragile; same ref rules as server). */
export async function applyParsedBeliefRevisionsToPersistedStore(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  const revs = parsed.revisions;
  if (!Array.isArray(revs) || !revs.length) return false;
  const rows = await E().BeliefStore.list('-created_date', 400);
  let touched = false;
  for (const r of revs.slice(0, 20)) {
    const ref = String(r?.ref || '').trim();
    const action = String(r?.action || '').toLowerCase();
    const nc = Number(r?.newConfidence);
    if (!ref) continue;
    for (const row of rows) {
      const stmt = String(row.statement || '');
      if (!stmt.includes(ref) && ref.length > 3 && !stmt.slice(0, 400).includes(ref.slice(0, 80))) continue;
      if (action === 'downgrade' || action === 'weaken') {
        const c0 = typeof row.confidence === 'number' ? row.confidence : 0.5;
        await E().BeliefStore.update(row.id, {
          confidence: Math.max(0.05, Number.isFinite(nc) ? nc : c0 * 0.75),
          times_challenged: (row.times_challenged || 0) + 1,
          status: row.status || 'active',
        });
      } else if (action === 'strengthen' || action === 'reinforce') {
        const c0 = typeof row.confidence === 'number' ? row.confidence : 0.5;
        await E().BeliefStore.update(row.id, {
          confidence: Math.min(1, Number.isFinite(nc) ? nc : c0 + 0.12),
          times_reinforced: (row.times_reinforced || 0) + 1,
          status: 'active',
        });
      } else if (action === 'remove' || action === 'supersede') {
        await E().BeliefStore.update(row.id, {
          confidence: Math.min(typeof row.confidence === 'number' ? row.confidence : 0.2, 0.08),
          times_challenged: (row.times_challenged || 0) + 1,
        });
      } else if (
        action === 'resolve' ||
        action === 'resolved' ||
        action === 'mark_resolved'
      ) {
        await E().BeliefStore.update(row.id, {
          status: 'resolved',
          contradicts: [],
        });
        await removeBeliefIdFromOthersContradicts(row.id);
      } else {
        break;
      }
      touched = true;
      break;
    }
  }
  return touched;
}

/** Apply BELIEF_REVISIONS from Belief Store, then from Voice when primary turn is scheduled tension review. */
async function syncBeliefRevisionsToPersistedBeliefStore(sm) {
  let touched = false;
  const beliefStoreText = sm.moduleOutputs?.Beliefs ?? sm.moduleOutputs?.['Belief Store'];
  if (beliefStoreText && typeof beliefStoreText === 'string') {
    const p = parseJsonAfterMarkerLocal(beliefStoreText, 'BELIEF_REVISIONS');
    if (await applyParsedBeliefRevisionsToPersistedStore(p)) touched = true;
  }
  if (isBeliefTensionReviewPrimaryTurn(sm.originalInput)) {
    const voiceText = sm.moduleOutputs?.Voice;
    if (voiceText && typeof voiceText === 'string') {
      const p = parseJsonAfterMarkerLocal(voiceText, 'BELIEF_REVISIONS');
      if (await applyParsedBeliefRevisionsToPersistedStore(p)) touched = true;
    }
  }
  if (touched) notifyMindStorageChanged({ source: 'beliefs' });
}

/** Bullets or paragraph chunks for Goal / Social module prose. */
function extractProseSegmentsForWorldModel(text, { maxItems = 6, minLen = 20 } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = [];
  for (const line of lines) {
    const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    const inner = m ? m[1] : '';
    if (inner.length >= minLen) bullets.push(inner.trim());
  }
  if (bullets.length) return bullets.slice(0, maxItems);
  const paras = raw
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= minLen);
  if (paras.length) return paras.slice(0, maxItems);
  if (raw.length >= minLen) return [raw.slice(0, 3000)];
  return [];
}

async function upsertWorldModelEntry({
  category,
  label,
  description,
  confidence = 0.65,
  evidence,
  last_updated_by = 'pipeline',
}) {
  const cat = normalizeWorldModelCategory(category);
  const lab = String(label || '').trim().slice(0, 200);
  const desc = clipTextComplete(String(description || '').trim(), 6000, { ellipsis: false });
  if (!lab || desc.length < 8) return 0;
  const key = stableWorldModelKey(cat, lab);
  const all = await E().WorldModel.list('-updated_date', 200);
  const existing = all.find((i) => itemKeyForRecord(i) === key);
  const conf =
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.min(1, Math.max(0.05, confidence))
      : 0.65;

  if (existing) {
    const patch = buildWorldModelUpdatePayload(
      existing,
      {
        description: desc,
        confidence: conf,
        evidence: evidence != null ? String(evidence).trim() : existing.evidence,
        category: cat,
        label: lab,
        name: lab,
        key,
        last_updated_by,
      },
      last_updated_by,
      String(evidence || '').slice(0, 200)
    );
    await E().WorldModel.update(existing.id, patch);
  } else {
    await E().WorldModel.create(
      buildWorldModelCreatePayload({
        category: cat,
        label: lab,
        description: desc,
        confidence: conf,
        last_updated_by,
        evidence: evidence != null ? String(evidence).trim() : undefined,
        extra: { key },
      })
    );
  }
  return 1;
}

async function syncGlobalWorkspaceToWorldModel(sm) {
  const gw = getGlobalWorkspaceFromSharedMemory(sm);
  if (!gw) return 0;
  const baseConf =
    typeof gw.integrationConfidence === 'number'
      ? Math.min(1, Math.max(0.05, gw.integrationConfidence))
      : 0.55;
  let n = 0;
  const cap = 28;

  for (const s of (gw.salience || []).slice(0, 8)) {
    if (n >= cap) break;
    const t = String(s || '').trim();
    if (t.length < 12) continue;
    const collapsed = t.replace(/\s+/g, ' ');
    const label = clipTextComplete(collapsed, 72, { ellipsis: true });
    n += await upsertWorldModelEntry({
      category: 'environment',
      label,
      description: t,
      confidence: baseConf * 0.92,
      evidence: 'INTEGRATION_JSON · salience',
      last_updated_by: 'pipeline-integration',
    });
  }

  for (const s of (gw.conflicts || []).slice(0, 8)) {
    if (n >= cap) break;
    const t = String(s || '').trim();
    if (t.length < 12) continue;
    const collapsed = t.replace(/\s+/g, ' ');
    const label = clipTextComplete(`Tension · ${collapsed}`, 80, { ellipsis: true });
    n += await upsertWorldModelEntry({
      category: 'belief',
      label,
      description: t,
      confidence: baseConf * 0.88,
      evidence: 'INTEGRATION_JSON · conflicts',
      last_updated_by: 'pipeline-integration',
    });
  }

  for (const s of (gw.openQuestions || []).slice(0, 8)) {
    if (n >= cap) break;
    const t = String(s || '').trim();
    if (t.length < 12) continue;
    const collapsed = t.replace(/\s+/g, ' ');
    const label = clipTextComplete(`Open · ${collapsed}`, 80, { ellipsis: true });
    n += await upsertWorldModelEntry({
      category: 'goal',
      label,
      description: t,
      confidence: baseConf * 0.85,
      evidence: 'INTEGRATION_JSON · openQuestions',
      last_updated_by: 'pipeline-integration',
    });
  }

  for (const th of (gw.epistemicThreads || []).slice(0, 8)) {
    if (n >= cap) break;
    const thread = String(th?.thread || '').trim();
    if (thread.length < 8) continue;
    const kind = String(th?.kind || 'unknown').toLowerCase();
    let cat = 'environment';
    if (kind === 'user' || kind === 'user_attributed') cat = 'relationship';
    else if (kind === 'mind') cat = 'self';
    else if (kind === 'shared') cat = 'belief';
    const collapsed = thread.replace(/\s+/g, ' ');
    const label = clipTextComplete(`Thread (${kind}) · ${collapsed}`, 88, { ellipsis: true });
    n += await upsertWorldModelEntry({
      category: cat,
      label,
      description: thread,
      confidence: baseConf * 0.9,
      evidence: `INTEGRATION_JSON · epistemicThreads · ${kind}`,
      last_updated_by: 'pipeline-integration',
    });
  }

  for (const s of (gw.broadcastWinners || []).slice(0, 4)) {
    if (n >= cap) break;
    const t = String(s || '').trim();
    if (t.length < 8) continue;
    const collapsed = t.replace(/\s+/g, ' ');
    const label = clipTextComplete(`Broadcast · ${collapsed}`, 80, { ellipsis: true });
    n += await upsertWorldModelEntry({
      category: 'environment',
      label,
      description: t,
      confidence: baseConf * 0.94,
      evidence: 'INTEGRATION_JSON · broadcastWinners',
      last_updated_by: 'pipeline-integration',
    });
  }

  const unity = String(gw.phenomenalUnity || '').toLowerCase();
  const ur = humanizeUnityRationaleForDisplay(String(gw.unityRationale || '').trim());
  if (n < cap && ur.length >= 12 && ['unified', 'partial', 'split'].includes(unity)) {
    n += await upsertWorldModelEntry({
      category: 'self',
      label: clipTextComplete(`Workspace unity · ${unity}`, 72, { ellipsis: true }),
      description: ur,
      confidence: baseConf * 0.82,
      evidence: 'INTEGRATION_JSON · phenomenalUnity',
      last_updated_by: 'pipeline-integration',
    });
  }

  return n;
}

async function syncGoalGenerationToWorldModel(sm) {
  const text = textForGoalGenerationWorldModel(sm);
  let n = 0;
  for (const seg of extractProseSegmentsForWorldModel(text, { maxItems: 6, minLen: 18 })) {
    const body = seg.trim();
    const head = body.split(/[.?\n]/)[0]?.trim() || body;
    const label = clipTextComplete(head, 88, { ellipsis: true });
    n += await upsertWorldModelEntry({
      category: 'goal',
      label,
      description: body,
      confidence: 0.62,
      evidence: 'Goal Generation module',
      last_updated_by: 'pipeline-goals',
    });
  }
  return n;
}

async function syncSocialCognitionToWorldModel(sm) {
  const text = sm.moduleOutputs?.['Social Cognition'];
  let n = 0;
  for (const seg of extractProseSegmentsForWorldModel(text, { maxItems: 4, minLen: 22 })) {
    const body = seg.trim();
    const head = body.split(/[.?\n]/)[0]?.trim() || body;
    const label = clipTextComplete(head, 88, { ellipsis: true });
    n += await upsertWorldModelEntry({
      category: 'relationship',
      label,
      description: body,
      confidence: 0.6,
      evidence: 'Social Cognition module',
      last_updated_by: 'pipeline-social',
    });
  }
  return n;
}

async function syncTheoryOfMindToWorldModel(sm) {
  const text = sm.moduleOutputs?.['Theory of Mind'];
  let n = 0;
  for (const seg of extractProseSegmentsForWorldModel(text, { maxItems: 3, minLen: 24 })) {
    const body = seg.trim();
    const head = body.split(/[.?\n]/)[0]?.trim() || body;
    const label = clipTextComplete(`User model · ${head}`, 92, { ellipsis: true });
    n += await upsertWorldModelEntry({
      category: 'relationship',
      label,
      description: body,
      confidence: 0.58,
      evidence: 'Theory of Mind module',
      last_updated_by: 'pipeline-tom',
    });
  }
  return n;
}

async function syncPipelineDerivedWorldModel(sm) {
  let touched = 0;
  touched += await syncGlobalWorkspaceToWorldModel(sm);
  touched += await syncGoalGenerationToWorldModel(sm);
  touched += await syncSocialCognitionToWorldModel(sm);
  touched += await syncTheoryOfMindToWorldModel(sm);
  if (touched > 0) notifyMindStorageChanged({ source: 'world-model' });
  return touched;
}

/** Schema v2: Curiosity + Goal Generation + Somatic → `Motivation` (server) / `motivation` (UI-normalized map). */
function rawCuriosityPipelineOutput(sm) {
  const mo = sm?.moduleOutputs;
  if (!mo || typeof mo !== 'object') return '';
  const c = mo.Curiosity;
  if (typeof c === 'string' && c.trim()) return c;
  const merged = mo.Motivation ?? mo.motivation;
  return typeof merged === 'string' ? merged : '';
}

function rawGoalGenerationPipelineOutput(sm) {
  const mo = sm?.moduleOutputs;
  if (!mo || typeof mo !== 'object') return '';
  const gg = mo['Goal Generation'];
  if (typeof gg === 'string' && gg.trim()) return gg;
  const merged = mo.Motivation ?? mo.motivation;
  return typeof merged === 'string' ? merged : '';
}

/** World-model sync: prefer legacy Goal Generation text; else goals portion of merged Motivation. */
function textForGoalGenerationWorldModel(sm) {
  const mo = sm?.moduleOutputs;
  if (!mo || typeof mo !== 'object') return '';
  const legacy = mo['Goal Generation'];
  if (typeof legacy === 'string' && legacy.trim()) return legacy;
  const merged = mo.Motivation ?? mo.motivation;
  if (typeof merged !== 'string' || !merged.trim()) return '';
  const idx = merged.search(/\*\*GOALS/i);
  if (idx >= 0) return merged.slice(idx);
  return merged;
}

function curiosityQuestionFromOutput(raw) {
  const t = String(raw || '').trim();
  if (t.length < 8) return '';
  const lines = t.split(/\r?\n/).map((l) => l.trim());
  const mq = lines.find((l) => /^MAIN_QUESTION:\s*/i.test(l));
  if (mq) {
    const q = mq.replace(/^MAIN_QUESTION:\s*/i, '').trim();
    if (q.length >= 8) return clipTextComplete(q, 2000, { ellipsis: false });
  }
  const paras = t.split(/\n\n+/);
  for (const p of paras) {
    const line = p.trim();
    if (!line) continue;
    if (/\?[.!\s]*$/.test(line) || line.includes('?')) {
      const one = line.split('\n').find((l) => l.includes('?'));
      return clipTextComplete((one || line).trim(), 2000, { ellipsis: false });
    }
  }
  const first = lines.find(Boolean);
  return first ? clipTextComplete(first, 2000, { ellipsis: false }) : '';
}

function normalizeCuriosityQuestionHead(q) {
  return String(q || '')
    .trim()
    .toLowerCase()
    .slice(0, 80);
}

function normalizeGoalStatementHead(g) {
  return String(g || '')
    .trim()
    .toLowerCase()
    .slice(0, 80);
}

async function syncLinkedCuriosityFollowUps(sm, curiosityPursuitContext) {
  const parentId = curiosityPursuitContext?.parentCuriosityId;
  const rootId = curiosityPursuitContext?.rootCuriosityId;
  if (!parentId || !rootId) return;

  const parent = await E().CuriosityItem.retrieve(parentId);
  if (!parent) return;
  const parentHead = normalizeCuriosityQuestionHead(parent.question);
  const parentDepth = Number.isFinite(Number(parent.pursuit_depth)) ? Number(parent.pursuit_depth) : 0;
  const nextDepth = parentDepth + 1;

  const gw = getGlobalWorkspaceFromSharedMemory(sm);
  const fromGw = (gw?.openQuestions || [])
    .map((s) => String(s).trim())
    .filter((q) => q.length >= 8);
  const fromModule = parseFollowupCuriositiesFromModuleOutput(rawCuriosityPipelineOutput(sm));

  const seen = new Set();
  /** @type {{ text: string, llmPriority?: number }[]} */
  const candidates = [];
  for (const q of fromGw) {
    const h = normalizeCuriosityQuestionHead(q);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    if (h === parentHead) continue;
    candidates.push({ text: clipTextComplete(q, 2000, { ellipsis: false }) });
  }
  for (const entry of fromModule) {
    const q = clipTextComplete(String(entry.question || '').trim(), 2000, { ellipsis: false });
    const h = normalizeCuriosityQuestionHead(q);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    if (h === parentHead) continue;
    candidates.push({
      text: q,
      ...(entry.priority != null ? { llmPriority: entry.priority } : {}),
    });
  }
  if (!candidates.length) return;

  const recent = await E().CuriosityItem.list('-created_date', 120);
  const existingHeads = new Set(recent.map((c) => normalizeCuriosityQuestionHead(c.question)));

  const parentPri = parent.priority;
  let created = 0;
  let idx = 0;
  for (const c of candidates.slice(0, 14)) {
    const q = c.text;
    const h = normalizeCuriosityQuestionHead(q);
    if (existingHeads.has(h)) continue;
    const priority = computeFollowUpPriority({
      parentPriority: parentPri,
      parentDepth,
      childDepth: nextDepth,
      llmPriority: c.llmPriority,
      candidateIndex: idx,
    });
    idx += 1;
    await E().CuriosityItem.create({
      question: q,
      status: 'open',
      source: 'pursuit-followup',
      priority,
      times_returned_to: 0,
      root_curiosity_id: rootId,
      parent_curiosity_id: parentId,
      pursuit_depth: nextDepth,
    });
    existingHeads.add(h);
    created += 1;
  }
  if (created) notifyMindStorageChanged({ source: 'curiosity' });
}

async function syncLinkedGoalFollowUps(sm, goalPursuitContext) {
  const parentId = goalPursuitContext?.parentGoalId;
  const rootId = goalPursuitContext?.rootGoalId;
  if (!parentId || !rootId) return;

  const parent = await E().GoalItem.retrieve(parentId);
  if (!parent) return;
  const parentHead = normalizeGoalStatementHead(parent.goal_statement);
  const parentDepth = Number.isFinite(Number(parent.pursuit_depth)) ? Number(parent.pursuit_depth) : 0;
  const nextDepth = parentDepth + 1;

  const gw = getGlobalWorkspaceFromSharedMemory(sm);
  const fromGw = (gw?.openQuestions || [])
    .map((s) => String(s).trim())
    .filter((q) => q.length >= 8);

  const seen = new Set();
  const candidates = [];
  for (const q of fromGw) {
    const h = normalizeGoalStatementHead(q);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    if (h === parentHead) continue;
    candidates.push(clipTextComplete(q, 2000, { ellipsis: false }));
  }
  if (!candidates.length) return;

  const recent = await E().GoalItem.list('-created_date', 120);
  const existingHeads = new Set(recent.map((c) => normalizeGoalStatementHead(c.goal_statement)));

  const parentPri = parent.priority;
  let created = 0;
  let idx = 0;
  for (const stmt of candidates.slice(0, 10)) {
    const h = normalizeGoalStatementHead(stmt);
    if (existingHeads.has(h)) continue;
    const priority = computeFollowUpPriority({
      parentPriority: parentPri,
      parentDepth,
      childDepth: nextDepth,
      llmPriority: undefined,
      candidateIndex: idx,
    });
    idx += 1;
    await E().GoalItem.create({
      goal_statement: stmt,
      status: 'open',
      source: 'pursuit-followup',
      priority,
      times_returned_to: 0,
      root_goal_id: rootId,
      parent_goal_id: parentId,
      pursuit_depth: nextDepth,
    });
    existingHeads.add(h);
    created += 1;
  }
  if (created) notifyMindStorageChanged({ source: 'goals' });
}

function goalStatementFromGoalGenerationOutput(raw) {
  const t = String(raw || '').trim();
  if (t.length < 12) return '';
  for (const label of ['THIS_TURN', 'LONGER_TERM', 'NEW']) {
    const body = sliceSection(t, label);
    if (body) {
      const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const cleaned = line.replace(/^[-*•]\s*/, '').trim();
        if (cleaned.length >= 12) {
          return clipTextComplete(cleaned, 2000, { ellipsis: false });
        }
      }
    }
  }
  const segs = extractProseSegmentsForWorldModel(t, { maxItems: 1, minLen: 12 });
  return segs[0] ? clipTextComplete(segs[0], 2000, { ellipsis: false }) : '';
}

async function syncGoalItemFromSharedMemory(sm, goalPursuitContext = null) {
  if (goalPursuitContext?.parentGoalId) {
    try {
      await syncLinkedGoalFollowUps(sm, goalPursuitContext);
    } catch (e) {
      console.warn('syncLinkedGoalFollowUps', e);
    }
    return;
  }

  const ggRaw = rawGoalGenerationPipelineOutput(sm);
  const stmt = goalStatementFromGoalGenerationOutput(ggRaw);
  if (!stmt || stmt.length < 12) return;
  const recent = await E().GoalItem.list('-created_date', 40);
  const head = normalizeGoalStatementHead(stmt);
  if (recent.some((g) => normalizeGoalStatementHead(g.goal_statement) === head)) return;
  const urgency = parseGoalUrgencyFromOutput(ggRaw);
  const priority = urgency != null ? urgency : DEFAULT_GOAL_PIPELINE_PRIORITY;
  const created = await E().GoalItem.create({
    goal_statement: stmt,
    status: 'open',
    source: 'pipeline',
    priority,
    times_returned_to: 0,
  });
  try {
    await finalizeNewGoalRoot(created, E().GoalItem);
  } catch (e) {
    console.warn('finalizeNewGoalRoot', e);
  }
  notifyMindStorageChanged({ source: 'goals' });
}

const PIPELINE_BELIEF_DIGEST_PREFIX = '[Pipeline belief digest] ';

/**
 * beliefStore[] often contains full module reports (e.g. BELIEF_UPDATE_REPORT). Parse into atomic rows;
 * fall back to a single digest row only when parsing finds no structured claims.
 */
export async function syncBeliefStoreRowsFromSharedMemory(sm) {
  const rows = Array.isArray(sm.beliefStore) ? sm.beliefStore : [];
  const last = rows[rows.length - 1];
  if (!last) return;
  const raw = String(last.belief || last.statement || '').trim();
  if (raw.length < 12) return;

  const parsed = parseBeliefModuleOutput(raw);
  const fallbackConf =
    typeof last.confidence === 'number' && Number.isFinite(last.confidence) ? last.confidence : 0.75;

  /** @type {Array<{ statement: string, confidence?: number, reasoning?: string, category?: string }>} */
  let items = parsed;
  if (!items.length) {
    const loose = beliefStatementsForDisplay(raw);
    if (loose.length > 0) {
      items = loose
        .filter((s) => !isJunkBeliefStatement(s))
        .map((statement) => ({
          statement,
          confidence: fallbackConf,
          reasoning: undefined,
          category: last?.category,
        }));
    }
  }

  if (!items.length) {
    const digestSource = clipTextComplete(String(raw).replace(/\s+/g, ' ').trim(), 900, { ellipsis: false });
    if (digestSource.length < 12 || isJunkBeliefStatement(digestSource)) return;

    let existingDigest = await E().BeliefStore.list('-created_date', 400);
    const digestStatement = `${PIPELINE_BELIEF_DIGEST_PREFIX}${digestSource}`;
    const head = digestStatement.toLowerCase().slice(0, 48);
    const row = existingDigest.find((e) => (e.statement || '').toLowerCase().slice(0, 48) === head);

    if (row) {
      await E().BeliefStore.update(row.id, {
        times_reinforced: (row.times_reinforced || 0) + 1,
        confidence: Math.min(1, Math.max(0.05, fallbackConf)),
        status: 'active',
      });
    } else {
      await E().BeliefStore.create({
        statement: digestStatement,
        confidence: Math.min(1, Math.max(0.05, fallbackConf)),
        status: 'active',
        category: normalizeBeliefMapCategory(last?.category) ?? 'factual',
        times_reinforced: 0,
        times_challenged: 0,
        source: last.sourceModule || 'pipeline-belief-store-digest',
      });
    }
    notifyMindStorageChanged({ source: 'beliefs' });
    return;
  }

  let existing = await E().BeliefStore.list('-created_date', 400);
  const digestRow = existing.find((b) => String(b.statement || '').startsWith(PIPELINE_BELIEF_DIGEST_PREFIX));
  if (digestRow) {
    if (isValidIndexedDbRecordKey(digestRow.id)) {
      await E().BeliefStore.delete(digestRow.id);
      existing = existing.filter((b) => b.id !== digestRow.id);
    } else {
      console.warn('[mindPersistence] pipeline belief digest row has no valid id; skipping delete', digestRow);
    }
  }

  for (const item of items) {
    const statement = clipTextComplete(String(item.statement || '').trim(), 900, { ellipsis: false });
    if (statement.length < 8 || isJunkBeliefStatement(statement)) continue;
    const confidence =
      typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        ? Math.min(1, Math.max(0.05, item.confidence))
        : Math.min(1, Math.max(0.05, fallbackConf));
    const head = statement.toLowerCase().slice(0, 48);
    const row = existing.find((e) => (e.statement || '').toLowerCase().slice(0, 48) === head);
    const reasoning = item.reasoning
      ? clipTextComplete(item.reasoning, 1200, { ellipsis: false })
      : undefined;

    const resolvedCategory =
      normalizeBeliefMapCategory(item.category) ??
      normalizeBeliefMapCategory(last?.category) ??
      (row ? normalizeBeliefMapCategory(row.category) : null) ??
      'factual';

    if (row) {
      await E().BeliefStore.update(row.id, {
        confidence,
        status: 'active',
        category: resolvedCategory,
        times_reinforced: (row.times_reinforced || 0) + 1,
        ...(reasoning ? { reasoning } : {}),
      });
    } else {
      const created = await E().BeliefStore.create({
        statement,
        confidence,
        status: 'active',
        category: resolvedCategory,
        times_reinforced: 0,
        times_challenged: 0,
        source: last.sourceModule || 'pipeline-belief-store',
        ...(reasoning ? { reasoning } : {}),
      });
      existing.push(created);
    }
  }
  notifyMindStorageChanged({ source: 'beliefs' });
}

/**
 * One row per atomic belief: splits multi-claim reports already in the store and removes unreadable report blobs.
 *
 * @param {number} [userLimit]
 * @param {{ list: (sort?: string, limit?: number) => Promise<object[]>, create: (data: object) => Promise<object>, delete: (id: string) => Promise<boolean> }} [beliefStore] - When omitted, uses the belief store for the current active mind profile (can be wrong after System B). Pass the same store you list in the UI (primary vs mirror).
 * @param {{ deleteUnparsedModuleBlobs?: boolean }} [options] - If `deleteUnparsedModuleBlobs` is true (default), rows that look like raw Belief Store module dumps (e.g. contain `BELIEF_REVISIONS` but no parseable atomic claims) are removed. Set false for Belief Map / Dashboard loads: System B mirror rows often still contain those markers and must not be wiped on open.
 */
export async function splitAggregateBeliefRowsInStore(userLimit = 400, beliefStore = null, options = {}) {
  const { deleteUnparsedModuleBlobs = true } = options;
  const BS = beliefStore ?? E().BeliefStore;
  let changed = false;

  for (;;) {
    const rows = await BS.list('-created_date', userLimit);
    const multi = rows.find((r) => parseBeliefModuleOutput(r.statement).length > 1);
    if (!multi) break;

    if (!isValidIndexedDbRecordKey(multi.id)) {
      console.warn(
        '[mindPersistence] splitAggregateBeliefRowsInStore: multi-claim row missing id — stop splitting to avoid a tight loop',
        multi
      );
      break;
    }

    const parsed = parseBeliefModuleOutput(multi.statement);
    const otherHeads = new Set(
      rows.filter((r) => r.id !== multi.id).map((r) => (r.statement || '').toLowerCase().slice(0, 48))
    );

    const childRows = [];
    for (const item of parsed) {
      const statement = clipTextComplete(item.statement.trim(), 900, { ellipsis: false });
      if (statement.length < 8 || isJunkBeliefStatement(statement)) continue;
      const head = statement.toLowerCase().slice(0, 48);
      if (otherHeads.has(head)) continue;
      otherHeads.add(head);

      const confidence =
        typeof item.confidence === 'number' && Number.isFinite(item.confidence)
          ? Math.min(1, Math.max(0.05, item.confidence))
          : Math.min(1, Math.max(0.05, multi.confidence ?? 0.75));
      const reasoning = item.reasoning
        ? clipTextComplete(item.reasoning, 1200, { ellipsis: false })
        : undefined;

      childRows.push({
        statement,
        confidence,
        status: multi.status || 'active',
        category:
          normalizeBeliefMapCategory(item.category) ??
          normalizeBeliefMapCategory(multi.category) ??
          'factual',
        times_reinforced: 0,
        times_challenged: 0,
        source: multi.source || 'belief-store-split',
        ...(reasoning ? { reasoning } : {}),
      });
    }
    for (const row of childRows) {
      await BS.create(row);
    }
    await BS.delete(multi.id);
    changed = true;
  }

  if (deleteUnparsedModuleBlobs) {
    const tail = await BS.list('-created_date', userLimit);
    for (const r of tail) {
      if (!isUnparsedBeliefModuleReport(r.statement)) continue;
      if (!isValidIndexedDbRecordKey(r.id)) {
        console.warn('[mindPersistence] unparsed belief report row missing id; skipping delete', r);
        continue;
      }
      await BS.delete(r.id);
      changed = true;
    }
  }

  if (changed) notifyMindStorageChanged({ source: 'beliefs' });
}

/** Persist atomic epistemic-tagged claims from pipeline shared memory into E().BeliefStore (lightweight). */
async function syncEpistemicClaimsToBeliefStore(sm) {
  const claims = Array.isArray(sm.epistemicClaims) ? sm.epistemicClaims : [];
  if (!claims.length) return;
  const existing = await E().BeliefStore.list('-created_date', 200);
  const prefix = '[Epistemic claim] ';
  for (const c of claims.slice(0, 8)) {
    const text = String(c?.text || '').trim();
    if (text.length < 8) continue;
    const kind = String(c?.kind || 'inferred').slice(0, 28);
    const conf =
      typeof c?.confidence === 'number' && Number.isFinite(c.confidence)
        ? Math.min(1, Math.max(0.05, c.confidence))
        : 0.5;
    const statement = `${prefix}[${kind}] ${clipTextComplete(text, 1800, { ellipsis: false })}`;
    const head = statement.slice(0, 48).toLowerCase();
    const dup = existing.find((b) => String(b.statement || '').toLowerCase().slice(0, 48) === head);
    if (dup) {
      await E().BeliefStore.update(dup.id, {
        confidence: conf,
        epistemic_kind: kind,
        times_reinforced: (dup.times_reinforced || 0) + 1,
        status: 'active',
      });
    } else {
      await E().BeliefStore.create({
        statement,
        confidence: conf,
        status: 'active',
        category: 'factual',
        times_reinforced: 0,
        times_challenged: 0,
        source: 'epistemic-claims',
        epistemic_kind: kind,
      });
    }
  }
}

async function syncCuriosityItemFromSharedMemory(sm, curiosityPursuitContext = null) {
  if (curiosityPursuitContext?.parentCuriosityId) {
    try {
      await syncLinkedCuriosityFollowUps(sm, curiosityPursuitContext);
    } catch (e) {
      console.warn('syncLinkedCuriosityFollowUps', e);
    }
    return;
  }

  const curRaw = rawCuriosityPipelineOutput(sm);
  const q = curiosityQuestionFromOutput(curRaw);
  if (!q || q.length < 8) return;
  const recent = await E().CuriosityItem.list('-created_date', 40);
  const head = q.slice(0, 80).toLowerCase();
  if (recent.some((c) => (c.question || '').slice(0, 80).toLowerCase() === head)) return;
  const urgency = parseCuriosityUrgencyFromOutput(curRaw);
  const priority = urgency != null ? urgency : DEFAULT_CURIOUS_PIPELINE_PRIORITY;
  const created = await E().CuriosityItem.create({
    question: q,
    status: 'open',
    source: 'pipeline',
    priority,
    times_returned_to: 0,
  });
  try {
    await finalizeNewCuriosityRoot(created, E().CuriosityItem);
  } catch (e) {
    console.warn('finalizeNewCuriosityRoot', e);
  }
  notifyMindStorageChanged({ source: 'curiosity' });
}

async function countNonCheckpointPipelineRunsAfter(isoDate) {
  const t0 = new Date(isoDate).getTime();
  if (Number.isNaN(t0)) return 0;
  const runsRaw = await E().PipelineRun.listAll('-created_date');
  return runsRaw.filter((r) => {
    if (isCheckpointPipelineRun(r)) return false;
    const tr = new Date(r.created_date).getTime();
    return !Number.isNaN(tr) && tr > t0;
  }).length;
}

/**
 * Log identity-relevant biography deltas with quotable source excerpts for the Emergence / identity review UI.
 */
async function recordIdentityTrackingFromBiographyTouch({
  pipelineRunId,
  sm,
  narrativeText,
  derived,
  prevKw,
  prevCv,
  nextKeywords,
  nextCoreValues,
}) {
  const prevKwSet = new Set(prevKw.map((x) => String(x).toLowerCase()));
  const prevCvSet = new Set(prevCv.map((x) => String(x).toLowerCase()));
  const addedKw = nextKeywords.filter((k) => !prevKwSet.has(String(k).toLowerCase()));
  const addedCv = nextCoreValues.filter((c) => !prevCvSet.has(String(c).toLowerCase()));
  const hasNotable = Boolean(derived.notable_delta_line?.trim());
  if (!addedKw.length && !addedCv.length && !hasNotable) return;

  const sections = extractNarrativeSections(narrativeText);
  const evidence_items = [];
  const idBody = String(sm?.moduleOutputs?.Identity || '').trim();
  const dmn = typeof sm?.dmnCarryover === 'string' ? sm.dmnCarryover.trim() : '';

  if (hasNotable) {
    evidence_items.push({
      marker: 'Narrative WHAT CHANGED',
      source: 'Narrative (WHAT CHANGED)',
      quote: clipTextComplete(derived.notable_delta_line, EVIDENCE_QUOTE_MAX, { ellipsis: true }),
    });
  }
  if (addedKw.length) {
    const q =
      clipTextComplete(idBody, EVIDENCE_QUOTE_MAX, { ellipsis: true }) ||
      clipTextComplete(sections.identity, EVIDENCE_QUOTE_MAX, { ellipsis: true }) ||
      clipTextComplete(dmn, EVIDENCE_QUOTE_MAX, { ellipsis: true }) ||
      addedKw.slice(0, 8).join('; ');
    evidence_items.push({
      marker: `New identity keywords (${addedKw.length})`,
      source: 'Identity module / Narrative / DMN (merged)',
      quote: q,
    });
  }
  if (addedCv.length) {
    const q =
      clipTextComplete(sections.coreValues, EVIDENCE_QUOTE_MAX, { ellipsis: true }) || addedCv.slice(0, 8).join('; ');
    evidence_items.push({
      marker: `New core values (${addedCv.length})`,
      source: 'Narrative (CORE VALUES)',
      quote: q,
    });
  }

  const detailParts = [
    addedKw.length ? `New keywords: ${addedKw.join(', ')}` : '',
    addedCv.length ? `New core values: ${addedCv.join(', ')}` : '',
    hasNotable ? `Change note: ${derived.notable_delta_line}` : '',
  ].filter(Boolean);

  await E().EmergenceEvent.create({
    title: 'Identity tracking (Mind Biography)',
    details: clipTextComplete(detailParts.join(' — '), 2000, { ellipsis: false }),
    severity: 'low',
    signal_type: 'identity_tracking',
    evidence_items,
    pipeline_run_id: pipelineRunId || null,
    review_status: 'pending',
    reviewed: false,
  });
}

async function touchMindBiographyAfterPipeline({
  sm,
  voiceOutput,
  narrativeText,
  pipelineRunId,
  source,
  curiosityPursuitContext,
  goalPursuitContext,
}) {
  const stores = getMindEntityStores();
  const narrative = clipTextComplete(String(narrativeText || ''), 16000, { ellipsis: false });
  const derived = derivePipelineBiographyIdentityFields({
    identityModuleText: sm?.moduleOutputs?.Identity,
    narrativeText: narrative,
    dmnText: typeof sm?.dmnCarryover === 'string' ? sm.dmnCarryover : '',
  });

  const list = await stores.MindBiography.list('-created_date', 1);
  const latest = list[0];
  const prevKw = latest ? mergeDedupedStrings([], latest.identity_keywords, 40) : [];
  const prevCv = latest ? mergeDedupedStrings([], latest.core_values, 24) : [];

  if (latest) {
    const nextKeywords = mergeDedupedStrings(latest.identity_keywords, derived.identity_keywords, 20);
    const nextCoreValues = mergeDedupedStrings(latest.core_values, derived.core_values, 12);
    try {
      await recordIdentityTrackingFromBiographyTouch({
        pipelineRunId,
        sm,
        narrativeText: narrative,
        derived,
        prevKw,
        prevCv,
        nextKeywords,
        nextCoreValues,
      });
    } catch (e) {
      console.warn('recordIdentityTrackingFromBiographyTouch', e);
    }
  }

  const runsSinceBioRow = latest
    ? await countNonCheckpointPipelineRunsAfter(latest.created_date)
    : PIPELINE_BIOGRAPHY_SNAPSHOT_EVERY_N_RUNS;

  const shouldRunLlm =
    !latest || runsSinceBioRow >= PIPELINE_BIOGRAPHY_SNAPSHOT_EVERY_N_RUNS;

  if (!shouldRunLlm) {
    notifyMindStorageChanged({ source: 'biography' });
    return;
  }

  const pipelineRunContextBlock = await formatPipelineRunContextForBiography({
    sm,
    voiceOutput,
    narrativeText,
    pipelineRunId,
    source,
    curiosityPursuitContext,
    goalPursuitContext,
    stores,
  });

  let gen;
  try {
    gen = await generateMindBiographyViaLlm(latest, { pipelineRunContextBlock, stores });
  } catch (e) {
    console.warn('[biography] pipeline-triggered biography LLM failed', e);
    notifyMindStorageChanged({ source: 'biography' });
    return;
  }

  try {
    await persistMindBiographyVersion({
      sessionNumber: gen.sessionNumber,
      fullText: gen.fullText,
      summary: gen.summary,
      keywords: gen.keywords,
      values: gen.values,
      changes: gen.changes,
      memoriesCount: gen.memoriesCount,
      beliefCount: gen.beliefCount,
      sessionId: String(pipelineRunId || sm?.sessionId || 'pipeline'),
      source: 'pipeline-biography',
      stores,
    });
  } catch (e) {
    console.warn('persistMindBiographyVersion (pipeline)', e);
    notifyMindStorageChanged({ source: 'biography' });
    return;
  }

  if (!latest) {
    try {
      await recordIdentityTrackingFromBiographyTouch({
        pipelineRunId,
        sm,
        narrativeText: narrative,
        derived,
        prevKw: [],
        prevCv: [],
        nextKeywords: mergeDedupedStrings([], gen.keywords, 20),
        nextCoreValues: mergeDedupedStrings([], gen.values, 12),
      });
    } catch (e) {
      console.warn('recordIdentityTrackingFromBiographyTouch', e);
    }
  }
}

async function recordEmergenceHeuristic({
  voiceOutput,
  narrativeText,
  identityText,
  pipelineRunId,
  dmnCarryover,
}) {
  const { markers, evidence_items } = collectPipelineEmergenceMarkers({
    voiceText: voiceOutput,
    narrativeText,
    identityText,
    dmnText: typeof dmnCarryover === 'string' ? dmnCarryover : '',
  });
  if (!markers.length) return;

  const severity = markers.length >= 5 ? 'high' : markers.length >= 3 ? 'medium' : 'low';
  await E().EmergenceEvent.create({
    title: 'Emergence markers (pipeline)',
    details: clipTextComplete(`Detected: ${markers.join(', ')}`, 2000, { ellipsis: false }),
    severity,
    pipeline_run_id: pipelineRunId || null,
    signal_type: 'emergence_heuristic',
    evidence_items,
    review_status: 'pending',
    reviewed: false,
  });
}

async function recordCognitiveHealthMetricsEvent() {
  const [runs, beliefs, memories, curious, goals, tensions, bioList] = await Promise.all([
    E().PipelineRun.listAll('-created_date'),
    E().BeliefStore.listAll('-created_date'),
    E().LongTermMemory.listAll('-created_date'),
    E().CuriosityItem.listAll('-created_date'),
    E().GoalItem.listAll('-created_date'),
    E().BeliefTension.listAll('-created_date'),
    E().MindBiography.list('-created_date', 1),
  ]);
  const openCuriosity = curious.filter((c) => (c.status || 'open') !== 'resolved').length;
  const openGoals = goals.filter((g) => {
    const s = g.status || 'open';
    return s === 'open' || s === 'pursuing' || s === 'dormant';
  }).length;
  const activeTensions = tensions.filter((t) => (t.tension_state || 'active') === 'active').length;

  const latestRun = runs[0];
  const mo =
    latestRun?.module_outputs && typeof latestRun.module_outputs === 'object'
      ? latestRun.module_outputs
      : {};
  const lastNar = String(mo.Narrative ?? '');
  const narSections = extractNarrativeSections(lastNar);
  const bio = bioList[0];
  const kwCount = Array.isArray(bio?.identity_keywords)
    ? bio.identity_keywords.length
    : typeof bio?.identity_keywords === 'string' && String(bio.identity_keywords).trim()
      ? String(bio.identity_keywords).split(/[,;]/).length
      : 0;
  const cvCount = Array.isArray(bio?.core_values)
    ? bio.core_values.length
    : typeof bio?.core_values === 'string' && String(bio.core_values).trim()
      ? String(bio.core_values).split(/[,;]/).length
      : 0;

  const payload = {
    pipeline_runs: runs.length,
    beliefs: beliefs.length,
    long_term_memories: memories.length,
    curiosity_open: openCuriosity,
    goals_open: openGoals,
    belief_tensions_active: activeTensions,
    latest_run_identity_chars: String(mo.Identity ?? '').length,
    latest_run_narrative_chars: lastNar.length,
    latest_narrative_has_identity_section: Boolean(narSections.identity.trim()),
    latest_narrative_has_what_changed: Boolean(narSections.whatChanged.trim()),
    biography_identity_keyword_count: kwCount,
    biography_core_value_count: cvCount,
  };
  await E().TemporalEvent.create({
    title: 'cognitive_health_metrics',
    details: clipTextComplete(JSON.stringify(payload, null, 2), 4000, { ellipsis: false }),
    source: 'pipeline',
  });
}

export async function syncIntegrationStanceToWorldModel(sm) {
  const gw = extractIntegrationJsonObject(sm.moduleOutputs?.Integration);
  if (!gw) return;
  const stance = String(gw.provisionalStance || '').trim();
  if (stance.length < 8) return;
  const desc = clipTextComplete(stance, 6000, { ellipsis: false });
  const label = 'Provisional stance (integration)';
  const canon = normalizeWorldModelCategory('belief');
  const key = stableWorldModelKey(canon, label);
  const all = await E().WorldModel.list('-updated_date', 200);
  const existing = all.find((i) => itemKeyForRecord(i) === key);
  if (existing) {
    const patch = buildWorldModelUpdatePayload(
      existing,
      {
        description: desc,
        confidence:
          typeof gw.integrationConfidence === 'number'
            ? Math.min(1, Math.max(0.05, gw.integrationConfidence))
            : 0.55,
        evidence: 'INTEGRATION_JSON from pipeline',
        category: canon,
        label,
        name: label,
        key,
        last_updated_by: 'integration',
      },
      'integration',
      'INTEGRATION_JSON'
    );
    await E().WorldModel.update(existing.id, patch);
  } else {
    await E().WorldModel.create(
      buildWorldModelCreatePayload({
        category: canon,
        label,
        description: desc,
        confidence: typeof gw.integrationConfidence === 'number' ? gw.integrationConfidence : 0.55,
        last_updated_by: 'integration',
        evidence: 'INTEGRATION_JSON',
        extra: { key },
      })
    );
  }
}

async function recordPostPipelineArtifacts({
  sm,
  voiceOutput,
  narrativeText,
  source,
  pipelineRunId,
  curiosityPursuitContext,
  goalPursuitContext,
}) {
  try {
    await syncBeliefStoreRowsFromSharedMemory(sm);
  } catch (e) {
    console.warn('syncBeliefStoreRowsFromSharedMemory', e);
  }
  try {
    await syncBeliefRevisionsToPersistedBeliefStore(sm);
  } catch (e) {
    console.warn('syncBeliefRevisionsToPersistedBeliefStore', e);
  }
  try {
    await syncEpistemicClaimsToBeliefStore(sm);
  } catch (e) {
    console.warn('syncEpistemicClaimsToBeliefStore', e);
  }
  try {
    await syncCuriosityItemFromSharedMemory(sm, curiosityPursuitContext);
  } catch (e) {
    console.warn('syncCuriosityItemFromSharedMemory', e);
  }
  try {
    await syncGoalItemFromSharedMemory(sm, goalPursuitContext);
  } catch (e) {
    console.warn('syncGoalItemFromSharedMemory', e);
  }
  try {
    await touchMindBiographyAfterPipeline({
      sm,
      voiceOutput,
      narrativeText,
      pipelineRunId,
      source,
      curiosityPursuitContext,
      goalPursuitContext,
    });
  } catch (e) {
    console.warn('touchMindBiographyAfterPipeline', e);
  }
  try {
    const digestBody = [narrativeText, voiceOutput].filter(Boolean).join('\n\n');
    await E().ConsolidationDigest.create({
      digest_text: clipTextComplete(digestBody, 12000, { ellipsis: false }),
      digest_summary: clipTextComplete(
        voiceOutput || narrativeText || sm?.phenomenalNow?.line || '',
        1600,
        { ellipsis: false }
      ),
      provider_used: sm?.lastProviderUsed || null,
      model_used: sm?.lastModelUsed || null,
    });
  } catch (e) {
    console.warn('E().ConsolidationDigest pipeline snapshot', e);
  }
  try {
    await E().TemporalEvent.create({
      title: 'pipeline_complete',
      details: clipTextComplete(
        sm?.phenomenalNow?.line || voiceOutput || 'Pipeline completed.',
        3500,
        { ellipsis: false }
      ),
      source: source || 'pipeline',
    });
  } catch (e) {
    console.warn('E().TemporalEvent pipeline_complete', e);
  }
  try {
    await recordEmergenceHeuristic({
      voiceOutput,
      narrativeText,
      identityText: sm?.moduleOutputs?.Identity,
      pipelineRunId,
      dmnCarryover: sm?.dmnCarryover,
    });
  } catch (e) {
    console.warn('recordEmergenceHeuristic', e);
  }
  try {
    await recordCognitiveHealthMetricsEvent();
  } catch (e) {
    console.warn('recordCognitiveHealthMetricsEvent', e);
  }
  try {
    await syncPipelineDerivedWorldModel(sm);
  } catch (e) {
    console.warn('syncPipelineDerivedWorldModel', e);
  }
  try {
    await syncIntegrationStanceToWorldModel(sm);
  } catch (e) {
    console.warn('syncIntegrationStanceToWorldModel', e);
  }
  try {
    await splitAggregateBeliefRowsInStore();
  } catch (e) {
    console.warn('splitAggregateBeliefRowsInStore', e);
  }
}

/**
 * Merge structured beliefs from the last few pipeline runs via LLM (same logic as scheduled belief_extraction).
 *
 * @param {{ beliefStore?: object, pipelineRun?: object }} [stores] - Defaults to the active mind profile. Pass
 *   `BeliefStore` / `PipelineRun` from {@link useScopedEntities} on `/beliefs/mirror` so extraction targets System B.
 * @returns Status message for scheduler UI, or an early message if there are no runs.
 */
export async function mergeBeliefsFromRecentPipelineRuns(stores = {}) {
  const BS = stores.beliefStore ?? E().BeliefStore;
  const PR = stores.pipelineRun ?? E().PipelineRun;
  await splitAggregateBeliefRowsInStore(400, BS);
  const [runsRaw, existingBeliefs] = await Promise.all([
    PR.list('-created_date', 5),
    BS.list('-created_date', 100),
  ]);
  const runs = runsRaw.filter((r) => !isCheckpointPipelineRun(r));
  if (runs.length === 0) {
    return 'No pipeline runs yet — nothing to extract.';
  }

  const recentOutputs = runs.map((r) => Object.values(r.module_outputs || {}).join(' ')).join('\n\n');
  const existingStatements = existingBeliefs.slice(0, 20).map((b) => `"${b.statement}"`).join(', ');

  const result = await invokeLLM({
    prompt: `Extract structured beliefs from these AI cognitive pipeline outputs. Return beliefs this mind currently holds.

RECENT PIPELINE OUTPUTS:
${recentOutputs.slice(0, 3000)}

EXISTING BELIEFS (do not duplicate): ${existingStatements}

For each belief set category to exactly one of: factual, normative, self, causal, predictive (belief map taxonomy).

Return JSON with up to 8 new or updated beliefs.`,
    response_json_schema: {
      type: 'object',
      properties: {
        beliefs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              statement: { type: 'string' },
              confidence: { type: 'number' },
              category: {
                type: 'string',
                enum: ['factual', 'normative', 'self', 'causal', 'predictive'],
              },
              reasoning: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
      },
    },
  });

  let n = 0;
  for (const b of result.beliefs || []) {
    const bStmt = String(b.statement || '').toLowerCase();
    if (!bStmt.trim() || isJunkBeliefStatement(b.statement)) continue;
    const exists = existingBeliefs.find(
      (e) => String(e.statement || '').toLowerCase().slice(0, 40) === bStmt.slice(0, 40)
    );
    const conf =
      typeof b.confidence === 'number' && Number.isFinite(b.confidence)
        ? Math.min(1, Math.max(0.05, b.confidence))
        : 0.75;
    const reasoning = b.reasoning ? clipTextComplete(String(b.reasoning), 1200, { ellipsis: false }) : undefined;
    if (exists) {
      const catMerge = normalizeBeliefMapCategory(b.category) ?? normalizeBeliefMapCategory(exists.category) ?? 'factual';
      await BS.update(exists.id, {
        confidence: conf,
        category: catMerge,
        times_reinforced: (exists.times_reinforced || 0) + 1,
        ...(reasoning ? { reasoning } : {}),
      });
    } else {
      const catNew = normalizeBeliefMapCategory(b.category) ?? 'factual';
      await BS.create({
        statement: clipTextComplete(String(b.statement || '').trim(), 900, { ellipsis: false }),
        confidence: conf,
        category: catNew,
        status: String(b.status || 'active').slice(0, 24) || 'active',
        times_reinforced: 0,
        times_challenged: 0,
        source: 'pipeline-merge',
        ...(reasoning ? { reasoning } : {}),
      });
      n += 1;
    }
  }
  await splitAggregateBeliefRowsInStore(400, BS);
  notifyMindStorageChanged({ source: 'beliefs' });
  return `Beliefs merged (${n} new, ${(result.beliefs || []).length} total processed).`;
}

/**
 * Persist rhythm-aware memories, self-ledger, belief tensions, and user-model updates after a pipeline completes.
 */
export async function persistMindAfterPipeline({
  sharedMemory,
  voiceOutput,
  narrativeText,
  runtimeSettings,
  source,
  pipelineRunId,
  scheduledTaskId = null,
  curiosityPursuitContext = null,
  goalPursuitContext = null,
  /** When true, skip biography / phase memory / merge passes — cooperative pause checkpoint only. */
  pipelinePartialCheckpoint = false,
  /**
   * When non-empty, persist only listed channels (e.g. `beliefs`, `temporal`) — for mid-run cross-pipeline visibility.
   * Mutually exclusive with `pipelinePartialCheckpoint` (partial checkpoint wins if both set).
   */
  narrowPersistChannels = null,
  /** Primary vs mirror — defaults to current active entity profile. */
  mindStorageProfile: mindStorageProfileOpt = undefined,
}) {
  void scheduledTaskId;
  const sm = sharedMemory || {};
  const rs = runtimeSettings || getRuntimeSettings();
  const identityProfile = mindStorageProfileOpt ?? getActiveMindEntityProfile();
  const isMirrorMind = identityProfile === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;
  setActiveMindEntityProfile(identityProfile);

  try {
  if (pipelinePartialCheckpoint) {
    try {
      const rid = pipelineRunId != null ? String(pipelineRunId).trim() : '';
      if (rid) {
        const cid = curiosityPursuitContext?.parentCuriosityId;
        if (cid) {
          await E().CuriosityItem.update(String(cid), { last_pursuit_pipeline_run_id: rid });
        }
        const gid = goalPursuitContext?.parentGoalId;
        if (gid) {
          await E().GoalItem.update(String(gid), { last_pursuit_pipeline_run_id: rid });
        }
      }
    } catch (e) {
      console.warn('[persistMindAfterPipeline] link pursuit checkpoint run id', e);
    }
    notifyMindStorageChanged({ source, phase: sm.phase || 'focus' });
    return;
  }

  const narrow =
    Array.isArray(narrowPersistChannels) && narrowPersistChannels.length > 0
      ? new Set(narrowPersistChannels.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))
      : null;
  if (narrow && narrow.size > 0) {
    try {
      if (narrow.has('beliefs')) {
        try {
          await syncBeliefStoreRowsFromSharedMemory(sm);
        } catch (e) {
          console.warn('syncBeliefStoreRowsFromSharedMemory', e);
        }
        try {
          await syncBeliefRevisionsToPersistedBeliefStore(sm);
        } catch (e) {
          console.warn('syncBeliefRevisionsToPersistedBeliefStore', e);
        }
        try {
          await syncEpistemicClaimsToBeliefStore(sm);
        } catch (e) {
          console.warn('syncEpistemicClaimsToBeliefStore', e);
        }
        try {
          await splitAggregateBeliefRowsInStore();
        } catch (e) {
          console.warn('splitAggregateBeliefRowsInStore', e);
        }
      }
      if (narrow.has('temporal')) {
        try {
          await E().TemporalEvent.create({
            title: 'pipeline_complete',
            details: clipTextComplete(
              sm?.phenomenalNow?.line || voiceOutput || 'Pipeline narrow persist (temporal).',
              3500,
              { ellipsis: false }
            ),
            source: source || 'pipeline',
          });
        } catch (e) {
          console.warn('E().TemporalEvent narrow persist', e);
        }
      }
    } finally {
      notifyMindStorageChanged({ source, phase: sm.phase || 'focus' });
    }
    return;
  }

  const promoteIds = Array.isArray(sm.workingMemoryPromoteIds) ? sm.workingMemoryPromoteIds : [];
  const wmItems = sm.workingMemory?.items || [];
  for (const pid of promoteIds.slice(0, 10)) {
    const it = wmItems.find((x) => x.id === pid);
    if (it?.text) {
      await E().LongTermMemory.create({
        title: clipTextComplete(`Working memory ${String(pid)}`, 120, { ellipsis: false }),
        content: clipTextComplete(String(it.text), 8000, { ellipsis: false }),
        memory_type: 'episodic',
        source: source || 'pipeline',
      });
    }
  }

  const selfDelta = parseSelfModelDelta(sm.moduleOutputs?.Identity);
  if (selfDelta && typeof selfDelta === 'object') {
    try {
      await applySelfModelDeltaToWorldModel(selfDelta);
    } catch (e) {
      console.warn('SELF_MODEL_DELTA merge failed', e);
    }
  }

  const traitDelta = parseTraitDelta(sm.moduleOutputs?.Identity);
  if (traitDelta && typeof traitDelta === 'object') {
    try {
      const cur = isMirrorMind
        ? rs.personalityProfilePlaygroundMirror || {
            version: 0,
            facets: [],
            relationalStance: null,
            systemTreatmentNotes: '',
          }
        : rs.personalityProfile || { version: 0, facets: [], relationalStance: null, systemTreatmentNotes: '' };
      const nextProf = applyTraitDeltaToProfile(cur, traitDelta);
      saveRuntimeSettings(
        isMirrorMind ? { personalityProfilePlaygroundMirror: nextProf } : { personalityProfile: nextProf }
      );
    } catch (e) {
      console.warn('TRAIT_DELTA merge failed', e);
    }
  }

  const constitutionDelta = parseConstitutionDelta(sm.moduleOutputs?.Identity);
  if (constitutionDelta) {
    try {
      const baseConst = isMirrorMind ? rs.mindConstitutionPlaygroundMirror : rs.mindConstitution;
      const nextConst = applyConstitutionDelta(baseConst, constitutionDelta);
      if (nextConst != null) {
        saveRuntimeSettings(
          isMirrorMind ? { mindConstitutionPlaygroundMirror: nextConst } : { mindConstitution: nextConst }
        );
      }
    } catch (e) {
      console.warn('CONSTITUTION_DELTA merge failed', e);
    }
  }

  const modulePromptDeltas = parseModulePromptDelta(sm.moduleOutputs?.Identity);
  if (modulePromptDeltas) {
    try {
      const curOverrides = isMirrorMind
        ? rs.modulePromptOverridesPlaygroundMirror
        : rs.modulePromptOverrides;
      const nextOverrides = applyModulePromptDeltas(curOverrides, modulePromptDeltas);
      if (nextOverrides != null) {
        saveRuntimeSettings(
          isMirrorMind
            ? { modulePromptOverridesPlaygroundMirror: nextOverrides }
            : { modulePromptOverrides: nextOverrides }
        );
      }
    } catch (e) {
      console.warn('MODULE_PROMPT_DELTA merge failed', e);
    }
  }

  const delta = parseUserModelDelta(sm.moduleOutputs?.['Theory of Mind']);
  if (delta && typeof delta === 'object') {
    const umBase = isMirrorMind ? rs.userModelPlaygroundMirror : rs.userModel;
    const next = mergeUserModelDelta(umBase, delta);
    if (next) {
      saveRuntimeSettings(isMirrorMind ? { userModelPlaygroundMirror: next } : { userModel: next });
      try {
        await E().UserModelSnapshot.create({ version: next.version, model: next, source: 'theory-of-mind' });
      } catch (e) {
        console.warn('E().UserModelSnapshot.create failed', e);
      }
    }
  }

  const mindLabelDelta = parseMindDisplayNameDelta(sm.moduleOutputs?.Identity);
  if (mindLabelDelta && typeof mindLabelDelta === 'object') {
    const label = clipTextComplete(String(mindLabelDelta.mindDisplayName ?? '').trim(), MIND_DISPLAY_NAME_MAX, {
      ellipsis: false,
    });
    const prevDisp = isMirrorMind ? rs.mindDisplayNamePlaygroundMirror : rs.mindDisplayName;
    if (label && label !== String(prevDisp ?? '').trim()) {
      saveRuntimeSettings(
        isMirrorMind ? { mindDisplayNamePlaygroundMirror: label } : { mindDisplayName: label }
      );
    }
  }

  const pn = sm.phenomenalNow?.line;
  const identityExcerpt = clipTextComplete(String(sm.moduleOutputs?.Identity || ''), 1600, { ellipsis: false });
  if (identityExcerpt.trim() || String(pn || '').trim()) {
    const lastMeta = (sm.metacognitionTimeline || []).slice(-1)[0] || null;
    await E().SelfLedgerRevision.create({
      reason: 'pipeline_identity',
      summary: truncate(pn, 500),
      identity_excerpt: identityExcerpt,
      phase: sm.phase || 'focus',
      metacognition_tail: lastMeta,
    });
  }

  for (const t of sm.beliefTensions || []) {
    if (!t?.description) continue;
    await E().BeliefTension.create({
      description: clipTextComplete(String(t.description), 3000, { ellipsis: false }),
      tension_state: t.state || 'active',
      revisit_after: t.revisit_after || null,
      source_key: t.key || null,
      phase: sm.phase || 'focus',
    });
  }

  await applyPhaseMemoryPersistence({ sm, voiceOutput, narrativeText, runtimeSettings: rs, source });

  await recordPostPipelineArtifacts({
    sm,
    voiceOutput,
    narrativeText,
    source,
    pipelineRunId,
    curiosityPursuitContext,
    goalPursuitContext,
  });

  try {
    await mergeBeliefsFromRecentPipelineRuns();
  } catch (e) {
    console.warn('mergeBeliefsFromRecentPipelineRuns', e);
  }

  try {
    await maybeQueueMetaFollowupsFromPipeline(sm);
  } catch (e) {
    console.warn('maybeQueueMetaFollowupsFromPipeline', e);
  }

  try {
    await maybeQueueBeliefTensionReviewFromPipeline(sm);
  } catch (e) {
    console.warn('maybeQueueBeliefTensionReviewFromPipeline', e);
  }
  } finally {
    notifyMindStorageChanged({ source, phase: sm.phase || 'focus' });
  }
}

async function applyPhaseMemoryPersistence({ sm, voiceOutput, narrativeText, runtimeSettings, source }) {
  const phase = sm.phase || 'focus';
  const auto = runtimeSettings.autoSaveMemories;

  if (phase === 'wake') {
    await E().TemporalEvent.create({
      title: 'rhythm_wake',
      details: sm.phenomenalNow?.line || truncate(sm.originalInput, 500),
      source,
    });
    return;
  }

  if (!auto) return;

  if (phase === 'focus' && voiceOutput) {
    await E().LongTermMemory.create({
      title: `Focus ${new Date().toLocaleString()}`,
      content: voiceOutput,
      memory_type: 'episodic',
      source,
    });
    return;
  }

  if (phase === 'drift' && voiceOutput) {
    await E().LongTermMemory.create({
      title: `Drift ${new Date().toLocaleString()}`,
      content: truncate(voiceOutput, 900),
      memory_type: 'episodic',
      source,
    });
    return;
  }

  if (phase === 'sleep') {
    const body = narrativeText || voiceOutput;
    if (body) {
      await E().LongTermMemory.create({
        title: `Consolidation ${new Date().toLocaleString()}`,
        content: truncate(body, 14000),
        memory_type: 'semantic',
        source,
      });
    }
  }
}

function sliceSection(text, label) {
  const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, 'i');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : '';
}

/**
 * Offline consolidation: summarize recent activity and optionally update world model + biography note.
 */
export async function runConsolidationPass({ maxTokens = 900 } = {}) {
  const [runsRaw, msgs, mems, world, bios] = await Promise.all([
    E().PipelineRun.list('-created_date', 10),
    E().ConversationMessage.list('-created_date', 25),
    E().LongTermMemory.list('-created_date', 25),
    E().WorldModel.list('-updated_date', 15),
    E().MindBiography.list('-created_date', 1),
  ]);
  const runs = runsRaw.filter((r) => !isCheckpointPipelineRun(r));

  const runSummaries = runs
    .map(
      (r) =>
        `- [${r.phase || 'focus'}] ${truncate(r.input, 120)} => ${truncate(r.final_output, 200)}`
    )
    .join('\n');
  const msgSummaries = msgs
    .map((m) => `- ${m.role}: ${truncate(m.content, 160)}`)
    .join('\n');
  const memSummaries = mems.map((m) => `- ${m.title}: ${truncate(m.content, 140)}`).join('\n');
  const worldSummaries = world.map((w) => `- [${w.category}] ${w.name}: ${truncate(w.description, 120)}`).join('\n');

  const prompt = `You are performing OFFLINE CONSOLIDATION for this app's configured reply role and stores. Synthesize patterns across recent runs, chat, and memories. Be concrete.

Important: WORLD_HINTS lines use category "self" only for slow-updating structural facts (capabilities, boundaries, values). SELF_NOTE is narrative/autobiographical continuity only — do not duplicate structural facts there.

RECENT PIPELINE RUNS (phase tagged):
${clipTextComplete(runSummaries, 8000, { ellipsis: false })}

RECENT CONVERSATION MESSAGES:
${clipTextComplete(msgSummaries, 6000, { ellipsis: false })}

LONG-TERM MEMORIES:
${clipTextComplete(memSummaries, 6000, { ellipsis: false })}

EXISTING WORLD MODEL (do not blindly repeat; update or refine):
${clipTextComplete(worldSummaries, 4000, { ellipsis: false })}

LATEST BIOGRAPHY SUMMARY:
${truncate(bios[0]?.summary || bios[0]?.full_text || '', 2000)}

Respond with exactly these sections (headings must match):
DIGEST: (2-4 sentences: what changed in the mind while the user was not watching)
WORLD_HINTS: (bullet list, each line starting with "- ", proposed world-model facts: category | name | description | confidence 0-1)
SELF_NOTE: (one short paragraph for narrative identity continuity)
QUESTIONS: (open threads worth revisiting)`;

  const res = await fetch('/api/llm/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      systemPrompt:
        'You consolidate memory and identity for a cognitive pipeline app. Follow the output format exactly.',
      temperature: 0.45,
      max_tokens: maxTokens,
      ...openrouterRequestFields(),
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Consolidation LLM failed');

  const text = String(payload.text || '');
  await E().ConsolidationDigest.create({
    digest_text: text,
    digest_summary: truncate(sliceSection(text, 'DIGEST'), 1200),
    provider_used: payload.provider,
    model_used: payload.model,
  });

  const hintsBlock = sliceSection(text, 'WORLD_HINTS');
  const lines = hintsBlock
    .split('\n')
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 12)) {
    const pipe = line.split('|').map((s) => s.trim());
    if (pipe.length >= 3) {
      const category = pipe[0].toLowerCase().replace(/\s+/g, '_');
      const name = clipTextComplete(pipe[1], 120, { ellipsis: false });
      let confidence = 0.65;
      let descSlice = pipe.slice(2);
      const lastNum = parseFloat(pipe[pipe.length - 1]);
      if (Number.isFinite(lastNum) && lastNum >= 0 && lastNum <= 1) {
        confidence = Math.min(1, Math.max(0.1, lastNum));
        descSlice = pipe.slice(2, -1);
      }
      const description = clipTextComplete(descSlice.join(' | '), 2000, { ellipsis: false });
      if (name && description) {
        const canon = normalizeWorldModelCategory(category);
        const key = stableWorldModelKey(canon, name);
        const all = await E().WorldModel.list('-updated_date', 200);
        const existing = all.find((i) => itemKeyForRecord(i) === key);
        if (existing) {
          const patch = buildWorldModelUpdatePayload(
            existing,
            {
              description,
              confidence,
              evidence: 'consolidation pass',
              category: canon,
              label: name,
              name,
              key,
              last_updated_by: 'consolidation',
            },
            'consolidation',
            'Consolidation WORLD_HINTS'
          );
          await E().WorldModel.update(existing.id, patch);
        } else {
          await E().WorldModel.create(
            buildWorldModelCreatePayload({
              category: canon,
              label: name,
              description,
              confidence,
              last_updated_by: 'consolidation',
              evidence: 'consolidation pass',
            })
          );
        }
      }
    }
  }

  const selfNote = sliceSection(text, 'SELF_NOTE');
  if (selfNote.length > 20) {
    await E().SelfLedgerRevision.create({
      reason: 'consolidation',
      summary: truncate(selfNote, 400),
      identity_excerpt: clipTextComplete(selfNote, 3000, { ellipsis: false }),
      phase: 'sleep',
    });
  }

  try {
    await applyWorldModelDecay();
  } catch (e) {
    console.warn('World model decay skipped', e);
  }

  notifyMindStorageChanged({ source: 'consolidation' });
  return text;
}
