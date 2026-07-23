import { probeApiHealth } from './apiReachability';
import { getRuntimeSettings } from './runtimeSettings';
import { graphPipelineStore, validCooperativePipelineCheckpoint } from './graphPipelineStore';
import { consciousnessStreamStore } from './consciousnessStreamStore';
import { isInteractiveGraphOrStreamActive, waitUntilInteractiveGraphOrStreamIdle } from './pipelineBusyGate';
import { bindGraphSessionForPendingInterruptedResume, startConsciousnessStreamRun } from './consciousnessStreamRunner';
import { getKvSync, setKvSync } from './browserStorage';
import {
  listGraphSessionIdsForCheckpointScan,
  listGraphSessionIdsWithPersistedCooperativeCheckpoints,
} from './graphPipelineCheckpointDiscovery';
import { tryLoadCheckpointFromDbIntoStore } from './graphPipelineCheckpointResume';
import { rehydrateGraphPipelineSessionStores } from './graphPipelineSessionHydrate';
import { clearStaleGraphPipelineCheckpointIfSuperseded } from './graphCheckpointStale';
import {
  getGraphPipelineSessionId,
  getGraphSessionIdForPersistence,
  DEFAULT_GRAPH_SESSION_ID,
} from './graphPipelineSessionScope';
import { isTransientReconnectFailure } from './transientPipelineFailure.js';
import { graphResumeStreamOptsForSession } from './playgroundDualGraphRunner';

export { isTransientReconnectFailure };

/**
 * KV sessions with checkpoints (newest first) plus registry/default scan order, deduped — includes
 * sessions that may only have IndexedDB checkpoints after reload.
 */
function mergeResumeCheckpointSessionOrder() {
  const kv = listGraphSessionIdsWithPersistedCooperativeCheckpoints();
  const scan = listGraphSessionIdsForCheckpointScan();
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const sid of [...kv, ...scan]) {
    const id = String(sid || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const RESUME_SESSION_KEY = 'mybrain_graph_reconnect_resume';

/** @type {boolean | null} null = never probed yet */
let lastProbeOk = null;
let intervalId = null;
let debounceTimer = null;

/** @param {Record<string, unknown>} rt */
function consumeGraphReconnectResumeSlot(rt) {
  const windowMs = Math.max(60_000, Number(rt.graphPipelineReconnectResumeCooldownMs) || 600_000);
  const maxN = Math.max(1, Math.floor(Number(rt.graphPipelineReconnectResumeMaxPerCooldown) || 2));
  try {
    const raw = getKvSync(RESUME_SESSION_KEY);
    let slot = raw ? JSON.parse(raw) : null;
    const now = Date.now();
    if (!slot || typeof slot !== 'object' || now - Number(slot.t0 || 0) > windowMs) {
      slot = { t0: now, n: 0 };
    }
    if (Number(slot.n) >= maxN) return false;
    setKvSync(RESUME_SESSION_KEY, JSON.stringify({ t0: slot.t0, n: Number(slot.n) + 1 }));
    return true;
  } catch {
    return true;
  }
}

export function graphPipelineInterruptedHasResumeInput() {
  const cs = consciousnessStreamStore.getState();
  let prompt = '';
  const ent = cs.entries || [];
  for (let i = ent.length - 1; i >= 0; i -= 1) {
    const e = ent[i];
    if (e?.type === 'user-input' && String(e.content || '').trim()) {
      prompt = String(e.content).trim();
      break;
    }
  }
  if (!prompt) prompt = String(cs.input || '').trim();
  const hasAttach = Array.isArray(cs.attachments) && cs.attachments.length > 0;
  return Boolean(prompt) || hasAttach;
}

export async function trySilentResumeGraphPipelineAfterReconnect() {
  try {
    const rt = getRuntimeSettings();
    if (rt.autoResumeGraphPipelineOnReconnect === false) return;

    bindGraphSessionForPendingInterruptedResume();

    const gp = graphPipelineStore.getState();
    const cs = consciousnessStreamStore.getState();
    if (cs.isProcessing || gp.isRunning) return;
    if (isInteractiveGraphOrStreamActive()) return;

    // Do not call tryResumeFromCooperativeCheckpoint here. Cooperative-pause checkpoints are
    // intentional “Pause & save” stops — resuming must be explicit (Graph Continue, Dashboard
    // Resume all). When a tab is backgrounded, /api/ping often fails so lastProbeOk becomes false;
    // on focus the probe succeeds and this function runs. Auto-starting from checkpoint then
    // spuriously restarted pipelines and looked like a reload/crash.

    const err = String(gp.runError || '').trim();
    const eligible = Boolean(gp.runInterrupted) || isTransientReconnectFailure(err);
    if (!eligible) return;
    if (!graphPipelineInterruptedHasResumeInput()) return;

    if (!consumeGraphReconnectResumeSlot(rt)) {
      console.info('[reconnect] graph resume skipped (cooldown cap)');
      return;
    }

    console.info('[reconnect] silent graph/stream resume');
    void startConsciousnessStreamRun({
      reconnectResume: true,
      ...graphResumeStreamOptsForSession(getGraphSessionIdForPersistence()),
    });
  } catch (e) {
    console.warn('[reconnect] silent resume failed:', e?.message || e);
  }
}

/**
 * After navigating to Graph Pipeline with a session rehydrated from disk: if this session was
 * **interrupted** (reload mid-run, transport error) and has a resumable checkpoint, continue from
 * checkpoint. Intentional cooperative pauses set `runInterrupted: false` — those still use Continue.
 */
export async function tryAutoResumeInterruptedCheckpointForCurrentSession() {
  try {
    const rt = getRuntimeSettings();
    if (rt.autoResumeGraphPipelineOnReconnect === false) return;

    bindGraphSessionForPendingInterruptedResume();

    const sid = getGraphSessionIdForPersistence();
    await tryLoadCheckpointFromDbIntoStore(sid);

    const gp = graphPipelineStore.getState();
    const cs = consciousnessStreamStore.getState();
    if (cs.isProcessing || gp.isRunning) return;
    if (isInteractiveGraphOrStreamActive()) return;

    const ck = validCooperativePipelineCheckpoint(gp.pipelineCheckpoint);
    if (!ck) return;

    const err = String(gp.runError || '').trim();
    if (!gp.runInterrupted && !isTransientReconnectFailure(err)) return;

    if (await clearStaleGraphPipelineCheckpointIfSuperseded(sid)) return;

    if (!consumeGraphReconnectResumeSlot(rt)) {
      console.info('[checkpoint] auto-resume skipped (cooldown cap)');
      return;
    }

    console.info('[checkpoint] auto-resume after load (interrupted session)');
    await startConsciousnessStreamRun({
      resumeFromCheckpoint: true,
      ...graphResumeStreamOptsForSession(getGraphSessionIdForPersistence()),
    });
  } catch (e) {
    console.warn('[checkpoint] auto-resume failed:', e?.message || e);
  }
}

/**
 * Try to resume from a persisted cooperative-pause checkpoint (reload-safe). Scans every graph session
 * KV for repairable checkpoints (newest first), not only the first matching session id.
 * @returns {Promise<{ graphStarted: boolean, graphReason: string, otherGraphCheckpointSessions?: number } | null>} null if no checkpoint to try
 */
export async function tryResumeFromCooperativeCheckpoint() {
  const ordered = mergeResumeCheckpointSessionOrder();
  const total = ordered.length;
  const otherAfterSuccess = Math.max(0, total - 1);

  const sid0 = getGraphPipelineSessionId() || DEFAULT_GRAPH_SESSION_ID;
  rehydrateGraphPipelineSessionStores(sid0);
  await tryLoadCheckpointFromDbIntoStore(sid0);

  let gp = graphPipelineStore.getState();
  let ck = validCooperativePipelineCheckpoint(gp.pipelineCheckpoint);

  const outcome = (processing) => ({
    graphStarted: Boolean(processing),
    graphReason: processing ? 'started_from_checkpoint' : 'not_started',
    otherGraphCheckpointSessions: processing ? otherAfterSuccess : total,
  });

  try {
    if (ck) {
      const clearedStale = await clearStaleGraphPipelineCheckpointIfSuperseded(sid0);
      if (!clearedStale) {
        await startConsciousnessStreamRun({
          resumeFromCheckpoint: true,
          ...graphResumeStreamOptsForSession(sid0),
        });
        return outcome(consciousnessStreamStore.getState().isProcessing);
      }
      gp = graphPipelineStore.getState();
      ck = validCooperativePipelineCheckpoint(gp.pipelineCheckpoint);
    }

    for (const sid of ordered) {
      rehydrateGraphPipelineSessionStores(sid);
      await tryLoadCheckpointFromDbIntoStore(sid);
      gp = graphPipelineStore.getState();
      ck = validCooperativePipelineCheckpoint(gp.pipelineCheckpoint);
      if (!ck) continue;
      if (await clearStaleGraphPipelineCheckpointIfSuperseded(sid)) continue;
      await startConsciousnessStreamRun({
        resumeFromCheckpoint: true,
        ...graphResumeStreamOptsForSession(sid),
      });
      const processing = consciousnessStreamStore.getState().isProcessing;
      if (processing) return outcome(true);
    }

    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { graphStarted: false, graphReason: `error:${msg}`, otherGraphCheckpointSessions: total };
  }
}

/**
 * Dashboard: resume one graph session’s cooperative-pause checkpoint (single interactive run).
 * Does not loop multiple sessions — use that when the user picks one row.
 *
 * @param {string} sessionId
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function resumeCooperativeGraphCheckpointForSession(sessionId) {
  bindGraphSessionForPendingInterruptedResume();
  const sid = String(sessionId || '').trim() || DEFAULT_GRAPH_SESSION_ID;

  const gp0 = graphPipelineStore.getState();
  const cs0 = consciousnessStreamStore.getState();
  if (cs0.isProcessing || gp0.isRunning) {
    return { ok: false, message: 'A graph pipeline is already running in this tab.' };
  }
  if (isInteractiveGraphOrStreamActive()) {
    return { ok: false, message: 'Another interactive pipeline is active.' };
  }

  rehydrateGraphPipelineSessionStores(sid);
  await tryLoadCheckpointFromDbIntoStore(sid);
  const gp = graphPipelineStore.getState();
  const ck = validCooperativePipelineCheckpoint(gp.pipelineCheckpoint);
  if (!ck) {
    return { ok: false, message: 'No saved cooperative checkpoint for this graph session.' };
  }
  if (await clearStaleGraphPipelineCheckpointIfSuperseded(sid)) {
    return { ok: false, message: 'Checkpoint was superseded or stale.' };
  }
  try {
    await startConsciousnessStreamRun({
      resumeFromCheckpoint: true,
      ...graphResumeStreamOptsForSession(sid),
    });
    return { ok: true, message: 'Resuming graph from saved checkpoint…' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * User-triggered (Dashboard): resume interrupted graph/stream without reconnect cooldown caps.
 * Also resumes a cooperative-pause checkpoint ("Pause & save") from persisted per-session KV when
 * present (takes precedence over reconnect replay when valid).
 * Ignores `autoResumeGraphPipelineOnReconnect` so an explicit click always attempts when safe.
 * @returns {Promise<{ graphStarted: boolean, graphReason: string, otherGraphCheckpointSessions?: number }>}
 */
export async function resumeInterruptedGraphPipelineManual() {
  bindGraphSessionForPendingInterruptedResume();

  const gp0 = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();

  if (cs.isProcessing || gp0.isRunning) {
    return { graphStarted: false, graphReason: 'already_running', otherGraphCheckpointSessions: 0 };
  }
  if (isInteractiveGraphOrStreamActive()) {
    return { graphStarted: false, graphReason: 'pipeline_busy', otherGraphCheckpointSessions: 0 };
  }

  /** Resume every saved cooperative graph checkpoint (one interactive run at a time, in session order). */
  let cooperativeCheckpointLegs = 0;
  while (true) {
    if (isInteractiveGraphOrStreamActive()) {
      await waitUntilInteractiveGraphOrStreamIdle({ timeoutMs: 3_600_000, pollIntervalMs: 400 });
    }
    const ckOutcome = await tryResumeFromCooperativeCheckpoint();
    if (ckOutcome == null) break;
    if (String(ckOutcome.graphReason || '').startsWith('error:')) return ckOutcome;
    if (!ckOutcome.graphStarted) break;
    cooperativeCheckpointLegs += 1;
    await waitUntilInteractiveGraphOrStreamIdle({ timeoutMs: 3_600_000, pollIntervalMs: 400 });
  }
  if (cooperativeCheckpointLegs > 0) {
    return {
      graphStarted: true,
      graphReason: cooperativeCheckpointLegs > 1 ? 'started_from_checkpoint_multi' : 'started_from_checkpoint',
      otherGraphCheckpointSessions: 0,
      cooperativeCheckpointLegs,
    };
  }

  const gp = graphPipelineStore.getState();
  const err = String(gp.runError || '').trim();
  const eligible = Boolean(gp.runInterrupted) || isTransientReconnectFailure(err);
  if (!eligible) {
    return { graphStarted: false, graphReason: 'not_interrupted', otherGraphCheckpointSessions: 0 };
  }

  if (!graphPipelineInterruptedHasResumeInput()) {
    return { graphStarted: false, graphReason: 'no_recoverable_input', otherGraphCheckpointSessions: 0 };
  }
  try {
    await startConsciousnessStreamRun({
      reconnectResume: true,
      ...graphResumeStreamOptsForSession(getGraphSessionIdForPersistence()),
    });
    const processing = consciousnessStreamStore.getState().isProcessing;
    return {
      graphStarted: Boolean(processing),
      graphReason: processing ? 'started' : 'not_started',
      otherGraphCheckpointSessions: 0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { graphStarted: false, graphReason: `error:${msg}`, otherGraphCheckpointSessions: 0 };
  }
}

async function onApiBecameReachable() {
  try {
    await trySilentResumeGraphPipelineAfterReconnect();
  } catch (e) {
    console.warn('[reconnect] graph resume error', e);
  }
}

async function runDebouncedProbe() {
  if (typeof window === 'undefined') return;
  try {
    const r = await probeApiHealth({ timeoutMs: 4000 });
    const next = r.ok;
    if (lastProbeOk === false && next) {
      await onApiBecameReachable();
    }
    lastProbeOk = next;
  } catch {
    lastProbeOk = false;
  }
}

function scheduleProbe() {
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void runDebouncedProbe();
  }, 1200);
}

function onOnlineReconnect() {
  scheduleProbe();
}

function onVisibilityReconnect() {
  if (document.visibilityState === 'visible') scheduleProbe();
}

export function startReconnectRecoveryLoop() {
  if (typeof window === 'undefined') return;
  if (intervalId != null) return;

  window.addEventListener('online', onOnlineReconnect);
  document.addEventListener('visibilitychange', onVisibilityReconnect);

  intervalId = window.setInterval(() => scheduleProbe(), 22_000);

  scheduleProbe();
}

export function stopReconnectRecoveryLoop() {
  if (typeof window === 'undefined') return;
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (debounceTimer != null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  window.removeEventListener('online', onOnlineReconnect);
  document.removeEventListener('visibilitychange', onVisibilityReconnect);
}
