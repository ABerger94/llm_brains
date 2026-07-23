/**
 * Selects which IndexedDB entity managers pipeline prep/persist use (primary mind vs playground mirror).
 * Set for the duration of a graph pipeline run via {@link setActiveMindEntityProfile}.
 */
import {
  BeliefStore,
  BeliefTension,
  ConsolidationDigest,
  ConversationMessage,
  CuriosityItem,
  DreamRun,
  EmergenceEvent,
  FeedbackItem,
  GoalItem,
  LongTermMemory,
  MindBiography,
  PipelineRun,
  SelfLedgerRevision,
  TemporalEvent,
  UserModelSnapshot,
  WorldModel,
  MirrorBeliefStore,
  MirrorBeliefTension,
  MirrorConsolidationDigest,
  MirrorConversationMessage,
  MirrorCuriosityItem,
  MirrorDreamRun,
  MirrorEmergenceEvent,
  MirrorFeedbackItem,
  MirrorGoalItem,
  MirrorLongTermMemory,
  MirrorMindBiography,
  MirrorPipelineRun,
  MirrorSelfLedgerRevision,
  MirrorTemporalEvent,
  MirrorUserModelSnapshot,
  MirrorWorldModel,
  MirrorPendingMindUpdate,
  PendingMindUpdate,
} from './data';

export const MIND_STORAGE_PROFILE_PRIMARY = 'primary';
export const MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR = 'playgroundMirror';

const PRIMARY_ENTITY_STORES = {
  BeliefStore,
  BeliefTension,
  ConsolidationDigest,
  ConversationMessage,
  CuriosityItem,
  DreamRun,
  EmergenceEvent,
  FeedbackItem,
  GoalItem,
  LongTermMemory,
  MindBiography,
  PipelineRun,
  SelfLedgerRevision,
  TemporalEvent,
  UserModelSnapshot,
  WorldModel,
  PendingMindUpdate,
};

const MIRROR_ENTITY_STORES = {
  BeliefStore: MirrorBeliefStore,
  BeliefTension: MirrorBeliefTension,
  ConsolidationDigest: MirrorConsolidationDigest,
  ConversationMessage: MirrorConversationMessage,
  CuriosityItem: MirrorCuriosityItem,
  DreamRun: MirrorDreamRun,
  EmergenceEvent: MirrorEmergenceEvent,
  FeedbackItem: MirrorFeedbackItem,
  GoalItem: MirrorGoalItem,
  LongTermMemory: MirrorLongTermMemory,
  MindBiography: MirrorMindBiography,
  PipelineRun: MirrorPipelineRun,
  SelfLedgerRevision: MirrorSelfLedgerRevision,
  TemporalEvent: MirrorTemporalEvent,
  UserModelSnapshot: MirrorUserModelSnapshot,
  WorldModel: MirrorWorldModel,
  PendingMindUpdate: MirrorPendingMindUpdate,
};

/** @type {string} */
let activeProfile = MIND_STORAGE_PROFILE_PRIMARY;

/**
 * Normalize persisted scheduler / task option to a valid profile string.
 * @param {unknown} value
 * @returns {typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR}
 */
export function normalizeScheduledTaskMindStorageProfile(value) {
  const s = String(value ?? '').trim();
  if (s === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR) return MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;
  return MIND_STORAGE_PROFILE_PRIMARY;
}

/**
 * Entity stores for a profile without mutating {@link activeProfile} (safe when global profile may lag the run).
 * @param {unknown} profile - {@link MIND_STORAGE_PROFILE_PRIMARY} | {@link MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR} | scheduler string
 * @returns {typeof PRIMARY_ENTITY_STORES}
 */
export function getMindEntityStoresForProfile(profile) {
  const p = normalizeScheduledTaskMindStorageProfile(profile);
  return p === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR ? MIRROR_ENTITY_STORES : PRIMARY_ENTITY_STORES;
}

/**
 * @returns {typeof PRIMARY_ENTITY_STORES}
 */
export function getMindEntityStores() {
  return getMindEntityStoresForProfile(activeProfile);
}

/**
 * @param {string} profile - {@link MIND_STORAGE_PROFILE_PRIMARY} | {@link MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR}
 */
export function setActiveMindEntityProfile(profile) {
  activeProfile = normalizeScheduledTaskMindStorageProfile(profile);
}

export function getActiveMindEntityProfile() {
  return activeProfile;
}
