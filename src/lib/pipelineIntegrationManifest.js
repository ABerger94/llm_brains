/**
 * Cross-pipeline integration manifest: which channels flow from local stores into POST `options`,
 * how they persist after runs, and when other pipelines can observe updates.
 *
 * @readonly
 */
export const PIPELINE_INTEGRATION_CHANNELS = [
  {
    id: 'ltm_digest',
    source: 'indexeddb:LongTermMemory',
    optionsKey: 'persistedLongTermMemories',
    persistPath: 'full persistMindAfterPipeline (LTM promotion, phase memory, recordPostPipelineArtifacts)',
    crossRunVisibility: 'next_prep_after_full_complete; refreshed on continuation legs',
    priorityNote:
      'Persisted rows are canonical snapshots; in-run memory/belief prose reconciles only when explicitly merged.',
    conflictsWith: ['in_run_belief_store', 'workspace_epistemic_threads'],
  },
  {
    id: 'belief_digest',
    source: 'indexeddb:BeliefStore',
    optionsKey: 'persistedBeliefRows',
    persistPath: 'full persist → recordPostPipelineArtifacts belief syncs; mergeBeliefsFromRecentPipelineRuns',
    crossRunVisibility: 'next_prep_after_full_complete; continuation legs refresh prep slices',
    priorityNote:
      'Persisted BeliefStore rows define listed statements; in-run beliefStore entries are this-turn unless merged into store.',
    conflictsWith: ['in_run_belief_store', 'ltm_digest'],
  },
  {
    id: 'consolidation_digest',
    source: 'indexeddb:ConsolidationDigest',
    optionsKey: 'persistedAffectHistory',
    persistPath: 'full persist → ConsolidationDigest.create in recordPostPipelineArtifacts',
    crossRunVisibility: 'next_prep_after_full_complete',
  },
  {
    id: 'biography_excerpt',
    source: 'indexeddb:MindBiography',
    optionsKey: 'persistedBiographyExcerpt',
    persistPath: 'full persist → touchMindBiographyAfterPipeline',
    crossRunVisibility: 'next_prep_after_full_complete',
  },
  {
    id: 'temporal_timeline',
    source: 'indexeddb:TemporalEvent',
    optionsKey: 'recentTemporalEvents',
    persistPath: 'full persist → TemporalEvent rows (phase + pipeline_complete); narrowPersist temporal',
    crossRunVisibility: 'next_prep; refreshed every SSE continuation leg',
  },
  {
    id: 'dialogue',
    source: 'indexeddb:ConversationMessage',
    optionsKey: 'recentDialogue',
    persistPath: 'written outside pipeline; consumed as prep',
    crossRunVisibility: 'next_prep (per session filter for graph)',
  },
  {
    id: 'structural_self',
    source: 'indexeddb:WorldModel category self',
    optionsKey: 'structuralSelf',
    persistPath: 'full persist → SELF_MODEL_DELTA / world model merges',
    crossRunVisibility: 'next_prep_after_full_complete',
  },
  {
    id: 'world_environment',
    source: 'indexeddb:WorldModel non-self',
    optionsKey: 'persistedWorldEnvironmentRows',
    persistPath: 'full persist → world model + integration stance sync',
    crossRunVisibility: 'next_prep_after_full_complete; refreshed on continuation legs',
    priorityNote: 'Reconcile with structural self and BeliefStore; persisted rows are store-backed.',
    conflictsWith: ['belief_digest', 'structural_self'],
  },
  {
    id: 'curiosity_open',
    source: 'indexeddb:CuriosityItem',
    optionsKey: 'persistedCuriosityRows',
    persistPath: 'full persist → syncCuriosityItemFromSharedMemory',
    crossRunVisibility: 'next_prep_after_full_complete; refreshed on continuation legs',
  },
  {
    id: 'goals_open',
    source: 'indexeddb:GoalItem',
    optionsKey: 'persistedGoalRows',
    persistPath: 'full persist → syncGoalItemFromSharedMemory',
    crossRunVisibility: 'next_prep_after_full_complete; refreshed on continuation legs',
  },
  {
    id: 'runtime_policy',
    source: 'runtimeSettings KV',
    optionsKey: 'constitution, userModel, personalityProfile, modulePromptOverrides, …',
    persistPath: 'Identity / ToM deltas in full persist',
    crossRunVisibility: 'immediate next prep (settings snapshot)',
  },
  {
    id: 'session_shared_memory',
    source: 'prior pipeline SSE sharedMemory',
    optionsKey: '(continuation via slimSharedMemory POST body, not options digest)',
    persistPath: 'N/A',
    crossRunVisibility: 'continuation legs: same run; hydratePriorWorkspaceFromDb server-side',
  },
];
