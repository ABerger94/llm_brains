import { describeNetworkOrOfflineError } from './apiReachability';
import {
  getRuntimeSettings,
  effectiveMetacognitionRerunDelayMinutes,
  resolveMetacognitionRerunDelayMinutesFromSnapshot,
  runtimeSettingsForPersistence,
} from './runtimeSettings';
import { getExecutionPlan } from './cognitiveModules';
import { consumePipelineSseWithMetacognitionContinuations } from './pipelineSse';
import { getPipelineExecutionBackend, EXECUTION_BACKEND_BROWSER } from './localPipeline/executionBackend';
import { slimSharedMemoryForGraphCheckpoint, slimSharedMemoryForPipelinePost } from './slimSharedMemory';
import { safeJsonStringifyPipelineBody } from './safeJsonStringify.js';
import { rowsToRecentDialogue } from './pipelineDialogueContext';
import { resolvePipelineVoiceText } from './pipelineVoiceGate';
import { MIND_PHASE_OPTIONS, persistMindAfterPipeline } from './mindPersistence';
import {
  getActiveMindEntityProfile,
  getMindEntityStores,
  getMindEntityStoresForProfile,
  normalizeScheduledTaskMindStorageProfile,
  setActiveMindEntityProfile,
} from './mindEntityContext';
import {
  buildPipelineIntegrationOptions,
  fetchPipelineIntegrationPersistedSlices,
  mergePersistedSlicesIntoPipelineOptionsSnapshot,
} from './pipelineIntegrationOptions';
import { normalizeExecutionResume } from '../../shared/pipelineExecutionResume.mjs';
import { clipTextComplete } from '../../shared/textClip.mjs';
import { splitVoiceOutputBeliefRevisionsAppendix } from '../../shared/beliefRevisionsVoice.mjs';
import {
  enqueueMetacognitionPipelineRerunSchedule,
  sanitizeMetacognitionPipelineOptionsSnapshot,
} from './scheduleMetacognitionPipelineRerun';
import { beginBackgroundCognitiveWork, endBackgroundCognitiveWork } from './pipelineBusyGate';
import { pickContinuationSharedMemoryFromFetched } from './pipelineContinuationSeed';
import { pickLatestNonCheckpointPipelineRun } from './pipelineRunCheckpoint';
import { pursuitPipelineRunIdPatch } from './pipelinePursuitResume';
import {
  registerPipelinePauseToken,
  unregisterPipelinePauseToken,
} from './pipelineActiveRunRegistry';
import { createPipelinePauseToken } from './pipelinePauseToken';
import { mergePersistedGraphPipelineUiForSession } from './graphPipelineCrossSessionPeek';
import { getGraphSessionIdForPersistence } from './graphPipelineSessionScope';
import { upsertGraphPipelineSession } from './graphPipelineSessionRegistry';
import {
  awaitIncrementalCheckpointChain,
  scheduleIncrementalModuleCheckpointPersist,
} from './incrementalModuleCheckpointPersist';
import {
  applyGraphSessionSupervisorRerunSseEvent,
  beginGraphSessionSupervisorRerunUi,
  endGraphSessionSupervisorRerunUi,
} from './graphPipelineScheduledRerunUiMirror';

async function fetchOneShot(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(describeNetworkOrOfflineError(e));
  }
}

const SCHEDULER_PHASE_IDS = new Set(MIND_PHASE_OPTIONS.map((p) => p.id));

function resolveMindOptionsForOneShot(task) {
  const rt = getRuntimeSettings();
  const rawPhase = task?.mind_phase;
  const phase =
    typeof rawPhase === 'string' && SCHEDULER_PHASE_IDS.has(rawPhase)
      ? rawPhase
      : rt.defaultMindPhase || 'focus';
  let arousal = 0.55;
  const rawAr = task?.mind_arousal;
  if (typeof rawAr === 'number' && Number.isFinite(rawAr)) {
    arousal = Math.min(1, Math.max(0, rawAr));
  } else if (typeof rawAr === 'string' && rawAr.trim() !== '') {
    const n = Number(rawAr);
    if (!Number.isNaN(n)) arousal = Math.min(1, Math.max(0, n));
  }
  return { phase, arousal };
}

function truncate(s, n) {
  return clipTextComplete(s, n, { ellipsis: true });
}

export async function persistGraphPipelineStreamResult({
  streamResult,
  promptText,
  runtimeSettings,
  source,
  executionPlan,
  curiosityPursuitContext,
  goalPursuitContext,
  finalOutputForRunRow,
  graphSessionIdForPipelineRun = null,
  mindStorageProfile: mindStorageProfileOpt,
  scheduledTaskId = null,
}) {
  const effectiveProfile = normalizeScheduledTaskMindStorageProfile(
    mindStorageProfileOpt ?? getActiveMindEntityProfile()
  );
  setActiveMindEntityProfile(effectiveProfile);
  const graphSidPatch =
    graphSessionIdForPipelineRun != null && String(graphSessionIdForPipelineRun).trim()
      ? { graph_session_id: String(graphSessionIdForPipelineRun).trim() }
      : {};
  const pursuitPatch = pursuitPipelineRunIdPatch(curiosityPursuitContext, goalPursuitContext);
  const stores = getMindEntityStores();

  await awaitIncrementalCheckpointChain();

  if (streamResult?.pipelinePaused) {
    const smP = streamResult.sharedMemory && typeof streamResult.sharedMemory === 'object' ? streamResult.sharedMemory : {};
    const ec = streamResult.executionCursor || {};
    const rawOutputs = smP.moduleOutputs || {};
    const runRow = await stores.PipelineRun.create({
      input: promptText,
      module_outputs: rawOutputs,
      shared_memory: slimSharedMemoryForGraphCheckpoint(smP),
      execution_plan: executionPlan,
      loop_count: Number(streamResult.rerunsUsed) || 0,
      final_output: `(Paused before ${ec.nextModuleName || 'next module'})`,
      runtime_settings: runtimeSettingsForPersistence(runtimeSettings),
      provider_used: streamResult.providerUsed,
      model_used: streamResult.modelUsed,
      phase: smP?.phase,
      arousal: smP?.arousal,
      intent: smP?.intent,
      phenomenal_now: smP?.phenomenalNow || null,
      cognitive_policy: smP?.cognitivePolicy || null,
      run_status: 'paused',
      pipeline_checkpoint: true,
      ...(ec && typeof ec === 'object' && Number(ec.v) === 1 ? { execution_resume: ec } : {}),
      ...graphSidPatch,
      ...pursuitPatch,
    });
    await persistMindAfterPipeline({
      sharedMemory: smP,
      voiceOutput: '',
      narrativeText: rawOutputs.Narrative || rawOutputs.narrative || '',
      runtimeSettings,
      source,
      pipelineRunId: runRow?.id,
      scheduledTaskId,
      curiosityPursuitContext,
      goalPursuitContext,
      pipelinePartialCheckpoint: true,
      mindStorageProfile: effectiveProfile,
    });
    return {
      summary: `Paused at ${ec.nextModuleName || 'checkpoint'}.`,
      voiceText: '',
      pipelineRunId: runRow?.id || null,
      sharedMemory: smP,
      rawOutputs,
      pipelinePaused: true,
      executionCursor: ec,
      voiceDeferredToScheduledSupervisor: false,
    };
  }

  const rawOutputs = streamResult.sharedMemory?.moduleOutputs || {};
  const smComplete = streamResult.sharedMemory || null;
  const voiceTextRaw = resolvePipelineVoiceText({
    voiceOutput: streamResult.voiceOutput,
    sharedMemory: smComplete,
  });
  const { displayText: voiceText } = splitVoiceOutputBeliefRevisionsAppendix(voiceTextRaw);
  const finalOutput = finalOutputForRunRow ?? (voiceText || '(no Voice output)');

  setActiveMindEntityProfile(effectiveProfile);
  const runRow = await stores.PipelineRun.create({
    input: promptText,
    module_outputs: rawOutputs,
    shared_memory: smComplete,
    execution_plan: executionPlan,
    loop_count: Number(streamResult.rerunsUsed) || 0,
    final_output: finalOutput,
    runtime_settings: runtimeSettingsForPersistence(runtimeSettings),
    provider_used: streamResult.providerUsed,
    model_used: streamResult.modelUsed,
    phase: smComplete?.phase,
    arousal: smComplete?.arousal,
    intent: smComplete?.intent,
    phenomenal_now: smComplete?.phenomenalNow || null,
    cognitive_policy: smComplete?.cognitivePolicy || null,
    ...graphSidPatch,
    ...pursuitPatch,
  });

  await persistMindAfterPipeline({
    sharedMemory: smComplete,
    voiceOutput: voiceText || '',
    narrativeText: rawOutputs.Narrative || rawOutputs.narrative || '',
    runtimeSettings,
    source,
    pipelineRunId: runRow?.id,
    scheduledTaskId,
    curiosityPursuitContext,
    goalPursuitContext,
    mindStorageProfile: effectiveProfile,
  });

  return {
    summary: truncate(voiceText, 400) || 'Pipeline completed (no Voice text).',
    voiceText: voiceText || '',
    pipelineRunId: runRow?.id || null,
    sharedMemory: smComplete,
    rawOutputs,
  };
}

/**
 * Merge per-run metacognition overrides: explicit `opts.metacognitionOverrides` wins over `task` fields.
 * @param {object|null|undefined} task
 * @param {object|null|undefined} opt
 */
function mergeMetacognitionOverridesForPrep(task, opt) {
  const merged = {};
  if (task && typeof task === 'object') {
    if (Object.prototype.hasOwnProperty.call(task, 'metacognition_max_reruns_override')) {
      merged.maxMetacognitionReruns = task.metacognition_max_reruns_override;
    }
    if (Object.prototype.hasOwnProperty.call(task, 'metacognition_rerun_delay_minutes_override')) {
      merged.metacognitionRerunDelayMinutes = task.metacognition_rerun_delay_minutes_override;
    }
  }
  if (opt && typeof opt === 'object') {
    if (Object.prototype.hasOwnProperty.call(opt, 'maxMetacognitionReruns')) {
      merged.maxMetacognitionReruns = opt.maxMetacognitionReruns;
    }
    if (Object.prototype.hasOwnProperty.call(opt, 'metacognitionRerunDelayMinutes')) {
      merged.metacognitionRerunDelayMinutes = opt.metacognitionRerunDelayMinutes;
    }
  }
  return merged;
}

/**
 * Build prompt, phase, shared-memory seed, and options snapshot for POST /api/pipeline/stream.
 * Used by one-shot runs and scheduled consciousness stream so defer/enqueue behavior stays aligned.
 *
 * @param {object} opts
 * @param {string} opts.inputText
 * @param {object} [opts.task]
 * @param {string} [opts.mindPhase]
 * @param {number} [opts.mindArousal]
 * @param {object|null|undefined} [opts.initialFullSharedMemory] — when key is present, use as continuation seed instead of the default (freshest of latest PipelineRun vs latest assistant ConversationMessage with shared_memory)
 * @param {{ maxMetacognitionReruns?: number|null, metacognitionRerunDelayMinutes?: number|null }} [opts.metacognitionOverrides] — null = use global runtime defaults
 * @param {string} [opts.mindStorageProfile] primary vs mirror — also read from `task.mind_storage_profile` when omitted
 */
export async function prepareGraphPipelineSseInputs(opts = {}) {
  const {
    inputText,
    task = null,
    mindPhase,
    mindArousal,
    initialFullSharedMemory,
    metacognitionOverrides,
    mindStorageProfile: mindStorageProfileOpt,
  } = opts;
  const mindStorageProfile = normalizeScheduledTaskMindStorageProfile(
    mindStorageProfileOpt ?? task?.mind_storage_profile
  );
  const hasExplicitMemory = Object.prototype.hasOwnProperty.call(opts, 'initialFullSharedMemory');
  const runtimeSettings = getRuntimeSettings();
  let { phase, arousal } = resolveMindOptionsForOneShot(task || {});
  if (typeof mindPhase === 'string' && SCHEDULER_PHASE_IDS.has(mindPhase)) phase = mindPhase;
  if (typeof mindArousal === 'number' && Number.isFinite(mindArousal)) {
    arousal = Math.min(1, Math.max(0, mindArousal));
  }

  const stores = getMindEntityStoresForProfile(mindStorageProfile);
  let lastSm;
  let dialogueRows;
  if (hasExplicitMemory) {
    lastSm = initialFullSharedMemory ?? null;
    dialogueRows = await stores.ConversationMessage.list('-created_date', 16);
  } else {
    const [runs, msgs] = await Promise.all([
      stores.PipelineRun.list('-created_date', 12),
      stores.ConversationMessage.list('-created_date', 16),
    ]);
    lastSm = pickContinuationSharedMemoryFromFetched({
      latestPipelineRun: pickLatestNonCheckpointPipelineRun(runs),
      recentConversationMessages: msgs,
    });
    dialogueRows = msgs;
  }

  const promptText = String(inputText || '').trim() || 'Pipeline run.';
  const recentDialogue = rowsToRecentDialogue(dialogueRows, 16);

  const mo = mergeMetacognitionOverridesForPrep(task, metacognitionOverrides);
  const delayMin = effectiveMetacognitionRerunDelayMinutes(runtimeSettings, mo.metacognitionRerunDelayMinutes);

  const pipelineOptionsSnapshot = await buildPipelineIntegrationOptions({
    userInput: promptText,
    runtimeSettings,
    mindPhase: phase,
    arousal,
    intent: '',
    recentDialogue,
    continueMemory: lastSm,
    metacognitionOverrides: mo,
    mindStorageProfile,
  });

  return {
    promptText,
    phase,
    arousal,
    lastSm,
    pipelineOptionsSnapshot,
    delayMin,
    runtimeSettings,
    executionPlan: getExecutionPlan(),
  };
}

/**
 * Run SSE graph legs with a pre-built options snapshot (shared with scheduled consciousness stream).
 */
export async function streamGraphPipelineSseLegs({
  fetchImpl,
  promptText,
  attachmentIds = [],
  lastSm,
  pipelineOptionsSnapshot,
  treatFirstLegAsContinuation = false,
  onSseEvent,
  abortSignal,
  executionResume = null,
  pauseSupport = false,
  pauseToken = null,
  /** When true (default), re-fetch persisted-store slices before each continuation leg so other pipelines' writes are visible. */
  refreshIntegrationSlicesBetweenLegs = true,
  mindStorageProfile: mindStorageProfileForSlices = undefined,
}) {
  const integrationProfile =
    mindStorageProfileForSlices !== undefined
      ? normalizeScheduledTaskMindStorageProfile(mindStorageProfileForSlices)
      : getActiveMindEntityProfile();
  let optionsSnapshot =
    pipelineOptionsSnapshot && typeof pipelineOptionsSnapshot === 'object'
      ? { ...pipelineOptionsSnapshot }
      : {};
  /** Dynamic import: see the matching branch in consciousnessStreamRunner.js for why. */
  const runPipelineLeg =
    getPipelineExecutionBackend() === EXECUTION_BACKEND_BROWSER
      ? (await import('./localPipeline/localPipelineRunner')).runLocalPipelineWithMetacognitionContinuations
      : consumePipelineSseWithMetacognitionContinuations;

  return runPipelineLeg({
    fetchImpl,
    treatFirstLegAsContinuation,
    abortSignal,
    initialSlimSharedMemory: slimSharedMemoryForPipelinePost(lastSm, {
      continuation: treatFirstLegAsContinuation === true,
    }),
    buildFetchInit: async ({ slimSharedMemory, pipelineMetacognitionContinuation, leg }) => {
      if (refreshIntegrationSlicesBetweenLegs && leg > 1 && String(promptText || '').trim()) {
        try {
          const slices = await fetchPipelineIntegrationPersistedSlices(promptText, {
            mindStorageProfile: integrationProfile,
          });
          optionsSnapshot = mergePersistedSlicesIntoPipelineOptionsSnapshot(optionsSnapshot, slices);
        } catch (e) {
          console.warn('[streamGraphPipelineSseLegs] integration slice refresh failed', e);
        }
      }
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: safeJsonStringifyPipelineBody({
          input: promptText,
          attachmentIds,
          sharedMemory: slimSharedMemory,
          ...(pauseSupport && pauseToken ? { pauseToken, pauseSupport: true } : {}),
          options: {
            ...optionsSnapshot,
            ...(pipelineMetacognitionContinuation ? { pipelineMetacognitionContinuation: true } : {}),
            ...(!pipelineMetacognitionContinuation ? { deferMetacognitionRerun: true } : {}),
            ...(leg === 1 && executionResume && !pipelineMetacognitionContinuation ? { executionResume } : {}),
            ...(pauseSupport && pauseToken ? { pauseSupport: true, pauseToken } : {}),
          },
        }),
      };
    },
    onEvent: (evt) => {
      try {
        onSseEvent?.(evt);
      } catch (e) {
        console.warn('[streamGraphPipelineSseLegs] onSseEvent', e);
      }
    },
  });
}

/**
 * Canonical graph SSE path after {@link prepareGraphPipelineSseInputs}: stream all legs, enqueue deferred
 * supervisor continuation when applicable, compute `finalNote` for PipelineRun rows.
 *
 * @param {object} opts
 * @param {Pick<Awaited<ReturnType<typeof prepareGraphPipelineSseInputs>>, 'promptText' | 'lastSm' | 'pipelineOptionsSnapshot' | 'delayMin' | 'phase' | 'arousal'>} opts.prep
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string[]} [opts.attachmentIds]
 * @param {(evt: object) => void} [opts.onSseEvent]
 * @param {object|null} [opts.curiosityPursuitContext]
 * @param {object|null} [opts.goalPursuitContext]
 * @param {boolean} [opts.treatFirstLegAsContinuation]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{ streamResult: object, pending: object|null|undefined, finalNote: string|null }>}
 */
export async function executePreparedGraphPipelineSse({
  prep,
  fetchImpl = fetchOneShot,
  attachmentIds = [],
  onSseEvent,
  curiosityPursuitContext = null,
  goalPursuitContext = null,
  treatFirstLegAsContinuation = false,
  abortSignal,
  executionResume = null,
  pauseSupport = false,
  pauseToken = null,
  pipelineSource = 'graph-one-shot',
  graphSessionIdForPipelineRun = null,
  mindStorageProfile: mindStorageProfileOpt,
}) {
  const rt = prep.runtimeSettings || getRuntimeSettings();
  const wrappedOnSseEvent = (evt) => {
    onSseEvent?.(evt);
    if (
      evt?.type === 'module_complete' &&
      evt.executionCheckpoint &&
      evt.sharedMemory &&
      prep.pipelineOptionsSnapshot?.incrementalModuleCheckpoint !== false
    ) {
      scheduleIncrementalModuleCheckpointPersist({
        evt,
        promptText: prep.promptText,
        runtimeSettings: rt,
        source: pipelineSource,
        curiosityPursuitContext,
        goalPursuitContext,
        graphSessionIdForPipelineRun,
        mindStorageProfile: mindStorageProfileOpt,
      });
    }
  };

  const streamResult = await streamGraphPipelineSseLegs({
    fetchImpl,
    promptText: prep.promptText,
    attachmentIds,
    lastSm: prep.lastSm,
    pipelineOptionsSnapshot: prep.pipelineOptionsSnapshot,
    treatFirstLegAsContinuation,
    onSseEvent: wrappedOnSseEvent,
    abortSignal,
    executionResume,
    pauseSupport,
    pauseToken,
    mindStorageProfile: normalizeScheduledTaskMindStorageProfile(
      mindStorageProfileOpt ?? getActiveMindEntityProfile()
    ),
  });

  const resolvedProfile = normalizeScheduledTaskMindStorageProfile(
    mindStorageProfileOpt ?? getActiveMindEntityProfile()
  );
  setActiveMindEntityProfile(resolvedProfile);

  const pending = streamResult.metacognitionRerunPending;
  await maybeEnqueueMetacognitionRerun({
    pending,
    delayMin: prep.delayMin,
    promptText: prep.promptText,
    attachmentIds,
    streamResult,
    pipelineOptionsSnapshot: prep.pipelineOptionsSnapshot,
    phase: prep.phase,
    arousal: prep.arousal,
    curiosityPursuitContext,
    goalPursuitContext,
    mindStorageProfile: resolvedProfile,
    graphSessionId: graphSessionIdForPipelineRun,
  });

  const effectiveDelay = Math.max(1, prep.delayMin || 0);
  const finalNote = pending
    ? `(Supervisor RERUN scheduled in ~${effectiveDelay} min — Voice pending) ${pending.supervisor}: ${(pending.reason || '').slice(0, 200)}`
    : null;

  return { streamResult, pending, finalNote };
}

async function maybeEnqueueMetacognitionRerun({
  pending,
  delayMin,
  promptText,
  attachmentIds,
  streamResult,
  pipelineOptionsSnapshot,
  phase,
  arousal,
  curiosityPursuitContext,
  goalPursuitContext,
  mindStorageProfile,
  graphSessionId,
}) {
  if (!pending) return;
  const effectiveDelay = Math.max(1, delayMin || 0);
  await enqueueMetacognitionPipelineRerunSchedule({
    delayMinutes: effectiveDelay,
    reason: `${pending.supervisor}: ${pending.reason || ''}`.slice(0, 500),
    inputText: promptText,
    attachmentIds,
    slimSharedMemory: slimSharedMemoryForPipelinePost(streamResult.sharedMemory, { continuation: true }),
    pipelineOptionsSnapshot,
    mindPhase: phase,
    mindArousal: arousal,
    curiosityPursuitContext,
    goalPursuitContext,
    mindStorageProfile,
    graphSessionId,
  });
}

/**
 * One full graph pipeline POST + SSE + PipelineRun + persistMindAfterPipeline (no graph UI store).
 * @param {object} opts
 * @param {string} opts.inputText
 * @param {object} [opts.task] - optional scheduled task (phase / arousal)
 * @param {string} [opts.source]
 * @param {{ parentCuriosityId: string, rootCuriosityId: string } | null} [opts.curiosityPursuitContext]
 * @param {{ parentGoalId: string, rootGoalId: string } | null} [opts.goalPursuitContext]
 * @param {string} [opts.mindPhase] - override phase
 * @param {number} [opts.mindArousal] - override arousal
 * @param {(evt: object) => void} [opts.onSseEvent] - every SSE event (module_start, complete, error, …); does not persist
 * @param {boolean} [opts.acquireGlobalGate=true] - false when caller already holds {@link beginBackgroundCognitiveWork} (e.g. scheduled task runner)
 * @param {object|null|undefined} [opts.initialFullSharedMemory] - continuation seed; omit to use freshest PipelineRun vs assistant message (see prepareGraphPipelineSseInputs)
 * @param {typeof fetch} [opts.fetchImpl] - default in-browser fetch for `/api/pipeline/stream`
 * @param {AbortSignal} [opts.abortSignal]
 * @param {object|null} [opts.executionResume] — server {@link normalizeExecutionResume} cursor for leg 1
 * @param {string} [opts.pauseToken] — cooperative pause token (auto-generated if omitted and cooperativePause is true)
 * @param {boolean} [opts.cooperativePause=true] — register pause token on `/api/pipeline/pause-request` (registered before heavy prep so Dashboard “Pause & save” sees goal/curiosity one-shots immediately)
 * @param {boolean} [opts.skipApiReachabilityProbe] — ignored (legacy); pipeline reachability is determined by POST /api/pipeline/stream, not GET /api/ping
 * @param {{ maxMetacognitionReruns?: number|null, metacognitionRerunDelayMinutes?: number|null }} [opts.metacognitionOverrides]
 * @param {string|null} [opts.graphSessionIdForPipelineRun] - stored on {@link PipelineRun} as `graph_session_id` (dialogue / transcript linkage).
 * @param {boolean} [opts.mirrorCooperativePauseToGraphSession=true] - when false, still registers pause tokens but does not write graph session KV/registry (use for headless scheduler runs so Dashboard does not show a ghost graph workspace row).
 * @param {string} [opts.mindStorageProfile] `primary` or `playgroundMirror`; falls back to `task.mind_storage_profile` for scheduled rows.
 * @returns {Promise<object & { voiceText: string, pipelineRunId: string|null, voiceDeferredToScheduledSupervisor?: boolean }>}
 *   `voiceDeferredToScheduledSupervisor` is true when Voice was deferred to a `supervisor_pipeline_rerun` task (positive delay); callers should skip `finalizePursued*AfterGraph` until that task completes.
 */
export async function runGraphPipelineOneShot(params = {}) {
  const {
    inputText,
    task = null,
    source = 'graph-one-shot',
    curiosityPursuitContext = null,
    goalPursuitContext = null,
    mindPhase,
    mindArousal,
    onSseEvent,
    acquireGlobalGate = true,
    initialFullSharedMemory,
    fetchImpl = fetchOneShot,
    abortSignal,
    executionResume = null,
    pauseToken: pauseTokenOpt = null,
    cooperativePause = true,
    metacognitionOverrides,
    graphSessionIdForPipelineRun = null,
    mirrorCooperativePauseToGraphSession = true,
    mindStorageProfile: mindStorageProfileParam,
  } = params;
  const normalizedMindProfile = normalizeScheduledTaskMindStorageProfile(
    mindStorageProfileParam ?? task?.mind_storage_profile
  );
  const pauseToken =
    cooperativePause === false ? null : pauseTokenOpt || createPipelinePauseToken();
  const regId =
    curiosityPursuitContext?.parentCuriosityId ||
    goalPursuitContext?.parentGoalId ||
    task?.id ||
    source;
  /** Session row + persisted KV so Dashboard pause can resolve cooperative tokens without graph UI mounted. */
  let pursuitPauseSid = null;
  if (pauseToken) {
    registerPipelinePauseToken(pauseToken, { kind: 'one-shot', id: String(regId || '') });
    if (mirrorCooperativePauseToGraphSession) {
      pursuitPauseSid =
        graphSessionIdForPipelineRun != null && String(graphSessionIdForPipelineRun).trim()
          ? String(graphSessionIdForPipelineRun).trim()
          : getGraphSessionIdForPersistence();
      mergePersistedGraphPipelineUiForSession(pursuitPauseSid, {
        cooperativePauseToken: pauseToken,
        isRunning: true,
      });
      upsertGraphPipelineSession({ id: pursuitPauseSid, isProcessing: true });
    }
  }

  const prepOpts = { inputText, task, mindPhase, mindArousal, mindStorageProfile: normalizedMindProfile };
  if (Object.prototype.hasOwnProperty.call(params, 'initialFullSharedMemory')) {
    prepOpts.initialFullSharedMemory = initialFullSharedMemory;
  }
  if (Object.prototype.hasOwnProperty.call(params, 'metacognitionOverrides')) {
    prepOpts.metacognitionOverrides = metacognitionOverrides;
  }

  const previousMindProfile = getActiveMindEntityProfile();
  setActiveMindEntityProfile(normalizedMindProfile);
  const executionResumeForRun =
    executionResume && typeof executionResume === 'object'
      ? normalizeExecutionResume(executionResume) || null
      : null;
  try {
    const prep = await prepareGraphPipelineSseInputs(prepOpts);

    const runInner = async () => {
      const { streamResult, pending, finalNote } = await executePreparedGraphPipelineSse({
        prep,
        fetchImpl,
        attachmentIds: [],
        onSseEvent,
        curiosityPursuitContext,
        goalPursuitContext,
        abortSignal,
        executionResume: executionResumeForRun,
        pauseSupport: Boolean(pauseToken),
        pauseToken,
        pipelineSource: source,
        graphSessionIdForPipelineRun,
        mindStorageProfile: normalizedMindProfile,
      });

      const persisted = await persistGraphPipelineStreamResult({
        streamResult,
        promptText: prep.promptText,
        runtimeSettings: prep.runtimeSettings,
        source,
        executionPlan: prep.executionPlan,
        curiosityPursuitContext,
        goalPursuitContext,
        finalOutputForRunRow: finalNote,
        graphSessionIdForPipelineRun,
        mindStorageProfile: normalizedMindProfile,
        scheduledTaskId: task?.id ?? null,
      });
      const voiceDeferredToScheduledSupervisor = Boolean(pending && prep.delayMin > 0);
      return { ...persisted, voiceDeferredToScheduledSupervisor };
    };

    if (acquireGlobalGate) {
      beginBackgroundCognitiveWork();
      try {
        return await runInner();
      } finally {
        endBackgroundCognitiveWork();
      }
    }
    return await runInner();
  } finally {
    setActiveMindEntityProfile(previousMindProfile);
    if (pauseToken) unregisterPipelinePauseToken(pauseToken);
    if (pursuitPauseSid) {
      mergePersistedGraphPipelineUiForSession(pursuitPauseSid, {
        cooperativePauseToken: null,
        isRunning: false,
      });
      upsertGraphPipelineSession({ id: pursuitPauseSid, isProcessing: false });
    }
  }
}

/**
 * Continuation leg(s) from a `supervisor_pipeline_rerun` or legacy `metacognition_pipeline_rerun` ScheduledTask.
 * @param {boolean} [opts.acquireGlobalGate=true] - set false when scheduled task runner already holds the global gate
 */
export async function runGraphPipelineFromScheduledMetacognitionRerun(params = {}) {
  const {
    task,
    source = 'metacognition-rerun-scheduled',
    curiosityPursuitContext = null,
    goalPursuitContext = null,
    onSseEvent,
    acquireGlobalGate = true,
    abortSignal,
    executionResume = null,
  } = params;
  const runtimeSettings = getRuntimeSettings();
  const executionPlan = getExecutionPlan();
  const promptText = String(task?.input_text || '').trim();
  if (!promptText) throw new Error('supervisor_pipeline_rerun: missing input_text');
  try {
    console.info('[scheduler] supervisor_pipeline_rerun', {
      taskId: task?.id,
      inputChars: promptText.length,
    });
  } catch {
    /* ignore */
  }
  const attachmentIds = Array.isArray(task.metacognition_rerun_attachment_ids)
    ? task.metacognition_rerun_attachment_ids
    : [];
  const slimStart =
    task.pipeline_checkpoint_shared_memory && typeof task.pipeline_checkpoint_shared_memory === 'object'
      ? task.pipeline_checkpoint_shared_memory
      : task.metacognition_rerun_slim_shared_memory ?? null;
  const normalizedProfile = normalizeScheduledTaskMindStorageProfile(task?.mind_storage_profile);
  const previousMindProfile = getActiveMindEntityProfile();
  setActiveMindEntityProfile(normalizedProfile);
  try {
  let snapRaw = task.metacognition_rerun_pipeline_options;
  if (!snapRaw || typeof snapRaw !== 'object') {
    const prepFallback = await prepareGraphPipelineSseInputs({
      inputText: promptText,
      task,
      mindStorageProfile: normalizedProfile,
      ...(slimStart != null ? { initialFullSharedMemory: slimStart } : {}),
    });
    snapRaw = prepFallback.pipelineOptionsSnapshot;
    try {
      console.warn(
        '[scheduler] supervisor_pipeline_rerun: rebuilt missing/corrupt options snapshot from current settings + memory seed',
        { taskId: task?.id }
      );
    } catch {
      /* ignore */
    }
  }
  const snap = sanitizeMetacognitionPipelineOptionsSnapshot(snapRaw);
  const delayMin = resolveMetacognitionRerunDelayMinutesFromSnapshot(snap, runtimeSettings);

  const storedCuriosity =
    task.metacognition_rerun_curiosity_pursuit_context && typeof task.metacognition_rerun_curiosity_pursuit_context === 'object'
      ? task.metacognition_rerun_curiosity_pursuit_context
      : null;
  const storedGoal =
    task.metacognition_rerun_goal_pursuit_context && typeof task.metacognition_rerun_goal_pursuit_context === 'object'
      ? task.metacognition_rerun_goal_pursuit_context
      : null;
  const effCuriosity = curiosityPursuitContext ?? storedCuriosity;
  const effGoal = goalPursuitContext ?? storedGoal;

  const executionResumeForStream =
    executionResume && typeof executionResume === 'object'
      ? normalizeExecutionResume(executionResume) || executionResume
      : task?.pipeline_checkpoint_execution_resume && typeof task.pipeline_checkpoint_execution_resume === 'object'
        ? normalizeExecutionResume(task.pipeline_checkpoint_execution_resume) ||
          task.pipeline_checkpoint_execution_resume
        : null;

  const graphSidRaw = task?.metacognition_rerun_graph_session_id;
  const graphSid =
    graphSidRaw != null && String(graphSidRaw).trim() ? String(graphSidRaw).trim() : null;

  const runInner = async () => {
    const prepLike = {
      promptText,
      lastSm: slimStart,
      pipelineOptionsSnapshot: { ...snap },
      delayMin,
      phase: task.mind_phase,
      arousal: task.mind_arousal,
      runtimeSettings,
    };

    if (graphSid) beginGraphSessionSupervisorRerunUi(graphSid, {});
    let clearCheckpointOnEnd = false;
    const pauseToken = createPipelinePauseToken();
    registerPipelinePauseToken(pauseToken, { kind: 'metacognition-rerun', id: String(task?.id || '') });
    try {
      const wrappedOnSse = (evt) => {
        onSseEvent?.(evt);
        if (graphSid) {
          applyGraphSessionSupervisorRerunSseEvent(graphSid, evt, {
            promptText,
            attachmentIds,
            runtimeSettings,
            mindStorageProfile: normalizedProfile,
            pipelineOptionsSnapshot: snap,
            curiosityPursuitContext: effCuriosity,
            goalPursuitContext: effGoal,
          });
        }
      };
      const { streamResult, pending, finalNote } = await executePreparedGraphPipelineSse({
        prep: prepLike,
        fetchImpl: fetchOneShot,
        attachmentIds,
        onSseEvent: wrappedOnSse,
        curiosityPursuitContext: effCuriosity,
        goalPursuitContext: effGoal,
        treatFirstLegAsContinuation: true,
        abortSignal,
        executionResume: executionResumeForStream,
        pauseSupport: true,
        pauseToken,
        pipelineSource: source,
        graphSessionIdForPipelineRun: graphSid,
        mindStorageProfile: normalizedProfile,
      });

      clearCheckpointOnEnd = !streamResult?.pipelinePaused;
      const persisted = await persistGraphPipelineStreamResult({
        streamResult,
        promptText,
        runtimeSettings,
        source,
        executionPlan,
        curiosityPursuitContext: effCuriosity,
        goalPursuitContext: effGoal,
        finalOutputForRunRow: finalNote,
        graphSessionIdForPipelineRun: graphSid,
        mindStorageProfile: normalizedProfile,
        scheduledTaskId: task?.id ?? null,
      });
      return {
        ...persisted,
        voiceDeferredToScheduledSupervisor: Boolean(pending && delayMin > 0),
      };
    } finally {
      unregisterPipelinePauseToken(pauseToken);
      if (graphSid) {
        endGraphSessionSupervisorRerunUi(graphSid, { clearCheckpoint: clearCheckpointOnEnd });
      }
    }
  };

  if (acquireGlobalGate) {
    beginBackgroundCognitiveWork();
    try {
      return await runInner();
    } finally {
      endBackgroundCognitiveWork();
    }
  }
  return runInner();
  } finally {
    setActiveMindEntityProfile(previousMindProfile);
  }
}
