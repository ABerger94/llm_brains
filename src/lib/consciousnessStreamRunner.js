import { ConversationMessage, PipelineRun } from './data';
import { consumePipelineSseWithMetacognitionContinuations, appendRateLimitRecoveryHint } from './pipelineSse';
import { stringifyUnknownError } from './pipelineRunErrorFormat';
import { openrouterPipelineOptions } from './llmClientOptions';
import {
  getRuntimeSettings,
  effectiveMaxMetacognitionReruns,
  effectiveMetacognitionRerunDelayMinutes,
  runtimeSettingsForPersistence,
} from './runtimeSettings';
import { pickContinuationSharedMemoryFromFetched } from './pipelineContinuationSeed';
import { pickLatestNonCheckpointPipelineRun } from './pipelineRunCheckpoint';
import { enqueueMetacognitionPipelineRerunSchedule } from './scheduleMetacognitionPipelineRerun';
import {
  persistMindAfterPipeline,
  loadStructuralSelfForPipeline,
  buildWorkingMemorySeed,
} from './mindPersistence';
import { slimSharedMemoryForPipelinePost } from './slimSharedMemory';
import { resolvePipelineVoiceText } from './pipelineVoiceGate';
import { splitVoiceOutputBeliefRevisionsAppendix } from '../../shared/beliefRevisionsVoice.mjs';
import { rowsToRecentDialogue } from './pipelineDialogueContext';
import { streamModuleThoughts } from './streamModuleThoughts';
import { ensureApiReachable, describeNetworkOrOfflineError } from './apiReachability';
import { postUploadAttachments } from './uploadImagesApi';
import {
  loadGraphPipelineClientContext,
  logGraphPipelineContextLoaded,
} from './persistedMindStoresForPipeline';
import {
  graphPipelineStore,
  repairCooperativePipelineCheckpoint,
  validCooperativePipelineCheckpoint,
} from './graphPipelineStore';
import { buildGraphPipelineRunContextLabel } from './graphPipelineRunTopic';
import { isInteractiveGraphOrStreamActive } from './pipelineBusyGate';
import {
  backendModuleNameToUiId,
  resolvePipelineModuleUiIdForStream,
  mergeModuleOutputsPreferLonger,
  normalizeModuleOutputsFromServer,
  sseModuleCompleteOutputText,
} from './cognitiveModules';
import {
  applyModuleStartToStatuses,
  reconcileCompleteStatusesFromOutputs,
} from './pipelineModuleStatusUi';
import { consciousnessStreamStore } from './consciousnessStreamStore';
import { formatMetaCalibration } from './conversationStreamEntries';
import { getGraphSessionIdForPersistence } from './graphPipelineSessionScope';
import { filterConversationRowsForGraphSession, filterPipelineRunsForGraphSession } from './graphPipelineConversation';
import { scheduleIncrementalModuleCheckpointPersist } from './incrementalModuleCheckpointPersist';
import { patchGraphPipelineSessionIfInRegistry, upsertGraphPipelineSession } from './graphPipelineSessionRegistry';
import { loadDmnCarryoverTextForPhase } from './mindDmnContext';
import { buildPriorPredictionAuditPayload } from './priorPredictionAudit';
import { toast } from '../components/ui';
import {
  registerPipelinePauseToken,
  unregisterPipelinePauseToken,
} from './pipelineActiveRunRegistry';
import { createPipelinePauseToken } from './pipelinePauseToken';
import { safeJsonStringifyPipelineBody } from './safeJsonStringify.js';

function fetchWithNetworkMessage(url, init) {
  return fetch(url, init).catch((e) => {
    throw new Error(describeNetworkOrOfflineError(e));
  });
}

async function uploadPendingFiles(files) {
  return postUploadAttachments(files);
}

/** Ref-like: read paused from store each tick */
function getPaused() {
  return consciousnessStreamStore.getState().paused;
}

let runSeq = 0;
/** @type {AbortController | null} */
let streamAbortController = null;
/** Session id for the in-flight interactive graph/stream run (for dashboard Stop + cross-session rows). */
let activeConsciousnessStreamGraphSessionId = null;

/**
 * Run sequences that have been "backgrounded" (user switched to a different
 * session while the SSE was still in flight).  A backgrounded run continues
 * its fetch to completion and persists results, but skips all in-memory store
 * patches so it doesn't clobber the newly-active session's UI.
 *
 * Maps run seq number → the sessionId that run belongs to, so hydration and
 * busy-gate logic can detect sessions with in-flight background work.
 * @type {Map<number, string>}
 */
const backgroundedRuns = new Map();

/** @returns {string | null} */
export function getActiveConsciousnessStreamGraphSessionId() {
  return activeConsciousnessStreamGraphSessionId;
}

/** True when an interactive SSE fetch is in flight (AbortController exists). */
export function isInteractiveStreamFetchAlive() {
  return streamAbortController !== null;
}

/**
 * Detach the current interactive run from the global stores without aborting
 * the SSE fetch.  The run continues in the background: events are silently
 * consumed, results are persisted with the original graphSid, and the session
 * registry is updated when the run completes.
 *
 * Call this instead of {@link abortActiveConsciousnessStreamRun} when the user
 * switches to a different graph-pipeline session and the old run should keep
 * going.
 */
export function backgroundCurrentInteractiveRun() {
  if (!streamAbortController) return;
  backgroundedRuns.set(runSeq, activeConsciousnessStreamGraphSessionId || '');
  streamAbortController = null;
  activeConsciousnessStreamGraphSessionId = null;
}

/**
 * True when a backgrounded (detached) SSE run is still completing for the
 * given session.  Used by hydration and busy-gate to avoid clobbering in-flight work.
 */
export function isBackgroundedRunAliveForSession(sessionId) {
  for (const sid of backgroundedRuns.values()) {
    if (sid === sessionId) return true;
  }
  return false;
}

function appendStoppedToGraphLog() {
  const prev = graphPipelineStore.getState().executionLog || [];
  graphPipelineStore.patch({
    executionLog: [...prev, { time: Date.now(), msg: 'Pipeline stopped.' }],
  });
}

/**
 * Abort the interactive graph pipeline SSE (Graph Pipeline page) and clear running flags.
 */
export function abortActiveConsciousnessStreamRun() {
  const gp = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();
  const busy = Boolean(gp.isRunning || cs.isProcessing);
  if (!busy) return;
  const sid = activeConsciousnessStreamGraphSessionId;
  const prev = streamAbortController;
  streamAbortController = null;
  if (prev) {
    try {
      prev.abort();
    } catch {
      /* ignore */
    }
  }
  runSeq += 1;
  activeConsciousnessStreamGraphSessionId = null;
  if (sid) {
    patchGraphPipelineSessionIfInRegistry({ id: sid, isProcessing: false });
  }
  consciousnessStreamStore.patch({ isProcessing: false, runInterrupted: false, activeRunTopic: '' });
  consciousnessStreamStore.clearDraftPersist();
  consciousnessStreamStore.appendEntry('system', 'Pipeline stopped.', null, { bypassPause: true });
  graphPipelineStore.patch({ isRunning: false, uploading: false, runError: null, cooperativePauseToken: null });
  graphPipelineStore.flushPersist();
  appendStoppedToGraphLog();
}

function applyModuleStartToExecutionGraph(uiId) {
  const st = graphPipelineStore.getState();
  graphPipelineStore.patch({
    moduleStatuses: applyModuleStartToStatuses(st.moduleStatuses || {}, uiId),
  });
}

function addGraphExecutionLog(msg, detail) {
  const trimmed = detail != null && String(detail).trim() ? String(detail).trim() : undefined;
  const prev = graphPipelineStore.getState().executionLog || [];
  graphPipelineStore.patch({
    executionLog: [...prev, { time: Date.now(), msg, ...(trimmed ? { detail: trimmed } : {}) }],
  });
}

/**
 * @param {{
 *   pendingFiles?: File[],
 *   reconnectResume?: boolean,
 *   resumeUserInput?: string,
 *   resumeFromCheckpoint?: boolean,
 *   curiosityPursuitContext?: { parentCuriosityId: string, rootCuriosityId: string } | null,
 *   goalPursuitContext?: { parentGoalId: string, rootGoalId: string } | null,
 * }} opts
 */
export async function startConsciousnessStreamRun(opts = {}) {
  const pendingFiles = opts.pendingFiles || [];
  const reconnectResume = opts.reconnectResume === true;
  const resumeFromCheckpoint = opts.resumeFromCheckpoint === true;
  const curiosityPursuitContext =
    opts.curiosityPursuitContext && typeof opts.curiosityPursuitContext === 'object'
      ? opts.curiosityPursuitContext
      : null;
  const goalPursuitContext =
    opts.goalPursuitContext && typeof opts.goalPursuitContext === 'object' ? opts.goalPursuitContext : null;
  const snap = consciousnessStreamStore.getState();
  if (isInteractiveGraphOrStreamActive()) return;

  const graphSidEarly = getGraphSessionIdForPersistence();
  if (isBackgroundedRunAliveForSession(graphSidEarly)) return;

  const gpSnap = graphPipelineStore.getState();
  const rawCk = gpSnap.pipelineCheckpoint;
  const ck =
    resumeFromCheckpoint
      ? validCooperativePipelineCheckpoint(rawCk) ||
        repairCooperativePipelineCheckpoint(rawCk, gpSnap.lastSharedMemory)
      : null;
  const hasCk = Boolean(ck);

  let userInput = '';
  if (reconnectResume) {
    const explicit = String(opts.resumeUserInput || '').trim();
    if (explicit) userInput = explicit;
    else {
      const ent = snap.entries || [];
      for (let i = ent.length - 1; i >= 0; i -= 1) {
        const row = ent[i];
        if (row?.type === 'user-input' && String(row.content || '').trim()) {
          userInput = String(row.content).trim();
          break;
        }
      }
      if (!userInput) userInput = String(snap.input || '').trim();
    }
  } else if (hasCk) {
    userInput = String(ck.userInput || '').trim();
    if (!userInput) userInput = String(snap.input || '').trim();
  } else {
    userInput = String(snap.input || '').trim();
  }

  const attachments = snap.attachments || [];
  const ckAttachmentIds =
    hasCk && Array.isArray(ck.attachmentIds) ? ck.attachmentIds.map((id) => String(id)).filter(Boolean) : [];

  if (
    !userInput &&
    pendingFiles.length === 0 &&
    attachments.length === 0 &&
    !(resumeFromCheckpoint && hasCk)
  ) {
    return;
  }

  const mySeq = ++runSeq;
  streamAbortController = new AbortController();

  const graphSid = getGraphSessionIdForPersistence();
  activeConsciousnessStreamGraphSessionId = graphSid;

  const pauseToken = createPipelinePauseToken();
  registerPipelinePauseToken(pauseToken, { kind: 'interactive', id: graphSid });

  const { mindPhase: phase0, arousal: ar0, streamIntent: intent0 } = consciousnessStreamStore.getState();
  const runTopic = buildGraphPipelineRunContextLabel(userInput, attachments, pendingFiles.length);
  /** Registry “latest run” label + IndexedDB row; kept in sync after file upload refines the topic. */
  let registryRunTopic = runTopic;

  upsertGraphPipelineSession({
    id: graphSid,
    label: registryRunTopic.slice(0, 160) || 'Graph session',
    seedFirstThreadLabel: true,
    isProcessing: true,
  });

  graphPipelineStore.patch({
    isRunning: true,
    cooperativePauseToken: pauseToken,
    runError: null,
    runInterrupted: false,
    ...(hasCk
      ? {
          moduleStatuses: ck.moduleStatusesSnapshot || {},
          moduleOutputs: ck.moduleOutputsSnapshot || {},
          lastLlmProvider: graphPipelineStore.getState().lastLlmProvider,
          lastLlmModel: graphPipelineStore.getState().lastLlmModel,
          executionLog: [
            ...(graphPipelineStore.getState().executionLog || []),
            { time: Date.now(), msg: 'Resuming from saved checkpoint…' },
          ],
          loopCount: graphPipelineStore.getState().loopCount ?? 0,
          finalOutput: graphPipelineStore.getState().finalOutput || '',
        }
      : {
          moduleStatuses: {},
          moduleOutputs: {},
          lastLlmProvider: null,
          lastLlmModel: null,
          executionLog: [],
          loopCount: 0,
          finalOutput: '',
          pipelineCheckpoint: null,
        }),
    mindPhase: phase0,
    arousal: ar0,
    intent: String(intent0 || '').trim(),
    runContextLabel: runTopic,
  });
  graphPipelineStore.flushPersist();
  if (hasCk) {
    graphPipelineStore.patch({ pipelineCheckpoint: null });
  }

  consciousnessStreamStore.patch({
    isProcessing: true,
    input: '',
    runInterrupted: false,
    activeRunTopic: runTopic,
    paused: false,
  });

  if (hasCk) {
    consciousnessStreamStore.appendEntry('system', 'Resuming paused pipeline from checkpoint…', null, {
      bypassPause: true,
    });
    addGraphExecutionLog('Resuming paused pipeline from checkpoint…');
  } else if (reconnectResume) {
    consciousnessStreamStore.appendEntry('system', 'Resuming pipeline after reconnect…', null, {
      bypassPause: true,
    });
    addGraphExecutionLog('Resuming pipeline after reconnect…');
  } else {
    consciousnessStreamStore.appendEntry('user-input', userInput, null, { bypassPause: true });
    consciousnessStreamStore.appendEntry('system', 'Starting full-stack cognitive pipeline (SSE)…', null, {
      bypassPause: true,
    });
    addGraphExecutionLog('Starting full-stack cognitive pipeline (SSE)…');
  }

  const pausedRef = { get current() { return getPaused(); } };

  const startTime = Date.now();

  try {
    await ensureApiReachable({ timeoutMs: 5000, retries: 2, retryDelayMs: 400 });
    const clientCtx = await loadGraphPipelineClientContext(userInput);
    const { mindStores, recentTemporalEvents } = clientCtx;
    logGraphPipelineContextLoaded(clientCtx, (msg, detail) => {
      consciousnessStreamStore.appendEntry('system', msg, null, { bypassPause: true });
      addGraphExecutionLog(msg, detail);
    });

    const [allMsgs, allRuns] = await Promise.all([
      ConversationMessage.list('-created_date', 320),
      PipelineRun.list('-created_date', 24),
    ]);
    const recentMsgs = filterConversationRowsForGraphSession(allMsgs, graphSid).slice(0, 32);
    const latestRuns = filterPipelineRunsForGraphSession(allRuns, graphSid);
    const recentDialogue = rowsToRecentDialogue(recentMsgs, 16);
    const continueMemory = hasCk
      ? ck.slimSharedMemory
      : pickContinuationSharedMemoryFromFetched({
          latestPipelineRun: pickLatestNonCheckpointPipelineRun(latestRuns),
          recentConversationMessages: recentMsgs,
        });
    const executionResumeOpt = hasCk ? ck.executionCursor : null;

    let uploaded = attachments;
    if (pendingFiles.length > 0) {
      graphPipelineStore.patch({ uploading: true });
      consciousnessStreamStore.appendEntry('system', `Uploading ${pendingFiles.length} file(s)…`, null, {
        bypassPause: true,
      });
      addGraphExecutionLog(`Uploading ${pendingFiles.length} file(s)…`);
      const newOnes = await uploadPendingFiles(pendingFiles);
      uploaded = [...attachments, ...newOnes];
      consciousnessStreamStore.patch({ attachments: uploaded });
      const afterUploadTopic = buildGraphPipelineRunContextLabel(userInput, uploaded, 0);
      registryRunTopic = afterUploadTopic;
      upsertGraphPipelineSession({
        id: graphSid,
        label: registryRunTopic.slice(0, 160) || 'Graph session',
        seedFirstThreadLabel: true,
        isProcessing: true,
      });
      graphPipelineStore.patch({
        attachments: uploaded,
        uploading: false,
        runContextLabel: afterUploadTopic,
      });
      consciousnessStreamStore.patch({ activeRunTopic: afterUploadTopic });
      consciousnessStreamStore.appendEntry('system', `Uploaded ${newOnes.length} file(s).`, null, {
        bypassPause: true,
      });
      addGraphExecutionLog(`Uploaded ${newOnes.length} file(s).`);
    }

    const uploadedIds = uploaded.map((a) => a.id);
    const attachmentIds =
      ckAttachmentIds.length > 0
        ? [...ckAttachmentIds, ...uploadedIds.filter((id) => !ckAttachmentIds.includes(id))]
        : uploadedIds;
    consciousnessStreamStore.appendEntry('system', 'Streaming module progress from server…', null, {
      bypassPause: true,
    });
    addGraphExecutionLog('Streaming module progress from server…');

    const runtimeSettings = getRuntimeSettings();
    // Match prepareGraphPipelineSseInputs: avoid a high max_tokens floor (was ≥2048) that swells shared memory and breaks Learning ingest.
    const maxTokens = Number(runtimeSettings.pipelineMaxTokens) || 800;
    const { mindPhase, arousal: storeArousal, streamIntent } = consciousnessStreamStore.getState();
    const continueAr =
      typeof continueMemory?.arousal === 'number' && Number.isFinite(continueMemory.arousal)
        ? continueMemory.arousal
        : null;
    const arousal = continueAr ?? storeArousal;

    const structuralSelf = await loadStructuralSelfForPipeline({ maxItems: 12 });
    const wmSeed = buildWorkingMemorySeed(userInput, runtimeSettings.pinnedWorkingMemory || []);
    const dmnCarryover = await loadDmnCarryoverTextForPhase(mindPhase);
    const priorPredictionAudit = buildPriorPredictionAuditPayload(continueMemory, userInput);

    const pmo = graphPipelineStore.getState().pipelineMetacognitionOverrides || {
      maxMetacognitionReruns: null,
      metacognitionRerunDelayMinutes: null,
    };
    const delayMin = effectiveMetacognitionRerunDelayMinutes(
      runtimeSettings,
      pmo.metacognitionRerunDelayMinutes
    );
    const pipelineOptionsSnapshot = {
      max_tokens: maxTokens,
      temperature: 0.55,
      phase: mindPhase,
      arousal,
      intent: String(streamIntent || '').trim(),
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
      maxMetacognitionReruns: effectiveMaxMetacognitionReruns(runtimeSettings, pmo.maxMetacognitionReruns),
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

    let streamResult;
    let voiceUiChain = Promise.resolve();
    let sawWouldRerunEvent = false;

    streamResult = await consumePipelineSseWithMetacognitionContinuations({
      fetchImpl: fetchWithNetworkMessage,
      abortSignal: streamAbortController?.signal,
      initialSlimSharedMemory: slimSharedMemoryForPipelinePost(continueMemory, {
        continuation: !!executionResumeOpt,
      }),
      buildFetchInit: ({ slimSharedMemory, pipelineMetacognitionContinuation, leg }) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: safeJsonStringifyPipelineBody({
          input: userInput,
          attachmentIds,
          sharedMemory: slimSharedMemory,
          pauseToken,
          pauseSupport: true,
          options: {
            ...pipelineOptionsSnapshot,
            ...(pipelineMetacognitionContinuation ? { pipelineMetacognitionContinuation: true } : {}),
            ...(!pipelineMetacognitionContinuation ? { deferMetacognitionRerun: true } : {}),
            ...(leg === 1 && executionResumeOpt && !pipelineMetacognitionContinuation
              ? { executionResume: executionResumeOpt }
              : {}),
            pauseSupport: true,
            pauseToken,
          },
        }),
      }),
      onEvent: async (evt) => {
        if (backgroundedRuns.has(mySeq)) return;
        if (mySeq !== runSeq) return;
        if (evt.type === 'module_start') {
          const mappedStart = backendModuleNameToUiId(evt.moduleName);
          const uiId = resolvePipelineModuleUiIdForStream(evt.moduleName);
          const streamModuleExtra = {
            bypassPause: true,
            ...(!mappedStart && evt.layer ? { pipelineLayerKey: evt.layer } : {}),
            ...(!mappedStart ? { moduleName: String(evt.moduleName || '') } : {}),
          };
          applyModuleStartToExecutionGraph(uiId);
          consciousnessStreamStore.appendEntry(
            'module-start',
            `${evt.moduleName} activating…`,
            uiId,
            streamModuleExtra
          );
          addGraphExecutionLog(`→ ${evt.moduleName} started (${evt.layer})`);
        } else if (evt.type === 'module_complete') {
          if (typeof evt.arousalEffective === 'number' && Number.isFinite(evt.arousalEffective)) {
            consciousnessStreamStore.patch({ arousal: evt.arousalEffective });
          }
          const mappedMc = backendModuleNameToUiId(evt.moduleName);
          const uiId = resolvePipelineModuleUiIdForStream(evt.moduleName);
          const streamModuleExtra = {
            bypassPause: true,
            ...(!mappedMc && evt.layer ? { pipelineLayerKey: evt.layer } : {}),
            ...(!mappedMc ? { moduleName: String(evt.moduleName || '') } : {}),
          };
          const stMc = graphPipelineStore.getState();
          const pieceStr = sseModuleCompleteOutputText(evt);
          /** @type {Record<string, unknown>} */
          const graphPatch = {};
          if (uiId) {
            graphPatch.moduleStatuses = { ...(stMc.moduleStatuses || {}), [uiId]: 'complete' };
            graphPatch.moduleOutputs =
              pieceStr !== null
                ? { ...(stMc.moduleOutputs || {}), [uiId]: pieceStr }
                : { ...(stMc.moduleOutputs || {}) };
          }
          if (Object.keys(graphPatch).length) graphPipelineStore.patch(graphPatch);
          const stAfterModule = graphPipelineStore.getState();
          if (
            evt.executionCheckpoint &&
            evt.sharedMemory &&
            pipelineOptionsSnapshot.incrementalModuleCheckpoint !== false
          ) {
            graphPipelineStore.patch({
              pipelineCheckpoint: {
                savedAt: Date.now(),
                executionCursor: evt.executionCheckpoint,
                slimSharedMemory: evt.sharedMemory,
                moduleOutputsSnapshot: { ...(stAfterModule.moduleOutputs || {}) },
                moduleStatusesSnapshot: { ...(stAfterModule.moduleStatuses || {}) },
                userInput,
                attachmentIds,
              },
            });
            graphPipelineStore.flushPersist();
            scheduleIncrementalModuleCheckpointPersist({
              evt,
              promptText: userInput,
              runtimeSettings,
              source: 'graph-pipeline',
              curiosityPursuitContext,
              goalPursuitContext,
              graphSessionIdForPipelineRun: graphSid,
            });
          }
          const prov = evt.provider && evt.model ? ` · ${evt.provider}/${evt.model}` : '';
          const partialTag = evt.outputPartialBySoftTimeout ? ' (partial · time budget)' : '';
          const thought = (pieceStr ?? '').trim();
          addGraphExecutionLog(`✓ ${evt.moduleName} complete${partialTag}${prov}`, thought || undefined);

          const moduleText = pieceStr !== null ? pieceStr : evt.output ?? evt.preview;
          const runModuleUi = async () => {
            try {
              if (uiId && moduleText) {
                if (uiId === 'narrative' || uiId === 'voice') {
                  consciousnessStreamStore.appendEntry('module-thought', moduleText, uiId, streamModuleExtra);
                } else {
                  await streamModuleThoughts(
                    moduleText,
                    uiId,
                    (type, content, id, extra = {}) =>
                      consciousnessStreamStore.appendEntry(type, content, id, {
                        ...streamModuleExtra,
                        ...extra,
                      }),
                    pausedRef
                  );
                }
              }
            } finally {
              if (uiId) {
                const partialNote = evt.outputPartialBySoftTimeout ? ' (partial — time budget)' : '';
                consciousnessStreamStore.appendEntry(
                  'module-complete',
                  `✓ ${evt.moduleName} complete${partialNote}`,
                  uiId,
                  streamModuleExtra
                );
              }
            }
          };
          if (evt.moduleName === 'Voice') {
            voiceUiChain = voiceUiChain.then(() => runModuleUi());
          } else {
            void runModuleUi().catch((err) => console.error('[Pipeline stream] module UI error:', err));
          }
        } else if (evt.type === 'rerun') {
          graphPipelineStore.patch({ loopCount: Number(evt.rerunsUsed) || 0 });
          const line = `↻ Supervisor rerun #${evt.rerunsUsed}: ${evt.reason || ''}`;
          consciousnessStreamStore.appendEntry('system', line, null, { bypassPause: true });
          addGraphExecutionLog(line);
        } else if (evt.type === 'pipeline_continuation') {
          // Do not clear moduleStatuses/moduleOutputs here — the next leg starts at Perception and
          // applyModuleStartToStatuses will advance the map. Clearing made runs look "stuck" at
          // Metacognition between HTTP legs and confused Dashboard / persisted peek during the gap.
          const sup = String(evt.supervisor || '').trim() || 'Supervisor';
          const r = String(evt.reason || '').trim();
          consciousnessStreamStore.appendEntry(
            'system',
            `Continuation (${sup}) — reconnecting from layer 1…${r ? ` ${r.slice(0, 280)}${r.length > 280 ? '…' : ''}` : ''}`,
            null,
            { bypassPause: true }
          );
          addGraphExecutionLog(`↪ Continuation leg (${sup}) — next request from layer 1…`, r || undefined);
        } else if (evt.type === 'would_rerun') {
          sawWouldRerunEvent = true;
          const sup = evt.supervisor || 'Supervisor';
          const kind = evt.kind === 'heuristic' ? 'heuristic' : 'model';
          const r = String(evt.reason || '').trim();
          const clip = r.length > 500 ? `${r.slice(0, 500)}…` : r;
          const line = `⏭ Rerun not executed (${sup}, ${kind}): ${clip || '(no reason)'}`;
          consciousnessStreamStore.appendEntry('system', line, null, { bypassPause: true });
          addGraphExecutionLog(line);
        } else if (evt.type === 'module_progress') {
          const mod = evt.moduleName || 'module';
          let detail = '';
          if (evt.phase === 'chunked_ingest') detail = `large context → ${evt.totalChunks} ingest chunk(s)`;
          else if (evt.phase === 'map_chunk') detail = `ingest map ${evt.chunkIndex}/${evt.totalChunks}`;
          else if (evt.phase === 'ingest_shrink') detail = `shrinking ingest (pass ${evt.tier}/${evt.maxTier})`;
          else if (evt.phase === 'reduce') detail = 'reduce step (single LLM call)';
          else detail = evt.phase || 'working';
          const line = `… ${mod}: ${detail}`;
          consciousnessStreamStore.appendEntry('system', line, null, { bypassPause: true });
          addGraphExecutionLog(line);
        } else if (evt.type === 'web_fetch') {
          const st = evt.ok ? '✓' : '✗';
          const line = `${st} Web ${evt.kind} (${evt.moduleName || '?'})${evt.preview ? `: ${evt.preview}` : ''}${evt.error ? ` — ${evt.error}` : ''}`;
          consciousnessStreamStore.appendEntry('system', line, null, { bypassPause: true });
          addGraphExecutionLog(
            `${st} Web ${evt.kind} (${evt.moduleName || '?'})`,
            evt.preview || evt.error || undefined
          );
        } else if (evt.type === 'complete') {
          const raw = evt.sharedMemory?.moduleOutputs || {};
          const normalized = normalizeModuleOutputsFromServer(raw);
          const stComplete = graphPipelineStore.getState();
          const mergedMo = mergeModuleOutputsPreferLonger(stComplete.moduleOutputs || {}, normalized);
          const nextArousal =
            typeof evt.arousalEffective === 'number' && Number.isFinite(evt.arousalEffective)
              ? evt.arousalEffective
              : graphPipelineStore.getState().arousal;
          const msDone = reconcileCompleteStatusesFromOutputs(stComplete.moduleStatuses || {}, mergedMo);
          graphPipelineStore.patch({
            moduleOutputs: mergedMo,
            moduleStatuses: msDone,
            finalOutput: evt.voiceOutput || '',
            loopCount: Number(evt.rerunsUsed) || 0,
            lastSharedMemory: evt.sharedMemory || null,
            arousal: nextArousal,
          });
        } else if (evt.type === 'paused') {
          const nm = String(evt.nextModuleName || '').trim();
          const ph = String(evt.phase || '').trim();
          const line = `Paused cooperatively before ${nm || '?'} (${ph || '?'}) — progress saved; use Continue to resume.`;
          consciousnessStreamStore.appendEntry('system', line, null, { bypassPause: true });
          addGraphExecutionLog(line);
          const smP = evt.sharedMemory && typeof evt.sharedMemory === 'object' ? evt.sharedMemory : null;
          if (smP) {
            graphPipelineStore.patch({ lastSharedMemory: smP });
          }
        } else if (evt.type === 'attachments') {
          if (Array.isArray(evt.attachments) && evt.attachments.length) {
            const line = `Attachments echoed: ${evt.attachments.length}`;
            consciousnessStreamStore.appendEntry('system', line, null, { bypassPause: true });
            addGraphExecutionLog(line);
          }
        }
      },
  });

    const _bg = backgroundedRuns.has(mySeq);
    if (mySeq !== runSeq && !_bg) return;

    if (!streamResult) {
      throw new Error('Stream ended without a complete event.');
    }

    if (streamResult.pipelinePaused) {
      const ec = streamResult.executionCursor || {};
      const smP = streamResult.sharedMemory && typeof streamResult.sharedMemory === 'object' ? streamResult.sharedMemory : null;
      if (!_bg) {
        const stSnap = graphPipelineStore.getState();
        graphPipelineStore.patch({
          pipelineCheckpoint: {
            savedAt: Date.now(),
            executionCursor: ec,
            slimSharedMemory: smP,
            moduleOutputsSnapshot: { ...(stSnap.moduleOutputs || {}) },
            moduleStatusesSnapshot: { ...(stSnap.moduleStatuses || {}) },
            userInput,
            attachmentIds,
          },
          isRunning: false,
          runInterrupted: false,
          runError: null,
        });
      }
      const rawOutputs = smP?.moduleOutputs || {};
      const norm = normalizeModuleOutputsFromServer(rawOutputs);
      const narrativeText = norm.narrative || rawOutputs.Narrative || '';
      const runRow = await PipelineRun.create({
        input: userInput,
        module_outputs: rawOutputs,
        shared_memory: smP,
        execution_plan: ['sse-graph'],
        loop_count: Number(streamResult.rerunsUsed) || 0,
        final_output: `(Paused before ${ec.nextModuleName || 'next module'})`,
        runtime_settings: runtimeSettingsForPersistence(runtimeSettings),
        provider_used: streamResult.providerUsed,
        model_used: streamResult.modelUsed,
        source: 'graph-pipeline',
        phase: smP?.phase,
        arousal: smP?.arousal,
        intent: smP?.intent,
        phenomenal_now: smP?.phenomenalNow || null,
        cognitive_policy: smP?.cognitivePolicy || null,
        graph_session_id: graphSid,
        run_status: 'paused',
        pipeline_checkpoint: true,
        ...(ec && typeof ec === 'object' && Number(ec.v) === 1 ? { execution_resume: ec } : {}),
      });
      await persistMindAfterPipeline({
        sharedMemory: smP,
        voiceOutput: '',
        narrativeText,
        runtimeSettings,
        source: 'graph-pipeline',
        pipelineRunId: runRow?.id,
        pipelinePartialCheckpoint: true,
        curiosityPursuitContext,
        goalPursuitContext,
      });
      if (!_bg) {
        toast({
          title: 'Pipeline paused',
          description: `Saved at ${ec.nextModuleName || 'next module'}. Reload-safe — click Continue to resume.`,
        });
        consciousnessStreamStore.appendEntry(
          'system',
          `Checkpoint saved (${ec.nextModuleName || 'next'}). Continue resumes the graph.`,
          null,
          { bypassPause: true }
        );
        addGraphExecutionLog(`Checkpoint saved — resume before ${ec.nextModuleName || '?'}`);
      }
      return;
    }

    if (!_bg && typeof streamResult.arousalEffective === 'number' && Number.isFinite(streamResult.arousalEffective)) {
      consciousnessStreamStore.patch({ arousal: streamResult.arousalEffective });
    }

    if (!_bg) await voiceUiChain;

    const pendingRerun = streamResult.metacognitionRerunPending;
    if (pendingRerun) {
      const effectiveDelay = Math.max(1, delayMin || 0);
      await enqueueMetacognitionPipelineRerunSchedule({
        delayMinutes: effectiveDelay,
        reason: `${pendingRerun.supervisor}: ${pendingRerun.reason || ''}`.slice(0, 500),
        inputText: userInput,
        attachmentIds,
        slimSharedMemory: slimSharedMemoryForPipelinePost(streamResult.sharedMemory, { continuation: true }),
        pipelineOptionsSnapshot,
        mindPhase,
        mindArousal: arousal,
        curiosityPursuitContext,
        goalPursuitContext,
      });
      if (!_bg) {
        const schedLine = `Supervisor RERUN scheduled in ~${effectiveDelay} min — graph will continue from Perception.`;
        consciousnessStreamStore.appendEntry('system', schedLine, null, { bypassPause: true });
        addGraphExecutionLog(`Supervisor RERUN scheduled (~${effectiveDelay} min)`, pendingRerun.reason || undefined);
        toast({
          title: 'Supervisor RERUN scheduled',
          description: `Full graph continues in ~${effectiveDelay} min starting at Perception.`,
        });
      }
    }

    const deferredSummary = String(streamResult.metacognitionDeferredRerunsSummary || '').trim();
    const deferredFromSm = streamResult.sharedMemory?.metacognitionDeferredReruns;
    const hasDeferred =
      deferredSummary ||
      (Array.isArray(deferredFromSm) && deferredFromSm.length > 0);
    if (hasDeferred) {
      const body =
        deferredSummary ||
        (Array.isArray(deferredFromSm)
          ? deferredFromSm
              .map((e, i) => {
                const sup = e.supervisor || 'Supervisor';
                const k = e.kind === 'heuristic' ? 'heuristic' : 'model';
                return `[${i + 1}] ${sup} (${k}): ${String(e.reason || '').trim()}`;
              })
              .join('\n')
          : '');
      if (body && !_bg) {
        const head = sawWouldRerunEvent
          ? 'Would-have-rerun summary (full):'
          : 'Would-have-rerun (not executed — cap/limit):';
        consciousnessStreamStore.appendEntry('system', `${head}\n${body}`, null, { bypassPause: true });
        addGraphExecutionLog(head, body);
      }
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

    const scheduledPartial = !!pendingRerun;
    const effectiveDelayForLabel = Math.max(1, delayMin || 0);
    const pipelineFinalOutput = scheduledPartial
      ? `(Supervisor RERUN scheduled in ~${effectiveDelayForLabel} min — Voice pending) ${pendingRerun.supervisor}: ${(pendingRerun.reason || '').slice(0, 200)}`
      : voiceText || '(no Voice output)';
    if (!_bg) {
      if (scheduledPartial) {
        /* toast already shown above */
      } else if (!voiceText) {
        consciousnessStreamStore.appendEntry(
          'system',
          'Pipeline completed without Voice output — run saved to pipeline log; beliefs and other artifacts still synced.',
          null,
          { bypassPause: true }
        );
        toast({
          title: 'Saved without Voice',
          description: 'Voice was empty; pipeline run and mind stores were still updated.',
        });
      }
      const metas = (smDone?.metacognitionTimeline || []).slice(-4);
      for (const cal of metas) {
        const line = formatMetaCalibration(cal);
        if (line) consciousnessStreamStore.appendEntry('meta-calibration', line, 'metacognition', { bypassPause: true });
      }
    }

    const assistantDisplay = String(voiceText || '').trim() ? voiceText : pipelineFinalOutput;
    const userMsg = await ConversationMessage.create({
      role: 'user',
      content: userInput,
      attachment_ids: attachmentIds,
      graph_session_id: graphSid,
    });
    await ConversationMessage.create({
      role: 'assistant',
      content: assistantDisplay,
      module_outputs: rawOutputs,
      shared_memory: smDone,
      reruns_used: streamResult.rerunsUsed || 0,
      provider_used: streamResult.providerUsed,
      model_used: streamResult.modelUsed,
      reply_to: userMsg.id,
      graph_session_id: graphSid,
    });

    const runRow = await PipelineRun.create({
      input: userInput,
      module_outputs: rawOutputs,
      shared_memory: smDone,
      execution_plan: ['sse-graph'],
      loop_count: Number(streamResult.rerunsUsed) || 0,
      final_output: pipelineFinalOutput,
      runtime_settings: runtimeSettingsForPersistence(runtimeSettings),
      provider_used: streamResult.providerUsed,
      model_used: streamResult.modelUsed,
      source: 'graph-pipeline',
      phase: smDone?.phase,
      arousal: smDone?.arousal,
      intent: smDone?.intent,
      phenomenal_now: smDone?.phenomenalNow || null,
      cognitive_policy: smDone?.cognitivePolicy || null,
      graph_session_id: graphSid,
    });

    await persistMindAfterPipeline({
      sharedMemory: smDone,
      voiceOutput: voiceText || '',
      narrativeText,
      runtimeSettings,
      source: 'graph-pipeline',
      pipelineRunId: runRow?.id,
      curiosityPursuitContext,
      goalPursuitContext,
    });

    const secs = ((Date.now() - startTime) / 1000).toFixed(1);
    const reruns = Number(streamResult.rerunsUsed) || 0;
    const doneMsg = scheduledPartial
      ? `Pipeline leg complete in ${secs}s — supervisor RERUN scheduled (~${delayMin} min); Voice pending after scheduled run.`
      : voiceText
        ? `Pipeline complete in ${secs}s${reruns > 0 ? ` (${reruns} supervisor rerun(s))` : ''} — saved locally.`
        : `Pipeline complete in ${secs}s${reruns > 0 ? ` (${reruns} supervisor rerun(s))` : ''} — saved (beliefs & artifacts; Voice empty).`;
    if (!_bg) {
      consciousnessStreamStore.appendEntry('system', doneMsg, null, { bypassPause: true });
      addGraphExecutionLog(doneMsg, voiceText || undefined);
    }
  } catch (e) {
    const _bgCatch = backgroundedRuns.has(mySeq);
    if (mySeq !== runSeq && !_bgCatch) return;
    console.error(e);
    const raw = stringifyUnknownError(e);
    const msg = appendRateLimitRecoveryHint(raw);
    if (!_bgCatch) {
      consciousnessStreamStore.appendEntry('system', `Error: ${msg}`, null, { bypassPause: true });
      graphPipelineStore.patch({ runError: msg });
      addGraphExecutionLog(`Pipeline failed: ${msg}`);
    }
  } finally {
    const _bgFin = backgroundedRuns.has(mySeq);
    if (mySeq === runSeq || _bgFin) {
      backgroundedRuns.delete(mySeq);
      unregisterPipelinePauseToken(pauseToken);
      if (mySeq === runSeq) {
        streamAbortController = null;
        activeConsciousnessStreamGraphSessionId = null;
      }
      if (!_bgFin) {
        consciousnessStreamStore.patch({ isProcessing: false, activeRunTopic: '' });
        consciousnessStreamStore.clearDraftPersist();
        const msEnd = { ...(graphPipelineStore.getState().moduleStatuses || {}) };
        for (const k of Object.keys(msEnd)) {
          if (msEnd[k] === 'processing') msEnd[k] = 'complete';
        }
        graphPipelineStore.patch({
          isRunning: false,
          uploading: false,
          cooperativePauseToken: null,
          moduleStatuses: msEnd,
        });
        graphPipelineStore.flushPersist();
      }
      upsertGraphPipelineSession({
        id: graphSid,
        label: registryRunTopic.slice(0, 160) || 'Graph session',
        seedFirstThreadLabel: true,
        isProcessing: false,
      });
    }
  }
}

export function cancelConsciousnessStreamRunToken() {
  abortActiveConsciousnessStreamRun();
}
