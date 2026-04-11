import { collectPipelineEmergenceMarkers } from '../../shared/biographyIdentityExtract.mjs';
import { splitVoiceOutputBeliefRevisionsAppendix } from '../../shared/beliefRevisionsVoice.mjs';
import { llmService } from '../services/llmService';
import { normalizeModuleOutputsFromServer } from './cognitiveModules';
import { getRuntimeSettings, runtimeSettingsForPersistence } from './runtimeSettings';
import { computeNextBackoffIso, shouldAutoRetryTask } from './schedulerAutoRetry';
import { appendRateLimitRecoveryHint } from './pipelineSse';
import { tagScheduledTaskFailureSummary } from './schedulerFailureDiagnostics';
import { isPipelinePauseOutcome } from './pipelinePauseOutcome';
import { excludeCheckpointPipelineRuns } from './pipelineRunCheckpoint';
import { resolvePipelineVoiceText } from './pipelineVoiceGate';
import {
  MIND_PHASE_OPTIONS,
  persistMindAfterPipeline,
  mergeBeliefsFromRecentPipelineRuns,
  runConsolidationPass,
} from './mindPersistence';
import { invokeLLM } from './llm';
import { clampPriority, DEFAULT_MANUAL_LIKE_PRIORITY } from './priorityUtils';
import { notifyMindStorageChanged } from './mindStorageEvents';
import {
  buildWorldModelCreatePayload,
  buildWorldModelUpdatePayload,
  itemKeyForRecord,
  newWorldModelHistoryEntry,
  normalizeWorldModelCategory,
  stableWorldModelKey,
} from './worldModelSchema';
import {
  BeliefStore,
  BeliefTension,
  ConversationMessage,
  CuriosityItem,
  GoalItem,
  DreamRun,
  EmergenceEvent,
  FeedbackItem,
  LongTermMemory,
  MindBiography,
  PipelineRun,
  ScheduledTask,
  SelfLedgerRevision,
  TemporalEvent,
  WorldModel,
} from './data';
import {
  buildCuriosityPursuitGraphPrompt,
  finalizePursuedCuriosityAfterGraph,
  resolveCuriosityItemForScheduledPursuit,
  runCuriosityPursuitLlmOnly,
} from './curiosityPursuit';
import {
  buildGoalPursuitGraphPrompt,
  finalizePursuedGoalAfterGraph,
  resolveGoalItemForScheduledPursuit,
  runGoalPursuitLlmOnly,
} from './goalPursuit';
import {
  runGraphPipelineOneShot,
  runGraphPipelineFromScheduledMetacognitionRerun,
  prepareGraphPipelineSseInputs,
  executePreparedGraphPipelineSse,
  persistGraphPipelineStreamResult,
} from './runGraphPipelineOneShot';
import { registerPipelinePauseToken, unregisterPipelinePauseToken } from './pipelineActiveRunRegistry';
import { createPipelinePauseToken } from './pipelinePauseToken';
import {
  beginBackgroundCognitiveWork,
  endBackgroundCognitiveWork,
  isBackgroundCognitiveWorkActive,
  resetLeakedBackgroundCognitiveGate,
} from './pipelineBusyGate';
import { maybeQueueCuriosityPursuitAfterGeneration } from './mindFollowThroughQueue';
import {
  COOPERATIVE_PAUSE_HOLD_SCHEDULER_MESSAGE,
  isCooperativePauseAllExternalHoldActive,
} from './cooperativePauseAllExternalHold';
import { enqueueCognitiveWork } from './cognitiveWorkloadQueue';
import {
  clearPersistedSchedulerHeadlessFlight,
  clearPersistedSchedulerHeadlessFlightIfMatches,
} from './schedulerHeadlessFlightStore';
import { syncDashboardScheduledRunningFromDb } from './dashboardScheduledRunningSync';
import {
  beginSchedulerPipelineUi,
  applySchedulerPipelineUiSse,
  endSchedulerPipelineUi,
  markSchedulerPipelinePausedInUi,
} from './schedulerPipelineUiStore';
import { initialCuriosityPipelineUi, reduceCuriosityPipelineSse } from './curiosityPipelineSseUi';
import { initialGoalPipelineUi } from './goalPipelineSseUi';
import {
  flushCuriosityPursuitsPersistNow,
  upsertCuriosityPursuit,
  patchCuriosityPursuitEntry,
  updateCuriosityPursuitPipelineUiForId,
} from './curiosityPagePursuitStore';
import {
  flushGoalPursuitsPersistNow,
  upsertGoalPursuit,
  patchGoalPagePursuitEntry,
  updateGoalPagePursuitPipelineUiForId,
} from './goalPagePursuitStore';
import { finalizeNewCuriosityRoot } from './curiosityLineage';
import { ensureApiReachable, describeNetworkOrOfflineError } from './apiReachability';
import { clipTextComplete } from '../../shared/textClip.mjs';
import { temporalEventsExcludingPauseNoise } from '../../shared/temporalTimelinePauseFilter.mjs';
import { generateMindBiographyViaLlm, persistMindBiographyVersion } from './mindBiographyLlm.js';
import {
  composeDmnReflectionUserPrompt,
  parseDmnReflectionLLMOutput,
} from './mindDmnContext';

async function fetchScheduler(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(describeNetworkOrOfflineError(e));
  }
}

/** Live SSE → {@link schedulerPipelineUiStore} while a generic scheduled graph task runs. */
function schedulerPipelineUiBridge(task) {
  const id = String(task?.id || '').trim();
  if (!id) {
    return { onSse: undefined, finish: () => {} };
  }
  beginSchedulerPipelineUi(task);
  return {
    onSse: (evt) => applySchedulerPipelineUiSse(evt, id),
    /** @param {unknown} outcome */
    finish: (outcome) => {
      if (isPipelinePauseOutcome(outcome)) {
        markSchedulerPipelinePausedInUi(id, {
          summary: outcome.summary,
          nextModuleName: outcome.executionCursor?.nextModuleName,
        });
      } else {
        endSchedulerPipelineUi(id);
      }
    },
  };
}

const SCHEDULER_PHASE_IDS = new Set(MIND_PHASE_OPTIONS.map((p) => p.id));

const POLL_MS = 5000;
/** Running tasks older than this are treated as crashed tabs and marked failed so the queue can advance. */
const STALE_RUNNING_SCHEDULED_TASK_MS = 20 * 60 * 1000;
let intervalId = null;
/** Mobile browsers throttle background timers; resume polling when the tab is visible or the network returns. */
let visibilityResumeHandler = null;
let onlineResumeHandler = null;
/** Serializes ticks so two intervals never run the same due task. */
let tickLock = false;
/** Task ids handed to {@link enqueueCognitiveWork} but not yet finished (avoids duplicate enqueue while a run is in flight). */
const scheduledWorkEnqueuedIds = new Set();

/** In-flight runs (automatic tick + manual retry): Scheduler “Cancel” / dashboard Stop calls {@link requestAbortScheduledTaskRun}. */
const scheduledTaskRunAbortControllers = new Map();

/**
 * Abort the SSE/fetch leg of a scheduled task if it is in flight (safe no-op otherwise).
 * @param {string} taskId
 */
export function requestAbortScheduledTaskRun(taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) return;
  const ac = scheduledTaskRunAbortControllers.get(id);
  if (!ac) return;
  try {
    ac.abort();
  } catch {
    /* ignore */
  }
}

/**
 * Abort + mark cancelled + drop queue/UI bookkeeping so the scheduler and dashboard stay consistent.
 * Used by Dashboard Stop and Scheduler page Cancel. Safe if the task is not running.
 * @param {string} taskId
 * @param {{ resultSummary?: string }} [opts]
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function stopScheduledTaskRunFromUi(taskId, opts = {}) {
  const id = String(taskId ?? '').trim();
  if (!id) return { ok: false, message: 'Invalid task id.' };
  const result_summary = String(opts.resultSummary ?? 'Stopped from UI.').slice(0, 2000);

  requestAbortScheduledTaskRun(id);
  endSchedulerPipelineUi(id);

  try {
    await ScheduledTask.update(id, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      result_summary,
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  await pruneScheduledWorkEnqueuedIds();
  clearPersistedSchedulerHeadlessFlightIfMatches(id);
  notifyMindStorageChanged({ source: 'scheduled-tasks' });
  await syncDashboardScheduledRunningFromDb();
  return { ok: true, message: 'Scheduled run stopped.' };
}

function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'AbortError') return true;
  return typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError';
}

/** Drop in-memory ids when storage already shows a terminal state (avoids wedging the tick loop). */
async function pruneScheduledWorkEnqueuedIds() {
  if (scheduledWorkEnqueuedIds.size === 0) return;
  for (const id of [...scheduledWorkEnqueuedIds]) {
    try {
      const t = await ScheduledTask.retrieve(id);
      if (!t) {
        scheduledWorkEnqueuedIds.delete(id);
        continue;
      }
      const st = normalizedSchedulerStatus(t.status);
      if (st === 'completed' || st === 'failed' || st === 'cancelled' || st === 'paused') {
        scheduledWorkEnqueuedIds.delete(id);
      }
    } catch {
      scheduledWorkEnqueuedIds.delete(id);
    }
  }
}

/** Thrown when a manual retry cannot start (state changed); must not mark the task failed. */
export class SchedulerRetrySkippedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchedulerRetrySkippedError';
  }
}

function normalizedSchedulerStatus(st) {
  const s = String(st ?? '')
    .trim()
    .toLowerCase();
  if (!s) return 'pending';
  if (s === 'canceled') return 'cancelled';
  return s;
}

/** Canonical status for UI filters and storage checks (pending, running, completed, failed, cancelled). */
export function normalizeSchedulerTaskStatus(st) {
  return normalizedSchedulerStatus(st);
}

/** @param {unknown} st */
export function isSchedulerTaskManuallyRerunnableStatus(st) {
  const s = normalizedSchedulerStatus(st);
  return s === 'failed' || s === 'cancelled';
}

/**
 * True when "Run again" / manual retry is allowed: failed, cancelled, or pending auto-retry rows
 * (requeued after failure; {@link scheduler_retry_attempt} &gt; 0).
 * @param {unknown} task - ScheduledTask row
 */
export function isSchedulerTaskManuallyRerunnable(task) {
  if (!task || typeof task !== 'object') return false;
  const s = normalizedSchedulerStatus(task.status);
  if (s === 'failed' || s === 'cancelled') return true;
  if (s === 'pending' && Number(task.scheduler_retry_attempt) > 0) return true;
  return false;
}

function truncate(s, n) {
  return clipTextComplete(s, n, { ellipsis: true });
}

/**
 * `beginBackgroundCognitiveWork` / `endBackgroundCognitiveWork` can leak after a crash or aborted run.
 * If no row is `running`, reset the in-memory gate so "Run again" and the
 * Dashboard "App (global)" row are not stuck forever. Safe on app startup (no race with in-flight retry).
 */
/** All rows — pending supervisor continuation tasks are often older than the newest N tasks; a capped list leaves them stuck. */
async function listAllScheduledTasksForRunner() {
  return ScheduledTask.listAll('-created_date');
}

export async function healLeakedBackgroundCognitiveGateIfNoRunningTask() {
  if (!isBackgroundCognitiveWorkActive()) return;
  let anyRunning = false;
  try {
    const all = await listAllScheduledTasksForRunner();
    anyRunning = all.some((t) => normalizedSchedulerStatus(t.status) === 'running');
  } catch {
    return;
  }
  if (!anyRunning) {
    resetLeakedBackgroundCognitiveGate('no running ScheduledTask in storage — reset leaked background gate');
  }
}

/** Phase + arousal for scheduled graph / stream runs; falls back to runtime defaults. */
function resolveSchedulerMindOptions(task) {
  const rt = getRuntimeSettings();
  const rawPhase = task?.mind_phase;
  const phase =
    typeof rawPhase === 'string' && SCHEDULER_PHASE_IDS.has(rawPhase)
      ? rawPhase
      : rt.defaultMindPhase || 'focus';
  const defaultArousal = 0.55;
  let arousal = defaultArousal;
  const rawAr = task?.mind_arousal;
  if (typeof rawAr === 'number' && Number.isFinite(rawAr)) {
    arousal = Math.min(1, Math.max(0, rawAr));
  } else if (typeof rawAr === 'string' && rawAr.trim() !== '') {
    const n = Number(rawAr);
    if (!Number.isNaN(n)) arousal = Math.min(1, Math.max(0, n));
  }
  return { phase, arousal };
}

function assertLlmTextOk(text, label) {
  const t = String(text || '');
  if (t.startsWith('API Error:') || t.startsWith('Error:')) {
    throw new Error(`${label}: ${t}`);
  }
  return t;
}

function addCustomInterval(d, n, unit) {
  const x = new Date(d.getTime());
  switch (unit) {
    case 'minutes':
      x.setMinutes(x.getMinutes() + n);
      break;
    case 'hours':
      x.setHours(x.getHours() + n);
      break;
    case 'days':
      x.setDate(x.getDate() + n);
      break;
    case 'weeks':
      x.setDate(x.getDate() + n * 7);
      break;
    case 'months':
      x.setMonth(x.getMonth() + n);
      break;
    default:
      x.setHours(x.getHours() + n);
  }
  return x;
}

function stepRecurrenceFrom(base, task) {
  const r = task.recurrence;
  const interval = Math.max(1, Number(task.recurrence_interval) || 1);
  const unit = task.recurrence_unit || 'hours';
  const x = new Date(base.getTime());
  switch (r) {
    case 'hourly':
      x.setHours(x.getHours() + 1);
      return x;
    case 'daily':
      x.setDate(x.getDate() + 1);
      return x;
    case 'weekly':
      x.setDate(x.getDate() + 7);
      return x;
    case 'monthly':
      x.setMonth(x.getMonth() + 1);
      return x;
    case 'custom':
      return addCustomInterval(x, interval, unit);
    default:
      return null;
  }
}

function computeNextScheduledAt(lastScheduledIso, task) {
  if (!task.recurrence || task.recurrence === 'once') return null;
  let d = new Date(lastScheduledIso);
  if (Number.isNaN(d.getTime())) return null;
  const now = Date.now();
  for (let i = 0; i < 10000; i += 1) {
    d = stepRecurrenceFrom(d, task);
    if (!d || Number.isNaN(d.getTime())) return null;
    if (d.getTime() > now) {
      if (task.recurrence_end_date) {
        const end = new Date(task.recurrence_end_date);
        if (!Number.isNaN(end.getTime()) && d.getTime() > end.getTime()) return null;
      }
      return d;
    }
  }
  return null;
}

async function enqueueRecurrence(completedTask) {
  const next = computeNextScheduledAt(completedTask.scheduled_at, completedTask);
  if (!next) return;

  await ScheduledTask.create({
    task_type: completedTask.task_type,
    status: 'pending',
    scheduled_at: next.toISOString(),
    scheduled_by: completedTask.scheduled_by || 'user',
    reason: completedTask.reason,
    input_text: completedTask.input_text,
    target_curiosity_id: completedTask.target_curiosity_id || undefined,
    target_goal_id: completedTask.target_goal_id || undefined,
    recurrence: completedTask.recurrence,
    recurrence_end_date: completedTask.recurrence_end_date,
    recurrence_interval: completedTask.recurrence_interval,
    recurrence_unit: completedTask.recurrence_unit,
    mind_phase: completedTask.mind_phase,
    mind_arousal: completedTask.mind_arousal,
    schedule_paused: completedTask.schedule_paused === true ? true : undefined,
    metacognition_rerun_attachment_ids: completedTask.metacognition_rerun_attachment_ids,
    metacognition_rerun_slim_shared_memory: completedTask.metacognition_rerun_slim_shared_memory,
    metacognition_rerun_pipeline_options: completedTask.metacognition_rerun_pipeline_options,
    metacognition_rerun_curiosity_pursuit_context: completedTask.metacognition_rerun_curiosity_pursuit_context,
    metacognition_rerun_goal_pursuit_context: completedTask.metacognition_rerun_goal_pursuit_context,
    metacognition_max_reruns_override: completedTask.metacognition_max_reruns_override,
    metacognition_rerun_delay_minutes_override: completedTask.metacognition_rerun_delay_minutes_override,
  });
}

/**
 * Curiosity/goal pursuit payloads for a `supervisor_pipeline_rerun` (or legacy `metacognition_pipeline_rerun`) task: prefer stored JSON
 * contexts; fall back to `target_curiosity_id` / `target_goal_id` (e.g. recurrence copies).
 */
async function resolveMetacognitionRerunPursuitContextsForTask(task) {
  let curiosity =
    task.metacognition_rerun_curiosity_pursuit_context &&
    typeof task.metacognition_rerun_curiosity_pursuit_context === 'object' &&
    String(task.metacognition_rerun_curiosity_pursuit_context.parentCuriosityId || '').trim()
      ? task.metacognition_rerun_curiosity_pursuit_context
      : null;

  if (!curiosity && task.target_curiosity_id) {
    const id = String(task.target_curiosity_id).trim();
    if (id) {
      let root = id;
      try {
        const item = await CuriosityItem.retrieve(id);
        if (item?.root_curiosity_id) root = String(item.root_curiosity_id);
      } catch {
        /* keep root = id */
      }
      curiosity = { parentCuriosityId: id, rootCuriosityId: root };
    }
  }

  let goal =
    task.metacognition_rerun_goal_pursuit_context &&
    typeof task.metacognition_rerun_goal_pursuit_context === 'object' &&
    String(task.metacognition_rerun_goal_pursuit_context.parentGoalId || '').trim()
      ? task.metacognition_rerun_goal_pursuit_context
      : null;

  if (!goal && task.target_goal_id) {
    const id = String(task.target_goal_id).trim();
    if (id) {
      let root = id;
      try {
        const item = await GoalItem.retrieve(id);
        if (item?.root_goal_id) root = String(item.root_goal_id);
      } catch {
        /* keep root = id */
      }
      goal = { parentGoalId: id, rootGoalId: root };
    }
  }

  return { curiosity, goal };
}

async function runGraphPipelineForScheduler(promptText, task = null, abortSignal, onSseEvent, resumeOpts = null) {
  const ro = resumeOpts && typeof resumeOpts === 'object' ? resumeOpts : null;
  const result = await runGraphPipelineOneShot({
    inputText: promptText,
    task: task || { task_type: 'pipeline_run' },
    source: 'scheduled-pipeline',
    curiosityPursuitContext: null,
    acquireGlobalGate: false,
    abortSignal,
    onSseEvent,
    skipApiReachabilityProbe: true,
    mirrorCooperativePauseToGraphSession: false,
    ...(ro?.initialFullSharedMemory != null ? { initialFullSharedMemory: ro.initialFullSharedMemory } : {}),
    ...(ro?.executionResume != null ? { executionResume: ro.executionResume } : {}),
  });
  if (isPipelinePauseOutcome(result)) {
    return {
      pipelinePaused: true,
      summary: result.summary,
      sharedMemory: result.sharedMemory,
      executionCursor: result.executionCursor,
      pipelineRunId: result.pipelineRunId,
    };
  }
  notifyMindStorageChanged({ source: 'pipeline' });
  return result.summary;
}

async function runMetacognitionPipelineRerunScheduled(task, abortSignal, onSseEvent, opts = {}) {
  const { curiosity: ctxC, goal: ctxG } = await resolveMetacognitionRerunPursuitContextsForTask(task);

  const result = await runGraphPipelineFromScheduledMetacognitionRerun({
    task,
    source: 'supervisor-rerun-scheduled',
    curiosityPursuitContext: ctxC,
    goalPursuitContext: ctxG,
    acquireGlobalGate: false,
    abortSignal,
    onSseEvent,
    executionResume: opts.executionResume ?? null,
  });

  if (isPipelinePauseOutcome(result)) {
    return {
      pipelinePaused: true,
      summary: result.summary,
      sharedMemory: result.sharedMemory,
      executionCursor: result.executionCursor,
      pipelineRunId: result.pipelineRunId,
    };
  }

  const voice = resolvePipelineVoiceText({
    voiceOutput: result.voiceText,
    sharedMemory: result.sharedMemory,
  }).trim();

  if (voice && ctxC?.parentCuriosityId) {
    await finalizePursuedCuriosityAfterGraph(String(ctxC.parentCuriosityId), voice, result.pipelineRunId);
    notifyMindStorageChanged({ source: 'curiosity' });
  }
  if (voice && ctxG?.parentGoalId) {
    await finalizePursuedGoalAfterGraph(String(ctxG.parentGoalId), voice, result.pipelineRunId);
    notifyMindStorageChanged({ source: 'goals' });
  }
  notifyMindStorageChanged({ source: 'pipeline' });
  return result.summary;
}

async function runConsciousnessStreamScheduled(
  promptText,
  task = null,
  abortSignal,
  onSseEvent,
  resume = null
) {
  const userInput =
    promptText.trim() ||
    'Scheduled graph pipeline: notice what matters now from recent context, then respond as Voice.';

  const runtimeSettings = getRuntimeSettings();
  const { phase, arousal } = resolveSchedulerMindOptions(task || { task_type: 'consciousness_stream' });

  const prepOpts = {
    inputText: userInput,
    task: task || { task_type: 'consciousness_stream', mind_phase: phase, mind_arousal: arousal },
    mindPhase: phase,
    mindArousal: arousal,
  };
  if (resume?.sharedMemory != null) {
    prepOpts.initialFullSharedMemory = resume.sharedMemory;
  }
  const prep = await prepareGraphPipelineSseInputs(prepOpts);

  const pauseToken = createPipelinePauseToken();
  registerPipelinePauseToken(pauseToken, { kind: 'scheduled-consciousness-stream', id: String(task?.id || '') });
  try {
    const { streamResult, finalNote } = await executePreparedGraphPipelineSse({
      prep,
      fetchImpl: fetchScheduler,
      abortSignal,
      onSseEvent,
      executionResume: resume?.executionResume ?? null,
      pauseSupport: true,
      pauseToken,
      pipelineSource: 'scheduled-consciousness-stream',
      graphSessionIdForPipelineRun: null,
    });

    if (streamResult?.pipelinePaused) {
      return await persistGraphPipelineStreamResult({
        streamResult,
        promptText: userInput,
        runtimeSettings: prep.runtimeSettings,
        source: 'scheduled-consciousness-stream',
        executionPlan: prep.executionPlan,
        curiosityPursuitContext: null,
        goalPursuitContext: null,
        finalOutputForRunRow: finalNote,
      });
    }

    const rawOutputs = streamResult.sharedMemory?.moduleOutputs || {};
    const norm = normalizeModuleOutputsFromServer(rawOutputs);
    const narrativeText = norm.narrative || rawOutputs.Narrative || '';
    const smDone = streamResult.sharedMemory || null;
    const voiceTextRaw = resolvePipelineVoiceText({
      voiceOutput: streamResult.voiceOutput,
      sharedMemory: smDone,
    });
    const { displayText: voiceText } = splitVoiceOutputBeliefRevisionsAppendix(voiceTextRaw);

    if (voiceText) {
      const userMsg = await ConversationMessage.create({
        role: 'user',
        content: userInput,
        attachment_ids: [],
      });

      await ConversationMessage.create({
        role: 'assistant',
        content: voiceText,
        module_outputs: rawOutputs,
        shared_memory: smDone,
        reruns_used: streamResult.rerunsUsed || 0,
        provider_used: streamResult.providerUsed,
        model_used: streamResult.modelUsed,
        reply_to: userMsg.id,
      });
    }

    const runRow = await PipelineRun.create({
      input: userInput,
      module_outputs: rawOutputs,
      shared_memory: smDone,
      execution_plan: ['sse-graph'],
      loop_count: Number(streamResult.rerunsUsed) || 0,
      final_output: finalNote || voiceText || '(no Voice output)',
      runtime_settings: runtimeSettingsForPersistence(runtimeSettings),
      provider_used: streamResult.providerUsed,
      model_used: streamResult.modelUsed,
      source: 'graph-pipeline',
      phase: smDone?.phase,
      arousal: smDone?.arousal,
      intent: smDone?.intent,
      phenomenal_now: smDone?.phenomenalNow || null,
      cognitive_policy: smDone?.cognitivePolicy || null,
    });

    await persistMindAfterPipeline({
      sharedMemory: smDone,
      voiceOutput: voiceText || '',
      narrativeText,
      runtimeSettings,
      source: 'graph-pipeline',
      pipelineRunId: runRow?.id,
    });

    notifyMindStorageChanged({ source: 'graph-pipeline' });
    return truncate(voiceText, 400) || 'Graph pipeline run complete (no Voice text).';
  } finally {
    unregisterPipelinePauseToken(pauseToken);
  }
}

async function runMetacognitionReviewScheduled(task, abortSignal, onSseEvent, resumeOpts = null) {
  const runs = excludeCheckpointPipelineRuns(await PipelineRun.list('-created_date', 15));
  const snippets = [];
  for (const run of runs) {
    const flags = run.shared_memory?.metaCognitionFlags || [];
    for (const f of flags.slice(-4)) {
      snippets.push(`run ${String(run.id).slice(-8)} · rerun ${f.rerunIndex ?? '?'}: ${f.reason || ''}`);
    }
  }
  const ctx =
    snippets.length > 0
      ? snippets.join('\n').slice(0, 4500)
      : 'No supervisor rerun records yet — review overall calibration and confidence habits.';

  const prompt = `[Metacognition review — scheduled]\nRecent rerun / calibration notes:\n${ctx}\n\nWhat should this mind adjust about its reasoning style, confidence, or focus for the next active session? Answer as Voice: concise, actionable.`;
  return runGraphPipelineForScheduler(prompt, task, abortSignal, onSseEvent, resumeOpts);
}

async function runConsolidationScheduled() {
  const text = await runConsolidationPass({ maxTokens: 1000 });
  return truncate(text, 400) || 'Consolidation complete.';
}

async function runEmergenceDetectionScheduled() {
  const runs = excludeCheckpointPipelineRuns(await PipelineRun.list('-created_date', 6));
  let created = 0;
  for (const run of runs) {
    const mo = run.module_outputs || {};
    const sm = run.shared_memory && typeof run.shared_memory === 'object' ? run.shared_memory : {};
    const { markers, evidence_items } = collectPipelineEmergenceMarkers({
      voiceText: run.final_output,
      narrativeText: String(mo.Narrative ?? ''),
      identityText: String(mo.Identity ?? ''),
      dmnText: typeof sm.dmnCarryover === 'string' ? sm.dmnCarryover : '',
    });

    if (markers.length > 0) {
      const severity = markers.length >= 5 ? 'high' : markers.length >= 3 ? 'medium' : 'low';
      await EmergenceEvent.create({
        title: `Emergence markers in run ${run.id.slice(-6)}`,
        details: `Detected: ${markers.join(', ')}`,
        severity,
        pipeline_run_id: run.id,
        signal_type: 'emergence_heuristic',
        evidence_items,
        review_status: 'pending',
        reviewed: false,
      });
      created += 1;
    }
  }
  notifyMindStorageChanged({ source: 'emergence' });
  return `Scanned ${runs.length} run(s); logged ${created} emergence event(s).`;
}

async function runCognitiveHealthSnapshotScheduled() {
  const [runs, beliefs, memories, curios, goals, dreams, feedback] = await Promise.all([
    PipelineRun.list('-created_date', 200),
    BeliefStore.list('-created_date', 200),
    LongTermMemory.list('-created_date', 200),
    CuriosityItem.list('-created_date', 200),
    GoalItem.list('-created_date', 200),
    DreamRun.list('-created_date', 200),
    FeedbackItem.list('-created_date', 200),
  ]);

  const metrics = {
    runCount: runs.length,
    beliefCount: beliefs.length,
    memoryCount: memories.length,
    openCuriosity: curios.filter((item) => (item.status || 'open') !== 'resolved').length,
    openGoals: goals.filter((g) => {
      const s = g.status || 'open';
      return s === 'open' || s === 'pursuing' || s === 'dormant';
    }).length,
    dreamCount: dreams.length,
    thumbsUp: feedback.filter((f) => f.rating === 'up').length,
    thumbsDown: feedback.filter((f) => f.rating === 'down').length,
  };

  const summary = assertLlmTextOk(
    await llmService.InvokeLLM({
      prompt: `Write a brief cognitive health note (3–6 sentences) for the mind's owner. Use these local stats; be concrete and mention any imbalance (e.g. curiosity backlog, few runs, feedback skew).\n\n${JSON.stringify(metrics, null, 2)}`,
      temperature: 0.5,
      max_tokens: 450,
    }),
    'Health snapshot'
  );

  await TemporalEvent.create({
    title: 'Cognitive health snapshot',
    details: summary,
    source: 'scheduled-health',
  });
  notifyMindStorageChanged({ source: 'temporal' });
  return truncate(summary, 400);
}

async function runTemporalReflectionScheduled() {
  const [eventsRaw, runsRaw, beliefs] = await Promise.all([
    TemporalEvent.list('-created_date', 25),
    PipelineRun.list('-created_date', 8),
    BeliefStore.list('-created_date', 15),
  ]);
  const events = temporalEventsExcludingPauseNoise(eventsRaw);
  const runs = excludeCheckpointPipelineRuns(runsRaw);

  const result = await invokeLLM({
    prompt: `You are the mind's temporal self-model. Given recent timeline events, pipeline voice excerpts, and beliefs, respond with JSON only.

TIMELINE:
${events.map((e) => `- ${e.title}: ${truncate(e.details, 140)}`).join('\n').slice(0, 3500)}

RECENT VOICE SNIPPETS:
${runs
  .map((r) => truncate(r.final_output, 200))
  .filter(Boolean)
  .join('\n')
  .slice(0, 2500)}

BELIEFS:
${beliefs.map((b) => `- ${b.statement}`).join('\n').slice(0, 1500)}

Return JSON with: now (one sentence), threads (array of 2 short strings), milestone_title (string), milestone_details (string, optional paragraph).`,
    response_json_schema: {
      type: 'object',
      properties: {
        now: { type: 'string' },
        threads: { type: 'array', items: { type: 'string' } },
        milestone_title: { type: 'string' },
        milestone_details: { type: 'string' },
      },
    },
  });

  const mtitle = result.milestone_title || 'Scheduled temporal reflection';
  const threads = Array.isArray(result.threads) ? result.threads : [];
  const mdet = [
    result.now,
    ...threads.map((t) => `- ${t}`),
    result.milestone_details || '',
  ]
    .filter(Boolean)
    .join('\n');

  await TemporalEvent.create({
    title: mtitle.slice(0, 200),
    details: mdet.slice(0, 4000),
    source: 'scheduled-temporal',
  });
  notifyMindStorageChanged({ source: 'temporal' });
  return truncate(result.now, 400);
}

async function runMemorySynthesisScheduled() {
  const mems = await LongTermMemory.list('-created_date', 20);
  if (mems.length === 0) return 'No memories to synthesize.';

  const result = await invokeLLM({
    prompt: `Synthesize cross-cutting themes from these memory notes. Return JSON with "title" (short) and "integration" (2–4 paragraphs weaving themes together).

MEMORIES:
${mems.map((m) => `- ${m.title}: ${truncate(m.content, 220)}`).join('\n').slice(0, 6000)}`,
    response_json_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        integration: { type: 'string' },
      },
    },
  });

  await LongTermMemory.create({
    title: result.title || 'Integrated reflection',
    content: result.integration || '',
    memory_type: 'semantic',
    source: 'scheduled-memory-synthesis',
  });
  notifyMindStorageChanged({ source: 'memory' });
  return truncate(result.integration, 400);
}

async function runDreamingScheduled() {
  const [memories, beliefs] = await Promise.all([
    LongTermMemory.list('-created_date', 6),
    BeliefStore.list('-created_date', 6),
  ]);
  const dreamText = assertLlmTextOk(
    await llmService.InvokeLLM({
      prompt: `Enter a dreaming mode. Recombine these memories and beliefs into a surreal but useful reflection.\n\nMemories:\n${memories.map((m) => `- ${m.title}: ${truncate(m.content, 120)}`).join('\n')}\n\nBeliefs:\n${beliefs.map((b) => `- ${b.statement}`).join('\n')}`,
      max_tokens: 500,
    }),
    'Dreaming'
  );
  await DreamRun.create({ output: dreamText });
  await LongTermMemory.create({
    title: `Dream synthesis ${new Date().toLocaleString()}`,
    content: dreamText,
    memory_type: 'dream',
    source: 'scheduled-dreaming',
  });
  notifyMindStorageChanged({ source: 'dreams' });
  return truncate(dreamText, 400);
}

async function runBeliefExtractionScheduled() {
  return mergeBeliefsFromRecentPipelineRuns();
}

async function runBeliefTensionReviewScheduled(task, abortSignal, onSseEvent, resumeOpts = null) {
  const tensions = await BeliefTension.filter({ tension_state: 'active' }, '-created_date', 28);
  if (!tensions.length) return 'No active belief tensions — skipped.';

  const beliefs = await BeliefStore.filter({ status: 'active' }, '-created_date', 22);
  const tLines = tensions
    .map((t) => `- ${String(t.description || '').trim().slice(0, 520)}`)
    .join('\n');
  const bLines =
    beliefs.length > 0
      ? beliefs.map((b) => `- "${String(b.statement || b.title || '').slice(0, 220)}"`).join('\n')
      : '(none in active filter — see full Belief Store in context from shared memory on server)';

  const prompt = `[Belief tension review — scheduled]
Active tensions (Belief Map):
${tLines}

Active beliefs (sample):
${bLines}

This mind is reviewing its own contradictions. Work through what can be reconciled, what should stay unresolved for now, and what would change the stance or confidence on related beliefs. Answer as Voice: first person, honest, actionable.`;

  return runGraphPipelineForScheduler(prompt, task, abortSignal, onSseEvent, resumeOpts);
}

async function countCuriosityPursuitsCompletedToday() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const tasks = await ScheduledTask.list('-created_date', 160);
  return tasks.filter(
    (x) =>
      x.task_type === 'curiosity_pursuit' &&
      x.status === 'completed' &&
      x.completed_at &&
      new Date(x.completed_at).getTime() >= t0
  ).length;
}

async function countGoalPursuitsCompletedToday() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  const tasks = await ScheduledTask.list('-created_date', 160);
  return tasks.filter(
    (x) =>
      x.task_type === 'goal_pursuit' &&
      x.status === 'completed' &&
      x.completed_at &&
      new Date(x.completed_at).getTime() >= t0
  ).length;
}

async function runGoalPursuitScheduled(task, abortSignal, onSseEvent, resume = null) {
  const rt = getRuntimeSettings();
  const maxPerDay = Number(rt.goalPursuitMaxPerDay);
  if (Number.isFinite(maxPerDay) && maxPerDay > 0) {
    const done = await countGoalPursuitsCompletedToday();
    if (done >= maxPerDay) {
      return `Goal pursuit daily cap (${maxPerDay}) reached — skipped.`;
    }
  }

  const resolved = await resolveGoalItemForScheduledPursuit(task);
  if (!resolved.item) {
    return resolved.message || 'No open or dormant goal items — skipped.';
  }
  const item = resolved.item;

  await GoalItem.update(item.id, { status: 'pursuing' });
  notifyMindStorageChanged({ source: 'goals' });

  try {
    if (rt.goalPursuitUseGraphPipeline === true) {
      const gid = item.id;
      upsertGoalPursuit(gid, {
        running: true,
        interruptedByReload: false,
        cooperativePaused: false,
        pursuitProgress: resume ? 'Resuming…' : 'Starting…',
        goalPipelineUi: initialGoalPipelineUi(),
        goalStatement: String(item.goal_statement || '').trim() || undefined,
      });
      let cooperativeGraphPaused = false;
      try {
        const prompt = buildGoalPursuitGraphPrompt(item);
        const rootId = item.root_goal_id || item.id;
        const combinedOnSse = (evt) => {
          try {
            onSseEvent?.(evt);
          } catch (e) {
            console.warn('[runGoalPursuitScheduled] onSseEvent', e);
          }
          updateGoalPagePursuitPipelineUiForId(gid, (prev) => reduceCuriosityPipelineSse(prev, evt));
        };
        const result = await runGraphPipelineOneShot({
          inputText: prompt,
          task,
          source: 'scheduled-goal-pursuit',
          goalPursuitContext: {
            parentGoalId: item.id,
            rootGoalId: rootId,
          },
          acquireGlobalGate: false,
          abortSignal,
          onSseEvent: combinedOnSse,
          skipApiReachabilityProbe: true,
          mirrorCooperativePauseToGraphSession: false,
          ...(resume?.sharedMemory != null ? { initialFullSharedMemory: resume.sharedMemory } : {}),
          ...(resume?.executionResume != null ? { executionResume: resume.executionResume } : {}),
        });
        if (isPipelinePauseOutcome(result)) {
          cooperativeGraphPaused = true;
          return {
            pipelinePaused: true,
            summary: result.summary,
            sharedMemory: result.sharedMemory,
            executionCursor: result.executionCursor,
            pipelineRunId: result.pipelineRunId,
          };
        }
        if (!result.voiceDeferredToScheduledSupervisor) {
          await finalizePursuedGoalAfterGraph(item.id, result.voiceText, result.pipelineRunId);
        }
        notifyMindStorageChanged({ source: 'goals' });
        return result.summary || truncate(result.voiceText, 400) || 'Goal pursuit (graph) complete.';
      } finally {
        if (cooperativeGraphPaused) {
          patchGoalPagePursuitEntry(gid, {
            running: false,
            interruptedByReload: false,
            cooperativePaused: true,
            pursuitProgress: 'Paused — cooperative checkpoint saved. Open Goals to continue.',
          });
          flushGoalPursuitsPersistNow();
        } else {
          patchGoalPagePursuitEntry(gid, {
            running: false,
            pursuitProgress: null,
            interruptedByReload: false,
            cooperativePaused: false,
          });
        }
      }
    }

    return runGoalPursuitLlmOnly(item);
  } catch (err) {
    try {
      await GoalItem.update(item.id, { status: 'open' });
      notifyMindStorageChanged({ source: 'goals' });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function runCuriosityPursuitScheduled(task, abortSignal, onSseEvent, resume = null) {
  const rt = getRuntimeSettings();
  const maxPerDay = Number(rt.curiosityPursuitMaxPerDay);
  if (Number.isFinite(maxPerDay) && maxPerDay > 0) {
    const done = await countCuriosityPursuitsCompletedToday();
    if (done >= maxPerDay) {
      return `Curiosity pursuit daily cap (${maxPerDay}) reached — skipped.`;
    }
  }

  const resolved = await resolveCuriosityItemForScheduledPursuit(task);
  if (!resolved.item) {
    return resolved.message || 'No open or dormant curiosity items — skipped.';
  }
  const item = resolved.item;

  await CuriosityItem.update(item.id, { status: 'pursuing' });
  notifyMindStorageChanged({ source: 'curiosity' });

  try {
    if (rt.curiosityPursuitUseGraphPipeline === true) {
      const cid = item.id;
      upsertCuriosityPursuit(cid, {
        running: true,
        interruptedByReload: false,
        cooperativePaused: false,
        pursuitProgress: resume ? 'Resuming…' : 'Starting…',
        curiosityPipelineUi: initialCuriosityPipelineUi(),
        question: String(item.question || '').trim() || undefined,
      });
      let cooperativeGraphPaused = false;
      try {
        const prompt = buildCuriosityPursuitGraphPrompt(item);
        const rootId = item.root_curiosity_id || item.id;
        const combinedOnSse = (evt) => {
          try {
            onSseEvent?.(evt);
          } catch (e) {
            console.warn('[runCuriosityPursuitScheduled] onSseEvent', e);
          }
          updateCuriosityPursuitPipelineUiForId(cid, (prev) => reduceCuriosityPipelineSse(prev, evt));
        };
        const result = await runGraphPipelineOneShot({
          inputText: prompt,
          task,
          source: 'scheduled-curiosity-pursuit',
          curiosityPursuitContext: {
            parentCuriosityId: item.id,
            rootCuriosityId: rootId,
          },
          acquireGlobalGate: false,
          abortSignal,
          onSseEvent: combinedOnSse,
          skipApiReachabilityProbe: true,
          mirrorCooperativePauseToGraphSession: false,
          ...(resume?.sharedMemory != null ? { initialFullSharedMemory: resume.sharedMemory } : {}),
          ...(resume?.executionResume != null ? { executionResume: resume.executionResume } : {}),
        });
        if (isPipelinePauseOutcome(result)) {
          cooperativeGraphPaused = true;
          return {
            pipelinePaused: true,
            summary: result.summary,
            sharedMemory: result.sharedMemory,
            executionCursor: result.executionCursor,
            pipelineRunId: result.pipelineRunId,
          };
        }
        if (!result.voiceDeferredToScheduledSupervisor) {
          await finalizePursuedCuriosityAfterGraph(item.id, result.voiceText, result.pipelineRunId);
        }
        notifyMindStorageChanged({ source: 'curiosity' });
        return result.summary || truncate(result.voiceText, 400) || 'Curiosity pursuit (graph) complete.';
      } finally {
        if (cooperativeGraphPaused) {
          patchCuriosityPursuitEntry(cid, {
            running: false,
            interruptedByReload: false,
            cooperativePaused: true,
            pursuitProgress: 'Paused — cooperative checkpoint saved. Open Curiosity to continue.',
          });
          flushCuriosityPursuitsPersistNow();
        } else {
          patchCuriosityPursuitEntry(cid, {
            running: false,
            pursuitProgress: null,
            interruptedByReload: false,
            cooperativePaused: false,
          });
        }
      }
    }

    return runCuriosityPursuitLlmOnly(item);
  } catch (err) {
    try {
      await CuriosityItem.update(item.id, { status: 'open' });
      notifyMindStorageChanged({ source: 'curiosity' });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function runCuriosityGenerationScheduled() {
  const runs = excludeCheckpointPipelineRuns(await PipelineRun.list('-created_date', 4));
  if (runs.length === 0) return 'No pipeline runs — skipped curiosity generation.';

  const result = await invokeLLM({
    prompt: `Generate 4 concise curiosity questions based on these recent cognitive outputs. Return JSON with an array called items; each item has "question" and optional "priority" (0.0–1.0). Spread priorities — do not set every item to 0.5; at least one should be clearly higher and one lower when the content supports it.\n\n${runs.map((run) => run.final_output).filter(Boolean).join('\n\n')}`,
    response_json_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              priority: { type: 'number' },
            },
          },
        },
      },
    },
  });

  const list = Array.isArray(result)
    ? result
    : result.items || result.curiosities || [];
  let n = 0;
  for (const item of list) {
    const q = String(item?.question || '').trim();
    if (!q) continue;
    const priority =
      typeof item.priority === 'number' && !Number.isNaN(item.priority)
        ? clampPriority(item.priority, DEFAULT_MANUAL_LIKE_PRIORITY)
        : DEFAULT_MANUAL_LIKE_PRIORITY;
    const created = await CuriosityItem.create({
      question: q,
      pursuit_thread: String(item?.pursuit_thread || '').trim(),
      status: 'open',
      source: 'scheduled-llm',
      priority,
      times_returned_to: 0,
    });
    try {
      await finalizeNewCuriosityRoot(created);
    } catch {
      /* ignore */
    }
    n += 1;
  }
  notifyMindStorageChanged({ source: 'curiosity' });
  await maybeQueueCuriosityPursuitAfterGeneration();
  return `Added ${n} curiosity questions.`;
}

async function runBiographyScheduled() {
  const prevBioList = await MindBiography.list('-created_date', 1);
  const prevBio = prevBioList[0];

  const gen = await generateMindBiographyViaLlm(prevBio, {});

  await persistMindBiographyVersion({
    sessionNumber: gen.sessionNumber,
    fullText: gen.fullText,
    summary: gen.summary,
    keywords: gen.keywords,
    values: gen.values,
    changes: gen.changes,
    memoriesCount: gen.memoriesCount,
    beliefCount: gen.beliefCount,
    sessionId: gen.runs[0]?.id || 'scheduled',
    source: 'scheduled-biography',
  });

  return truncate(gen.summary || gen.fullText, 400);
}

async function runDmnReflectionScheduled() {
  const { prompt, systemPrompt } = await composeDmnReflectionUserPrompt();
  const raw = assertLlmTextOk(
    await llmService.InvokeLLM({
      prompt,
      systemPrompt,
      temperature: 0.7,
      max_tokens: 2200,
    }),
    'DMN reflection'
  );
  const p = parseDmnReflectionLLMOutput(raw);
  const fullCombined = clipTextComplete(p.fullCombined, 12_000, { ellipsis: true });
  const summaryLine = clipTextComplete(p.continuityThread || p.internalNarrative || raw, 500, {
    ellipsis: true,
  });

  await SelfLedgerRevision.create({
    reason: 'dmn_internal_narrative',
    summary: summaryLine,
    identity_excerpt: clipTextComplete(fullCombined, 8000, { ellipsis: true }),
    phase: 'drift',
  });

  await LongTermMemory.create({
    title: `DMN reflection ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    content: fullCombined,
    memory_type: 'dmn',
    source: 'scheduled-dmn',
  });

  await TemporalEvent.create({
    title: 'dmn_reflection',
    details: clipTextComplete(
      [summaryLine, p.embodiedAnchor ? `Embodied: ${p.embodiedAnchor}` : ''].filter(Boolean).join('\n\n'),
      3500,
      { ellipsis: true }
    ),
    source: 'scheduled-dmn',
  });

  notifyMindStorageChanged({ source: 'dmn-reflection' });
  return truncate(summaryLine, 400);
}

async function runWorldModelScheduled() {
  const [runsRaw, beliefs, memories, eventsRaw, items] = await Promise.all([
    PipelineRun.list('-created_date', 6),
    BeliefStore.list('-created_date', 20),
    LongTermMemory.list('-created_date', 12),
    TemporalEvent.list('-created_date', 20),
    WorldModel.list('-updated_date', 100),
  ]);
  const runs = excludeCheckpointPipelineRuns(runsRaw);
  const events = temporalEventsExcludingPauseNoise(eventsRaw);

  const result = await invokeLLM({
    prompt: `Build/upgrade a structured world model for this mind.

You have:
- Recent Voice outputs (pipeline runs)
- Existing world model items (do not duplicate; update/merge if needed)
- Recent beliefs
- Recent long-term memories
- Significant timeline events

Return JSON with an array "items". Each item MUST include:
- name (string, short label)
- category: self | environment | relationship | goal | belief | event (legacy plural names OK)
- description (string, concrete)
- value (optional string)
- confidence (number 0-1)
- evidence (string, cite which sources support it: runs/beliefs/memories/events)

RECENT VOICE OUTPUTS:
${runs.map((run) => run.final_output).filter(Boolean).join('\n\n').slice(0, 5000)}

EXISTING WORLD MODEL ITEMS:
${items.map((i) => `- [${i.category}] ${i.name}: ${i.description}`).join('\n').slice(0, 2500)}

RECENT BELIEFS:
${beliefs.map((b) => `- ${b.statement} (conf ${b.confidence ?? 0.5})`).join('\n').slice(0, 2500)}

RECENT MEMORIES:
${memories.map((m) => `- ${m.title}: ${truncate(m.content, 140)}`).join('\n').slice(0, 2500)}

TIMELINE EVENTS:
${events.map((e) => `- ${e.title}: ${truncate(e.details, 140)}`).join('\n').slice(0, 2500)}
`,
    response_json_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              label: { type: 'string' },
              category: { type: 'string' },
              description: { type: 'string' },
              value: { type: 'string' },
              confidence: { type: 'number' },
              evidence: { type: 'string' },
            },
          },
        },
      },
    },
  });

  let created = 0;
  let updated = 0;
  let current = [...items];
  for (const raw of result.items || []) {
    const llmLabel = String(raw.label || raw.name || '').trim();
    if (!llmLabel) continue;
    const canon = normalizeWorldModelCategory(raw.category);
    const key = stableWorldModelKey(canon, llmLabel);
    const existing = current.find((r) => itemKeyForRecord(r) === key);
    if (existing) {
      const patch = buildWorldModelUpdatePayload(
        existing,
        {
          description: raw.description,
          confidence: raw.confidence,
          evidence: raw.evidence,
          value: raw.value,
          category: canon,
          label: llmLabel,
          name: llmLabel,
          key,
          last_updated_by: 'scheduled-world-model',
        },
        'scheduled-world-model',
        'Scheduled world-model refresh'
      );
      const rec = await WorldModel.update(existing.id, patch);
      if (rec) {
        const ix = current.findIndex((r) => r.id === existing.id);
        if (ix >= 0) current[ix] = rec;
      }
      updated += 1;
    } else {
      const rec = await WorldModel.create(
        buildWorldModelCreatePayload({
          category: canon,
          label: llmLabel,
          description: raw.description,
          value: raw.value,
          confidence: raw.confidence,
          last_updated_by: 'scheduled-world-model',
          evidence: raw.evidence,
          history: [
            newWorldModelHistoryEntry({
              source: 'scheduled-world-model',
              description: raw.description,
              value: raw.value,
              confidence: raw.confidence,
              evidence: raw.evidence,
              note: 'Created by scheduled world-model task',
            }),
          ],
        })
      );
      current.push(rec);
      created += 1;
    }
  }
  notifyMindStorageChanged({ source: 'world-model' });
  return `World model: ${created} created, ${updated} updated.`;
}

async function performScheduledTask(task, { abortSignal } = {}) {
  /** One probe for every scheduled path (LLM-only + graph): flaky mobile Wi‑Fi / LAN; avoids duplicate inner probes via skipApiReachabilityProbe. */
  await ensureApiReachable({
    timeoutMs: 15_000,
    retries: 2,
    retryDelayMs: 500,
    signal: abortSignal,
  });

  const reason = task.reason || '';
  const input = task.input_text || '';

  switch (task.task_type) {
    case 'pipeline_run': {
      const prompt =
        input.trim() ||
        'Scheduled autonomous pipeline run. Integrate recent context and produce a concise Voice summary.';
      const b = schedulerPipelineUiBridge(task);
      let outcome;
      try {
        outcome = await runGraphPipelineForScheduler(prompt, task, abortSignal, b.onSse);
        return outcome;
      } finally {
        b.finish(outcome);
      }
    }
    case 'pipeline_classic': {
      const prompt =
        input.trim() ||
        'Scheduled graph pipeline run (legacy task type was classic sequential; now uses SSE graph pipeline).';
      const merged = { ...task, task_type: 'pipeline_run' };
      const b = schedulerPipelineUiBridge(task);
      let outcome;
      try {
        outcome = await runGraphPipelineForScheduler(prompt, merged, abortSignal, b.onSse);
        return outcome;
      } finally {
        b.finish(outcome);
      }
    }
    case 'consciousness_stream': {
      const b = schedulerPipelineUiBridge(task);
      let outcome;
      try {
        outcome = await runConsciousnessStreamScheduled(input, task, abortSignal, b.onSse);
        return outcome;
      } finally {
        b.finish(outcome);
      }
    }
    case 'supervisor_pipeline_rerun':
    case 'metacognition_pipeline_rerun': {
      const b = schedulerPipelineUiBridge(task);
      let outcome;
      try {
        outcome = await runMetacognitionPipelineRerunScheduled(task, abortSignal, b.onSse);
        return outcome;
      } finally {
        b.finish(outcome);
      }
    }
    case 'metacognition_review': {
      const b = schedulerPipelineUiBridge(task);
      let outcome;
      try {
        outcome = await runMetacognitionReviewScheduled(task, abortSignal, b.onSse);
        return outcome;
      } finally {
        b.finish(outcome);
      }
    }
    case 'belief_tension_review': {
      const b = schedulerPipelineUiBridge(task);
      let outcome;
      try {
        outcome = await runBeliefTensionReviewScheduled(task, abortSignal, b.onSse);
        return outcome;
      } finally {
        b.finish(outcome);
      }
    }
    case 'curiosity_pursuit': {
      const b = schedulerPipelineUiBridge(task);
      let outcome;
      try {
        outcome = await runCuriosityPursuitScheduled(task, abortSignal, b.onSse);
        return outcome;
      } finally {
        b.finish(outcome);
      }
    }
    case 'goal_pursuit': {
      const b = schedulerPipelineUiBridge(task);
      let outcome;
      try {
        outcome = await runGoalPursuitScheduled(task, abortSignal, b.onSse);
        return outcome;
      } finally {
        b.finish(outcome);
      }
    }
    case 'diagnostic': {
      const prompt = `[Scheduled diagnostic] ${reason || 'Review recent cognitive state, internal consistency, and open curiosity. Note anomalies and suggest focus for the next session.'}`;
      const b = schedulerPipelineUiBridge(task);
      let outcome;
      try {
        outcome = await runGraphPipelineForScheduler(prompt, task, abortSignal, b.onSse);
        return outcome;
      } finally {
        b.finish(outcome);
      }
    }
    case 'multi_mind_debate':
      return (
        'multi_mind_debate was removed — use Graph Pipeline or Playground. Delete or disable this scheduled task.'
      );
    case 'consolidation_pass':
      return runConsolidationScheduled();
    case 'dreaming':
      return runDreamingScheduled();
    case 'belief_extraction':
      return runBeliefExtractionScheduled();
    case 'curiosity_generation':
      return runCuriosityGenerationScheduled();
    case 'biography_update':
      return runBiographyScheduled();
    case 'dmn_reflection':
      return runDmnReflectionScheduled();
    case 'world_model_update':
      return runWorldModelScheduled();
    case 'memory_synthesis':
      return runMemorySynthesisScheduled();
    case 'temporal_reflection':
      return runTemporalReflectionScheduled();
    case 'cognitive_health_snapshot':
      return runCognitiveHealthSnapshotScheduled();
    case 'emergence_detection':
      return runEmergenceDetectionScheduled();
    default:
      throw new Error(`Unknown task type: ${task.task_type}`);
  }
}

/**
 * When true, the automatic due-task loop skips this row until resumed (manual "Run again" still allowed where applicable).
 * @param {unknown} task
 */
export function isScheduledTaskSchedulePaused(task) {
  return !!(task && typeof task === 'object' && task.schedule_paused === true);
}

function isDuePendingTask(t) {
  if (!t.task_type) return false;
  if (normalizedSchedulerStatus(t.status) !== 'pending') return false;
  if (isScheduledTaskSchedulePaused(t)) return false;
  if (!t.scheduled_at) return false;
  return new Date(t.scheduled_at).getTime() <= Date.now();
}

export async function recoverStaleRunningScheduledTasks() {
  try {
    const all = await listAllScheduledTasksForRunner();
    const now = Date.now();
    for (const t of all) {
      if (normalizedSchedulerStatus(t.status) !== 'running') continue;
      const started = t.run_started_at ? new Date(t.run_started_at).getTime() : 0;
      if (!Number.isFinite(started) || started <= 0) continue;
      if (now - started < STALE_RUNNING_SCHEDULED_TASK_MS) continue;
      const staleMsg =
        'Run exceeded ~20 minutes without completion (or the tab closed before completion). Open Scheduler and use Run again if you still need this job.';
      const summarizedStale = tagScheduledTaskFailureSummary(staleMsg).slice(0, 2000);
      const requeued = await maybeRequeueFailedScheduledTask(t.id, summarizedStale, t);
      if (!requeued) {
        await ScheduledTask.update(t.id, {
          status: 'failed',
          result_summary: summarizedStale,
          completed_at: new Date().toISOString(),
        });
      }
      scheduledWorkEnqueuedIds.delete(String(t.id));
      notifyMindStorageChanged({ source: 'scheduled-tasks' });
      await syncDashboardScheduledRunningFromDb();
      console.warn(
        requeued ? '[scheduler] stale running task requeued for auto-retry' : '[scheduler] stale running task marked failed',
        t.id,
        t.task_type
      );
    }
  } catch (e) {
    console.warn('[scheduler] stale running recovery failed', e);
  }
}

async function completeScheduledTaskIfStillValid(taskId, originalTask, summary) {
  const latest = await ScheduledTask.retrieve(taskId);
  if (!latest || normalizedSchedulerStatus(latest.status) === 'cancelled') {
    notifyMindStorageChanged({ source: 'scheduled-tasks' });
    return;
  }
  if (isPipelinePauseOutcome(summary)) {
    await ScheduledTask.update(taskId, {
      status: 'paused',
      result_summary: String(summary.summary || 'Pipeline paused cooperatively.').slice(0, 2000),
      pipeline_checkpoint_shared_memory: summary.sharedMemory ?? null,
      pipeline_checkpoint_execution_resume: summary.executionCursor ?? null,
      pipeline_checkpoint_pipeline_run_id: summary.pipelineRunId ?? null,
      completed_at: null,
      run_started_at: null,
    });
    notifyMindStorageChanged({ source: 'scheduled-tasks' });
    await syncDashboardScheduledRunningFromDb();
    return;
  }
  await ScheduledTask.update(taskId, {
    status: 'completed',
    result_summary: String(summary).slice(0, 2000),
    completed_at: new Date().toISOString(),
    scheduler_retry_attempt: 0,
    pipeline_checkpoint_shared_memory: null,
    pipeline_checkpoint_execution_resume: null,
    pipeline_checkpoint_pipeline_run_id: null,
  });
  await enqueueRecurrence(originalTask);
  notifyMindStorageChanged({ source: 'scheduled-tasks' });
}

const RESUMABLE_PAUSED_GRAPH_TYPES = new Set([
  'pipeline_run',
  'pipeline_classic',
  'consciousness_stream',
  'supervisor_pipeline_rerun',
  'metacognition_pipeline_rerun',
  'metacognition_review',
  'belief_tension_review',
  'diagnostic',
  'curiosity_pursuit',
  'goal_pursuit',
]);

async function resumePausedScheduledTaskBody(task, sharedMemory, executionResume, abortSignal, onSseEvent) {
  const input = String(task.input_text || '').trim();
  const reason = String(task.reason || '');
  const resumeOpts =
    sharedMemory && typeof sharedMemory === 'object' && executionResume && typeof executionResume === 'object'
      ? { initialFullSharedMemory: sharedMemory, executionResume }
      : null;
  if (!resumeOpts) {
    throw new Error('Invalid checkpoint on paused task.');
  }

  switch (task.task_type) {
    case 'pipeline_run': {
      const prompt =
        input ||
        'Scheduled autonomous pipeline run. Integrate recent context and produce a concise Voice summary.';
      return runGraphPipelineForScheduler(prompt, task, abortSignal, onSseEvent, resumeOpts);
    }
    case 'pipeline_classic': {
      const prompt =
        input ||
        'Scheduled graph pipeline run (legacy task type was classic sequential; now uses SSE graph pipeline).';
      const merged = { ...task, task_type: 'pipeline_run' };
      return runGraphPipelineForScheduler(prompt, merged, abortSignal, onSseEvent, resumeOpts);
    }
    case 'consciousness_stream':
      return runConsciousnessStreamScheduled(input, task, abortSignal, onSseEvent, {
        sharedMemory,
        executionResume,
      });
    case 'supervisor_pipeline_rerun':
    case 'metacognition_pipeline_rerun': {
      const merged = { ...task, metacognition_rerun_slim_shared_memory: sharedMemory };
      return runMetacognitionPipelineRerunScheduled(merged, abortSignal, onSseEvent, { executionResume });
    }
    case 'metacognition_review':
      return runMetacognitionReviewScheduled(task, abortSignal, onSseEvent, resumeOpts);
    case 'belief_tension_review':
      return runBeliefTensionReviewScheduled(task, abortSignal, onSseEvent, resumeOpts);
    case 'diagnostic': {
      const prompt = `[Scheduled diagnostic] ${reason || 'Review recent cognitive state, internal consistency, and open curiosity. Note anomalies and suggest focus for the next session.'}`;
      return runGraphPipelineForScheduler(prompt, task, abortSignal, onSseEvent, resumeOpts);
    }
    case 'curiosity_pursuit':
      return runCuriosityPursuitScheduled(task, abortSignal, onSseEvent, {
        sharedMemory,
        executionResume,
      });
    case 'goal_pursuit':
      return runGoalPursuitScheduled(task, abortSignal, onSseEvent, {
        sharedMemory,
        executionResume,
      });
    default:
      throw new Error(`Cannot resume paused task type: ${task.task_type}`);
  }
}

/** Paused graph-related scheduler rows that store a cooperative checkpoint. */
export async function listPausedScheduledGraphTasks() {
  const all = await listAllScheduledTasksForRunner();
  return all.filter(
    (t) =>
      normalizedSchedulerStatus(t.status) === 'paused' &&
      RESUMABLE_PAUSED_GRAPH_TYPES.has(String(t.task_type || ''))
  );
}

/**
 * Continue a cooperative-pause checkpoint stored on the ScheduledTask row (Inspector / Scheduler).
 * @param {string} taskId
 */
export async function resumePausedScheduledPipelineTask(taskId) {
  if (typeof window === 'undefined') {
    throw new Error('Resume is only available in the browser.');
  }
  const id = String(taskId ?? '').trim();
  if (!id) throw new Error('Invalid task id.');

  if (isCooperativePauseAllExternalHoldActive()) {
    throw new Error(COOPERATIVE_PAUSE_HOLD_SCHEDULER_MESSAGE);
  }

  await pruneScheduledWorkEnqueuedIds();
  if (scheduledWorkEnqueuedIds.has(id)) {
    throw new Error('This task is already running or queued.');
  }

  let t;
  try {
    t = await ScheduledTask.retrieve(id);
  } catch (e) {
    console.warn('[scheduler] retrieve failed (resume)', e);
    throw new Error('Could not load this task.');
  }
  if (!t || normalizedSchedulerStatus(t.status) !== 'paused') {
    throw new Error('Only paused graph tasks with a saved checkpoint can be resumed from here.');
  }
  if (!RESUMABLE_PAUSED_GRAPH_TYPES.has(String(t.task_type || ''))) {
    throw new Error('This paused task type does not support graph resume.');
  }
  const sm = t.pipeline_checkpoint_shared_memory;
  const er = t.pipeline_checkpoint_execution_resume;
  if (!sm || typeof sm !== 'object' || !er || typeof er !== 'object') {
    throw new Error('This task has no resumable checkpoint data.');
  }

  scheduledWorkEnqueuedIds.add(id);
  const ac = new AbortController();
  scheduledTaskRunAbortControllers.set(id, ac);
  beginBackgroundCognitiveWork();
  let persistedFlightTaskId = null;
  try {
    await ScheduledTask.update(id, {
      status: 'running',
      run_started_at: new Date().toISOString(),
    });
    persistedFlightTaskId = id;
    await syncDashboardScheduledRunningFromDb();
    notifyMindStorageChanged({ source: 'scheduled-tasks' });

    const b = schedulerPipelineUiBridge(t);
    let outcome;
    try {
      outcome = await resumePausedScheduledTaskBody(t, sm, er, ac.signal, b.onSse);
    } finally {
      b.finish(outcome);
    }
    await completeScheduledTaskIfStillValid(id, t, outcome);
  } catch (err) {
    await persistScheduledTaskRunFailure(id, err, 'resume paused task failed');
    if (!isAbortError(err)) throw err;
  } finally {
    if (scheduledTaskRunAbortControllers.get(id) === ac) {
      scheduledTaskRunAbortControllers.delete(id);
    }
    if (persistedFlightTaskId) clearPersistedSchedulerHeadlessFlightIfMatches(persistedFlightTaskId);
    endBackgroundCognitiveWork();
    scheduledWorkEnqueuedIds.delete(id);
    await syncDashboardScheduledRunningFromDb();
  }
}

/**
 * @param {string} taskId
 * @param {string} summarizedBase
 * @param {object|null} [latestRow] - If omitted, row is loaded from DB.
 * @returns {Promise<boolean>}
 */
async function maybeRequeueFailedScheduledTask(taskId, summarizedBase, latestRow = null) {
  let latestForFailure = latestRow;
  if (!latestForFailure) {
    try {
      latestForFailure = await ScheduledTask.retrieve(taskId);
    } catch {
      return false;
    }
  }
  if (!latestForFailure || normalizedSchedulerStatus(latestForFailure.status) === 'cancelled') {
    return false;
  }
  const rt = getRuntimeSettings();
  if (!shouldAutoRetryTask(latestForFailure, rt)) return false;
  const nextAttempt = (Number(latestForFailure.scheduler_retry_attempt) || 0) + 1;
  const unlimited = rt.schedulerAutoRetryUnlimited !== false;
  const max = Math.max(0, Math.floor(Number(rt.schedulerAutoRetryMaxAttempts) ?? 10));
  const base = Math.max(1, Math.floor(Number(rt.schedulerAutoRetryBaseDelayMinutes) || 5));
  const maxDelay = Math.max(base, Math.floor(Number(rt.schedulerAutoRetryMaxDelayMinutes) || 60));
  const scheduledAt = computeNextBackoffIso(nextAttempt, base, maxDelay);
  const when = new Date(scheduledAt).toLocaleString();
  const retryTag = unlimited
    ? `Auto-retry #${nextAttempt} (ongoing) scheduled for ${when}.`
    : `Auto-retry ${nextAttempt}/${max} scheduled for ${when}.`;
  const summary = `${String(summarizedBase).slice(0, 1800)}\n\n${retryTag}`;
  try {
    await ScheduledTask.update(taskId, {
      status: 'pending',
      scheduled_at: scheduledAt,
      scheduler_retry_attempt: nextAttempt,
      run_started_at: null,
      completed_at: null,
      result_summary: summary.slice(0, 2000),
    });
  } catch (e2) {
    console.warn('[scheduler] failed to persist failure requeue', e2);
    return false;
  }
  return true;
}

async function persistScheduledTaskRunFailure(taskId, err, logLabel) {
  if (isAbortError(err)) {
    try {
      const latest = await ScheduledTask.retrieve(taskId);
      if (latest && normalizedSchedulerStatus(latest.status) === 'cancelled') {
        notifyMindStorageChanged({ source: 'scheduled-tasks' });
        return;
      }
      if (latest && normalizedSchedulerStatus(latest.status) === 'running') {
        await ScheduledTask.update(taskId, {
          status: 'cancelled',
          result_summary: 'Stopped during run.',
          completed_at: new Date().toISOString(),
        });
      }
    } catch (e2) {
      console.warn(`[scheduler] ${logLabel} abort/cancel persist failed`, e2);
    }
    notifyMindStorageChanged({ source: 'scheduled-tasks' });
    return;
  }

  let latestForFailure = null;
  try {
    latestForFailure = await ScheduledTask.retrieve(taskId);
    if (latestForFailure && normalizedSchedulerStatus(latestForFailure.status) === 'cancelled') {
      notifyMindStorageChanged({ source: 'scheduled-tasks' });
      return;
    }
  } catch {
    /* ignore */
  }

  const taskType = latestForFailure?.task_type != null ? String(latestForFailure.task_type) : '';
  console.error(`[scheduler] ${logLabel}`, { taskId, taskType, err });
  const msg = err instanceof Error ? err.message : String(err);
  const summarized = tagScheduledTaskFailureSummary(appendRateLimitRecoveryHint(msg)).slice(0, 2000);
  const requeued = await maybeRequeueFailedScheduledTask(taskId, summarized, latestForFailure);
  if (!requeued) {
    try {
      await ScheduledTask.update(taskId, {
        status: 'failed',
        result_summary: summarized,
        completed_at: new Date().toISOString(),
      });
    } catch (e2) {
      console.warn('[scheduler] failed to persist failure state', e2);
    }
  }
  notifyMindStorageChanged({ source: 'scheduled-tasks' });
}

/**
 * Re-run a task that ended in `failed`, was `cancelled`, or is `pending` after auto-retry requeue.
 * Resolves when the run finishes (success or failure). Rejects if the task is not rerunnable or is already queued.
 * @param {string} taskId
 * @returns {Promise<void>}
 */
async function executeManualScheduledTaskRetryBody(taskId) {
  const ac = new AbortController();
  scheduledTaskRunAbortControllers.set(taskId, ac);
  beginBackgroundCognitiveWork();
  let persistedFlightTaskId = null;
  try {
    const t = await ScheduledTask.retrieve(taskId);
    if (!t) {
      throw new SchedulerRetrySkippedError('This scheduled task no longer exists.');
    }
    if (!isSchedulerTaskManuallyRerunnable(t)) {
      throw new SchedulerRetrySkippedError(
        `Task status changed before start (${t.status || 'unknown'}). Refresh the scheduler list.`
      );
    }
    if (!t.task_type) {
      throw new SchedulerRetrySkippedError(
        'This task has no task type (legacy or corrupt row). Remove it and schedule a new task.'
      );
    }

    console.info('[scheduler] manual rerun', taskId, t.task_type, t.status);
    const runStartedAt = new Date().toISOString();
    await ScheduledTask.update(taskId, {
      status: 'running',
      run_started_at: runStartedAt,
      scheduler_retry_attempt: 0,
    });
    await syncDashboardScheduledRunningFromDb();
    notifyMindStorageChanged({ source: 'scheduled-tasks' });
    persistedFlightTaskId = taskId;
    const summary = await performScheduledTask(t, { abortSignal: ac.signal });
    await completeScheduledTaskIfStillValid(taskId, t, summary);
  } catch (err) {
    if (err instanceof SchedulerRetrySkippedError) {
      notifyMindStorageChanged({ source: 'scheduled-tasks' });
      throw err;
    }
    await persistScheduledTaskRunFailure(taskId, err, 'retry task failed');
    if (!isAbortError(err)) throw err;
  } finally {
    if (scheduledTaskRunAbortControllers.get(taskId) === ac) {
      scheduledTaskRunAbortControllers.delete(taskId);
    }
    if (persistedFlightTaskId) clearPersistedSchedulerHeadlessFlightIfMatches(persistedFlightTaskId);
    endBackgroundCognitiveWork();
    scheduledWorkEnqueuedIds.delete(taskId);
    await syncDashboardScheduledRunningFromDb();
  }
}

/**
 * Re-run a task that ended in `failed`, was `cancelled`, or is `pending` after auto-retry requeue.
 * Runs outside {@link enqueueCognitiveWork} so it is not tied to the automatic due-task loop.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function retryFailedScheduledTask(id) {
  if (typeof window === 'undefined') {
    throw new Error('Scheduled task retry is only available in the browser.');
  }
  const taskId = String(id ?? '').trim();
  if (!taskId) {
    throw new Error('Invalid task id.');
  }

  await pruneScheduledWorkEnqueuedIds();

  if (scheduledWorkEnqueuedIds.has(taskId)) {
    throw new Error('This task is already running or queued.');
  }
  if (isCooperativePauseAllExternalHoldActive()) {
    throw new Error(COOPERATIVE_PAUSE_HOLD_SCHEDULER_MESSAGE);
  }
  let probe;
  try {
    probe = await ScheduledTask.retrieve(taskId);
  } catch (e) {
    console.warn('[scheduler] retrieve failed (retry)', e);
    throw new Error('Could not load this task.');
  }
  if (!probe || !isSchedulerTaskManuallyRerunnable(probe)) {
    throw new Error(
      'Only failed, cancelled, or auto-retry pending tasks can be run again.'
    );
  }

  await healLeakedBackgroundCognitiveGateIfNoRunningTask();

  scheduledWorkEnqueuedIds.add(taskId);
  try {
    await executeManualScheduledTaskRetryBody(taskId);
  } catch (err) {
    scheduledWorkEnqueuedIds.delete(taskId);
    if (err instanceof SchedulerRetrySkippedError) {
      throw err;
    }
    console.error('[scheduler] manual retry error', taskId, err);
    throw err;
  }
}

async function tick() {
  if (tickLock || typeof window === 'undefined') return;
  tickLock = true;

  try {
    await pruneScheduledWorkEnqueuedIds();
    await recoverStaleRunningScheduledTasks();
    await syncDashboardScheduledRunningFromDb();

    let dueList;
    try {
      const all = await listAllScheduledTasksForRunner();
      dueList = all.filter(isDuePendingTask).sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
    } catch (e) {
      console.warn('[scheduler] list failed', e);
      return;
    }

    if (isCooperativePauseAllExternalHoldActive()) {
      return;
    }

    for (const task of dueList) {
      let fresh;
      try {
        fresh = await ScheduledTask.retrieve(task.id);
      } catch (e) {
        console.warn('[scheduler] retrieve failed', e);
        continue;
      }

      if (!fresh || normalizedSchedulerStatus(fresh.status) !== 'pending') continue;

      const id = String(fresh.id ?? '').trim();
      if (!id) continue;
      if (scheduledWorkEnqueuedIds.has(id)) continue;
      scheduledWorkEnqueuedIds.add(id);

      void enqueueCognitiveWork(async () => {
        const ac = new AbortController();
        let persistedFlightTaskId = null;
        let heldGate = false;
        try {
          const t = await ScheduledTask.retrieve(id);
          if (!t || normalizedSchedulerStatus(t.status) !== 'pending') return;

          scheduledTaskRunAbortControllers.set(id, ac);
          beginBackgroundCognitiveWork();
          heldGate = true;

          console.info('[scheduler] running', id, t.task_type);
          const runStartedAt = new Date().toISOString();
          await ScheduledTask.update(id, {
            status: 'running',
            run_started_at: runStartedAt,
          });
          persistedFlightTaskId = id;
          await syncDashboardScheduledRunningFromDb();
          notifyMindStorageChanged({ source: 'scheduled-tasks' });
          const summary = await performScheduledTask(t, { abortSignal: ac.signal });
          await completeScheduledTaskIfStillValid(id, t, summary);
        } catch (err) {
          if (heldGate) await persistScheduledTaskRunFailure(id, err, 'task failed');
        } finally {
          if (scheduledTaskRunAbortControllers.get(id) === ac) {
            scheduledTaskRunAbortControllers.delete(id);
          }
          if (persistedFlightTaskId) clearPersistedSchedulerHeadlessFlightIfMatches(persistedFlightTaskId);
          if (heldGate) endBackgroundCognitiveWork();
          scheduledWorkEnqueuedIds.delete(id);
          await syncDashboardScheduledRunningFromDb();
        }
      }).catch((err) => {
        console.error('[scheduler] cognitive queue error', id, err);
        scheduledWorkEnqueuedIds.delete(id);
        void syncDashboardScheduledRunningFromDb();
      });
    }
  } finally {
    tickLock = false;
  }
}

/**
 * Run one scheduler pass immediately (prune, due pending → enqueue). Used after clearing the cooperative-pause
 * hold so queued work does not wait for the polling interval.
 */
export async function flushSchedulerDueTasksNow() {
  await tick();
}

export function startScheduledTaskRunner() {
  if (typeof window === 'undefined') return;
  if (intervalId != null) return;
  void (async () => {
    clearPersistedSchedulerHeadlessFlight();
    await recoverStaleRunningScheduledTasks();
    await healLeakedBackgroundCognitiveGateIfNoRunningTask();
    await syncDashboardScheduledRunningFromDb();
    void tick();
  })();
  intervalId = window.setInterval(() => void tick(), POLL_MS);

  if (typeof document !== 'undefined' && visibilityResumeHandler == null) {
    visibilityResumeHandler = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', visibilityResumeHandler);
  }
  if (onlineResumeHandler == null) {
    onlineResumeHandler = () => void tick();
    window.addEventListener('online', onlineResumeHandler);
  }
}

export function stopScheduledTaskRunner() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (typeof document !== 'undefined' && visibilityResumeHandler != null) {
    document.removeEventListener('visibilitychange', visibilityResumeHandler);
    visibilityResumeHandler = null;
  }
  if (onlineResumeHandler != null) {
    window.removeEventListener('online', onlineResumeHandler);
    onlineResumeHandler = null;
  }
}
