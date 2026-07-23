import { temporalEventsExcludingPauseNoise } from '../../shared/temporalTimelinePauseFilter.mjs';
import {
  getActiveMindEntityProfile,
  getMindEntityStoresForProfile,
  MIND_STORAGE_PROFILE_PRIMARY,
  normalizeScheduledTaskMindStorageProfile,
} from './mindEntityContext';
import { fetchPersistedMindStoresForPipeline } from './persistedMindStoresForPipeline';
import {
  buildWorkingMemorySeed,
  loadCuriosityRowsForPipeline,
  loadGoalRowsForPipeline,
  loadStructuralSelfForPipeline,
  loadWorldModelEnvironmentForPipeline,
} from './mindPersistence';
import { buildPriorPredictionAuditPayload } from './priorPredictionAudit';
import { loadDmnCarryoverTextForPhase } from './mindDmnContext';
import { effectiveMaxMetacognitionReruns, effectiveMetacognitionRerunDelayMinutes } from './runtimeSettings';
import { openrouterPipelineOptions } from './llmClientOptions';
import { getPipelineIdentityRuntimeSlice } from './runtimeSettings';

/**
 * Load persisted-store slices used to refresh cross-pipeline context between SSE legs or after storage events.
 * @param {string} userInput
 * @param {{ mindStorageProfile?: string }} [opts] - when omitted, uses {@link getActiveMindEntityProfile}
 */
export async function fetchPipelineIntegrationPersistedSlices(userInput, opts = {}) {
  const profile =
    opts.mindStorageProfile !== undefined
      ? normalizeScheduledTaskMindStorageProfile(opts.mindStorageProfile)
      : getActiveMindEntityProfile();
  const q = String(userInput || '').trim();
  let recentTemporalEvents = [];
  try {
    recentTemporalEvents = temporalEventsExcludingPauseNoise(
      await getMindEntityStoresForProfile(profile).TemporalEvent.list('-created_date', 24)
    );
  } catch {
    recentTemporalEvents = [];
  }

  const sliceOpts = { mindStorageProfile: profile };
  const [mindStores, structuralSelf, persistedWorldEnvironmentRows, persistedCuriosityRows, persistedGoalRows] =
    await Promise.all([
      fetchPersistedMindStoresForPipeline(q, sliceOpts).catch(() => ({
        persistedLongTermMemories: [],
        persistedBeliefRows: [],
        persistedAffectHistory: [],
        persistedBiographyExcerpt: '',
      })),
      loadStructuralSelfForPipeline({ maxItems: 12, ...sliceOpts }),
      loadWorldModelEnvironmentForPipeline({ maxItems: 14, ...sliceOpts }),
      loadCuriosityRowsForPipeline({ maxItems: 10, ...sliceOpts }),
      loadGoalRowsForPipeline({ maxItems: 8, ...sliceOpts }),
    ]);

  return {
    ...mindStores,
    recentTemporalEvents,
    structuralSelf,
    persistedWorldEnvironmentRows,
    persistedCuriosityRows,
    persistedGoalRows,
  };
}

/**
 * Merge freshly loaded integration slices into an existing pipeline options snapshot (keeps max_tokens, phase flags, etc.).
 * @param {object} baseSnapshot
 * @param {Awaited<ReturnType<typeof fetchPipelineIntegrationPersistedSlices>>} slices
 */
export function mergePersistedSlicesIntoPipelineOptionsSnapshot(baseSnapshot, slices) {
  if (!baseSnapshot || typeof baseSnapshot !== 'object') return baseSnapshot;
  const s = slices || {};
  return {
    ...baseSnapshot,
    ...(Array.isArray(s.persistedLongTermMemories) ? { persistedLongTermMemories: s.persistedLongTermMemories } : {}),
    ...(Array.isArray(s.persistedBeliefRows) ? { persistedBeliefRows: s.persistedBeliefRows } : {}),
    ...(Array.isArray(s.persistedAffectHistory) ? { persistedAffectHistory: s.persistedAffectHistory } : {}),
    ...(typeof s.persistedBiographyExcerpt === 'string'
      ? { persistedBiographyExcerpt: s.persistedBiographyExcerpt }
      : {}),
    ...(Array.isArray(s.recentTemporalEvents) ? { recentTemporalEvents: s.recentTemporalEvents } : {}),
    ...(Array.isArray(s.structuralSelf) ? { structuralSelf: s.structuralSelf } : {}),
    ...(Array.isArray(s.persistedWorldEnvironmentRows)
      ? { persistedWorldEnvironmentRows: s.persistedWorldEnvironmentRows }
      : {}),
    ...(Array.isArray(s.persistedCuriosityRows) ? { persistedCuriosityRows: s.persistedCuriosityRows } : {}),
    ...(Array.isArray(s.persistedGoalRows) ? { persistedGoalRows: s.persistedGoalRows } : {}),
  };
}

/**
 * Build the full `options` object for POST /api/pipeline/stream (shared by graph SSE and scheduled prep).
 *
 * @param {object} p
 * @param {string} p.userInput
 * @param {object} p.runtimeSettings - from getRuntimeSettings()
 * @param {string} p.mindPhase
 * @param {number} p.arousal
 * @param {string} [p.intent]
 * @param {unknown[]} p.recentDialogue
 * @param {object|null} [p.continueMemory] - prior shared memory for priorPredictionAudit
 * @param {{ maxMetacognitionReruns?: number|null, metacognitionRerunDelayMinutes?: number|null }|null} [p.metacognitionOverrides]
 * @param {string} [p.mindStorageProfile] - primary vs playground mirror identity slice
 */
export async function buildPipelineIntegrationOptions({
  userInput,
  runtimeSettings,
  mindPhase,
  arousal,
  intent = '',
  recentDialogue,
  continueMemory = null,
  metacognitionOverrides = null,
  mindStorageProfile = MIND_STORAGE_PROFILE_PRIMARY,
}) {
  const rs = runtimeSettings || {};
  const profileNorm = normalizeScheduledTaskMindStorageProfile(mindStorageProfile);
  const idSlice = getPipelineIdentityRuntimeSlice(rs, profileNorm);
  const maxTokens = Number(rs.pipelineMaxTokens) || 800;
  const mo = metacognitionOverrides && typeof metacognitionOverrides === 'object' ? metacognitionOverrides : {};
  const delayMin = effectiveMetacognitionRerunDelayMinutes(rs, mo.metacognitionRerunDelayMinutes);
  const effMaxReruns = effectiveMaxMetacognitionReruns(rs, mo.maxMetacognitionReruns);

  const promptText = String(userInput || '').trim() || 'Pipeline run.';
  const wmSeed = buildWorkingMemorySeed(promptText, idSlice.pinnedWorkingMemory || []);
  const dmnCarryover = await loadDmnCarryoverTextForPhase(mindPhase, { mindStorageProfile: profileNorm });
  const priorPredictionAudit = buildPriorPredictionAuditPayload(continueMemory, promptText);

  const slices = await fetchPipelineIntegrationPersistedSlices(promptText, { mindStorageProfile: profileNorm });

  const pipelineOptionsSnapshot = {
    max_tokens: maxTokens,
    temperature: 0.55,
    phase: mindPhase,
    arousal,
    intent: String(intent || '').trim(),
    constitution: idSlice.mindConstitution || '',
    userModel: idSlice.userModel || {},
    personalityProfile: idSlice.personalityProfile || {
      version: 0,
      facets: [],
      relationalStance: null,
      systemTreatmentNotes: '',
    },
    modulePromptOverrides: idSlice.modulePromptOverrides || {},
    structuralSelf: slices.structuralSelf,
    workingMemorySeed: wmSeed,
    recentDialogue,
    maxMetacognitionReruns: effMaxReruns,
    metacognitionRerunDelayMinutes: delayMin,
    ...(rs.preserveModuleTrace === true ? { preserveModuleTrace: true } : {}),
    ...(rs.strictGlobalWorkspaceBroadcast === true ? { strictGlobalWorkspaceBroadcast: true } : {}),
    ...(['unified', 'classic'].includes(String(rs?.pipelineProfile || '').trim())
      ? { pipelineProfile: rs.pipelineProfile }
      : {}),
    ...(['off', 'aggressive', 'default'].includes(String(rs?.pipelineGating || '').trim())
      ? { pipelineGating: rs.pipelineGating }
      : {}),
    ...(rs?.forkJoinWave === true ? { forkJoinWave: true } : {}),
    ...(dmnCarryover ? { dmnCarryover } : {}),
    ...(priorPredictionAudit ? { priorPredictionAudit } : {}),
    mindDisplayName: String(idSlice.mindDisplayName || '').trim(),
    recentTemporalEvents: slices.recentTemporalEvents,
    persistedLongTermMemories: slices.persistedLongTermMemories,
    persistedBeliefRows: slices.persistedBeliefRows,
    persistedAffectHistory: slices.persistedAffectHistory,
    persistedBiographyExcerpt: slices.persistedBiographyExcerpt,
    persistedWorldEnvironmentRows: slices.persistedWorldEnvironmentRows,
    persistedCuriosityRows: slices.persistedCuriosityRows,
    persistedGoalRows: slices.persistedGoalRows,
    ...openrouterPipelineOptions(rs),
    incrementalModuleCheckpoint: true,
  };

  return pipelineOptionsSnapshot;
}

/**
 * Log counts for integration bundle (graph execution log / stream).
 * @param {object} snapshot
 * @param {(msg: string, detail?: string) => void} addLog
 */
export function logPipelineIntegrationOptionsLoaded(snapshot, addLog) {
  if (!snapshot || typeof snapshot !== 'object' || typeof addLog !== 'function') return;
  const w = snapshot.persistedWorldEnvironmentRows;
  if (Array.isArray(w) && w.length) addLog(`${w.length} non-self world-model row(s) in server policy bundle.`);
  const c = snapshot.persistedCuriosityRows;
  if (Array.isArray(c) && c.length) addLog(`${c.length} open curiosity item(s) in server policy bundle.`);
  const g = snapshot.persistedGoalRows;
  if (Array.isArray(g) && g.length) addLog(`${g.length} open goal(s) in server policy bundle.`);
}
