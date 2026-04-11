import { ensureApiReachable, describeNetworkOrOfflineError } from './apiReachability';
import { openrouterPipelineOptions } from './llmClientOptions';
import {
  getRuntimeSettings,
  effectiveMaxMetacognitionReruns,
  effectiveMetacognitionRerunDelayMinutes,
  resolveMetacognitionRerunDelayMinutesFromSnapshot,
  runtimeSettingsForPersistence,
} from './runtimeSettings';
import { getExecutionPlan } from './cognitiveModules';
import { consumePipelineSseWithMetacognitionContinuations } from './pipelineSse';
import { slimSharedMemoryForPipelinePost } from './slimSharedMemory';
import { safeJsonStringifyPipelineBody } from './safeJsonStringify.js';
import { buildPriorPredictionAuditPayload } from './priorPredictionAudit';
import { rowsToRecentDialogue } from './pipelineDialogueContext';
import { resolvePipelineVoiceText } from './pipelineVoiceGate';
import {
  MIND_PHASE_OPTIONS,
  persistMindAfterPipeline,
  loadStructuralSelfForPipeline,
  buildWorkingMemorySeed,
} from './mindPersistence';
import { ConversationMessage, PipelineRun, TemporalEvent } from './data';
import { fetchPersistedMindStoresForPipeline } from './persistedMindStoresForPipeline';
import { loadDmnCarryoverTextForPhase } from './mindDmnContext';
import { clipTextComplete } from '../../shared/textClip.mjs';
import { temporalEventsExcludingPauseNoise } from '../../shared/temporalTimelinePauseFilter.mjs';
import { splitVoiceOutputBeliefRevisionsAppendix } from '../../shared/beliefRevisionsVoice.mjs';
import {
  enqueueMetacognitionPipelineRerunSchedule,
  sanitizeMetacognitionPipelineOptionsSnapshot,
} from './scheduleMetacognitionPipelineRerun';
import { beginBackgroundCognitiveWork, endBackgroundCognitiveWork } from './pipelineBusyGate';
import { pickContinuationSharedMemoryFromFetched } from './pipelineContinuationSeed';
import { pickLatestNonCheckpointPipelineRun } from './pipelineRunCheckpoint';
import {
  registerPipelinePauseToken,
  unregisterPipelinePauseToken,
} from './pipelineActiveRunRegistry';
import { createPipelinePauseToken } from './pipelinePauseToken';
import { mergePersistedGraphPipelineUiForSession } from './graphPipelineCrossSessionPeek';
import { getGraphSessionIdForPersistence } from './graphPipelineSessionScope';
import { upsertGraphPipelineSession } from './graphPipelineSessionRegistry';
import { scheduleIncrementalModuleCheckpointPersist } from './incrementalModuleCheckpointPersist';

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
}) {
  const graphSidPatch =
    graphSessionIdForPipelineRun != null && String(graphSessionIdForPipelineRun).trim()
      ? { graph_session_id: String(graphSessionIdForPipelineRun).trim() }
      : {};
  if (streamResult?.pipelinePaused) {
    const smP = streamResult.sharedMemory && typeof streamResult.sharedMemory === 'object' ? streamResult.sharedMemory : {};
    const ec = streamResult.executionCursor || {};
    const rawOutputs = smP.moduleOutputs || {};
    const runRow = await PipelineRun.create({
      input: promptText,
      module_outputs: rawOutputs,
      shared_memory: smP,
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
    });
    await persistMindAfterPipeline({
      sharedMemory: smP,
      voiceOutput: '',
      narrativeText: rawOutputs.Narrative || rawOutputs.narrative || '',
      runtimeSettings,
      source,
      pipelineRunId: runRow?.id,
      curiosityPursuitContext,
      goalPursuitContext,
      pipelinePartialCheckpoint: true,
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

  const runRow = await PipelineRun.create({
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
  });

  await persistMindAfterPipeline({
    sharedMemory: smComplete,
    voiceOutput: voiceText || '',
    narrativeText: rawOutputs.Narrative || rawOutputs.narrative || '',
    runtimeSettings,
    source,
    pipelineRunId: runRow?.id,
    curiosityPursuitContext,
    goalPursuitContext,
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
 */
export async function prepareGraphPipelineSseInputs(opts = {}) {
  const { inputText, task = null, mindPhase, mindArousal, initialFullSharedMemory, metacognitionOverrides } = opts;
  const hasExplicitMemory = Object.prototype.hasOwnProperty.call(opts, 'initialFullSharedMemory');
  const runtimeSettings = getRuntimeSettings();
  const maxTokens = Number(runtimeSettings.pipelineMaxTokens) || 800;
  let { phase, arousal } = resolveMindOptionsForOneShot(task || {});
  if (typeof mindPhase === 'string' && SCHEDULER_PHASE_IDS.has(mindPhase)) phase = mindPhase;
  if (typeof mindArousal === 'number' && Number.isFinite(mindArousal)) {
    arousal = Math.min(1, Math.max(0, mindArousal));
  }

  let lastSm;
  let dialogueRows;
  if (hasExplicitMemory) {
    lastSm = initialFullSharedMemory ?? null;
    dialogueRows = await ConversationMessage.list('-created_date', 16);
  } else {
    const [runs, msgs] = await Promise.all([
      PipelineRun.list('-created_date', 12),
      ConversationMessage.list('-created_date', 16),
    ]);
    lastSm = pickContinuationSharedMemoryFromFetched({
      latestPipelineRun: pickLatestNonCheckpointPipelineRun(runs),
      recentConversationMessages: msgs,
    });
    dialogueRows = msgs;
  }

  const structuralSelf = await loadStructuralSelfForPipeline({ maxItems: 12 });
  const promptText = String(inputText || '').trim() || 'Pipeline run.';
  const wmSeed = buildWorkingMemorySeed(promptText, runtimeSettings.pinnedWorkingMemory || []);
  const recentDialogue = rowsToRecentDialogue(dialogueRows, 16);
  let recentTemporalEvents = [];
  try {
    recentTemporalEvents = temporalEventsExcludingPauseNoise(await TemporalEvent.list('-created_date', 24));
  } catch {
    recentTemporalEvents = [];
  }
  let mindStores = {
    persistedLongTermMemories: [],
    persistedBeliefRows: [],
    persistedAffectHistory: [],
    persistedBiographyExcerpt: '',
  };
  try {
    mindStores = await fetchPersistedMindStoresForPipeline(promptText);
  } catch {
    /* keep defaults */
  }
  const dmnCarryover = await loadDmnCarryoverTextForPhase(phase);
  const priorPredictionAudit = buildPriorPredictionAuditPayload(lastSm, promptText);

  const mo = mergeMetacognitionOverridesForPrep(task, metacognitionOverrides);
  const delayMin = effectiveMetacognitionRerunDelayMinutes(runtimeSettings, mo.metacognitionRerunDelayMinutes);
  const effMaxReruns = effectiveMaxMetacognitionReruns(runtimeSettings, mo.maxMetacognitionReruns);

  const pipelineOptionsSnapshot = {
    max_tokens: maxTokens,
    temperature: 0.55,
    phase,
    arousal,
    intent: '',
    constitution: runtimeSettings.mindConstitution || '',
    userModel: runtimeSettings.userModel || {},
    personalityProfile: runtimeSettings.personalityProfile || {
      version: 0,
      facets: [],
      relationalStance: null,
      systemTreatmentNotes: '',
    },
    modulePromptOverrides: runtimeSettings.modulePromptOverrides || {},
    structuralSelf,
    workingMemorySeed: wmSeed,
    recentDialogue,
    maxMetacognitionReruns: effMaxReruns,
    metacognitionRerunDelayMinutes: delayMin,
    ...(runtimeSettings.preserveModuleTrace === true ? { preserveModuleTrace: true } : {}),
    ...(runtimeSettings.strictGlobalWorkspaceBroadcast === true
      ? { strictGlobalWorkspaceBroadcast: true }
      : {}),
    ...(dmnCarryover ? { dmnCarryover } : {}),
    ...(priorPredictionAudit ? { priorPredictionAudit } : {}),
    mindDisplayName: String(runtimeSettings.mindDisplayName || '').trim(),
    recentTemporalEvents,
    ...mindStores,
    ...openrouterPipelineOptions(runtimeSettings),
    incrementalModuleCheckpoint: true,
  };

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
}) {
  return consumePipelineSseWithMetacognitionContinuations({
    fetchImpl,
    treatFirstLegAsContinuation,
    abortSignal,
    initialSlimSharedMemory: slimSharedMemoryForPipelinePost(lastSm, {
      continuation: treatFirstLegAsContinuation === true,
    }),
    buildFetchInit: ({ slimSharedMemory, pipelineMetacognitionContinuation, leg }) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: safeJsonStringifyPipelineBody({
        input: promptText,
        attachmentIds,
        sharedMemory: slimSharedMemory,
        ...(pauseSupport && pauseToken ? { pauseToken, pauseSupport: true } : {}),
        options: {
          ...pipelineOptionsSnapshot,
          ...(pipelineMetacognitionContinuation ? { pipelineMetacognitionContinuation: true } : {}),
          ...(!pipelineMetacognitionContinuation ? { deferMetacognitionRerun: true } : {}),
          ...(leg === 1 && executionResume && !pipelineMetacognitionContinuation ? { executionResume } : {}),
          ...(pauseSupport && pauseToken ? { pauseSupport: true, pauseToken } : {}),
        },
      }),
    }),
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
  });

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
 * @param {boolean} [opts.skipApiReachabilityProbe=false] — when true, skip GET /api/ping (e.g. caller already ran {@link ensureApiReachable})
 * @param {{ maxMetacognitionReruns?: number|null, metacognitionRerunDelayMinutes?: number|null }} [opts.metacognitionOverrides]
 * @param {string|null} [opts.graphSessionIdForPipelineRun] - stored on {@link PipelineRun} as `graph_session_id` (dialogue / transcript linkage).
 * @param {boolean} [opts.mirrorCooperativePauseToGraphSession=true] - when false, still registers pause tokens but does not write graph session KV/registry (use for headless scheduler runs so Dashboard does not show a ghost graph workspace row).
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
    skipApiReachabilityProbe = false,
    metacognitionOverrides,
    graphSessionIdForPipelineRun = null,
    mirrorCooperativePauseToGraphSession = true,
  } = params;
  if (!skipApiReachabilityProbe) {
    await ensureApiReachable({ timeoutMs: 8000 });
  }

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

  const prepOpts = { inputText, task, mindPhase, mindArousal };
  if (Object.prototype.hasOwnProperty.call(params, 'initialFullSharedMemory')) {
    prepOpts.initialFullSharedMemory = initialFullSharedMemory;
  }
  if (Object.prototype.hasOwnProperty.call(params, 'metacognitionOverrides')) {
    prepOpts.metacognitionOverrides = metacognitionOverrides;
  }

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
        executionResume,
        pauseSupport: Boolean(pauseToken),
        pauseToken,
        pipelineSource: source,
        graphSessionIdForPipelineRun,
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
  const snapRaw = task.metacognition_rerun_pipeline_options;
  if (!snapRaw || typeof snapRaw !== 'object') throw new Error('supervisor_pipeline_rerun: missing options snapshot');
  const snap = sanitizeMetacognitionPipelineOptionsSnapshot(snapRaw);
  const slimStart = task.metacognition_rerun_slim_shared_memory ?? null;
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

    const pauseToken = createPipelinePauseToken();
    registerPipelinePauseToken(pauseToken, { kind: 'metacognition-rerun', id: String(task?.id || '') });
    try {
      const { streamResult, pending, finalNote } = await executePreparedGraphPipelineSse({
        prep: prepLike,
        fetchImpl: fetchOneShot,
        attachmentIds,
        onSseEvent,
        curiosityPursuitContext: effCuriosity,
        goalPursuitContext: effGoal,
        treatFirstLegAsContinuation: true,
        abortSignal,
        executionResume,
        pauseSupport: true,
        pauseToken,
        pipelineSource: source,
        graphSessionIdForPipelineRun: null,
      });

      const persisted = await persistGraphPipelineStreamResult({
        streamResult,
        promptText,
        runtimeSettings,
        source,
        executionPlan,
        curiosityPursuitContext: effCuriosity,
        goalPursuitContext: effGoal,
        finalOutputForRunRow: finalNote,
        graphSessionIdForPipelineRun: null,
      });
      return {
        ...persisted,
        voiceDeferredToScheduledSupervisor: Boolean(pending && delayMin > 0),
      };
    } finally {
      unregisterPipelinePauseToken(pauseToken);
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
}
