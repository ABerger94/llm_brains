import { probeApiHealth } from './apiReachability';
import { getRuntimeSettings } from './runtimeSettings';
import { graphPipelineStore } from './graphPipelineStore';
import { consciousnessStreamStore } from './consciousnessStreamStore';
import { isInteractiveGraphOrStreamActive } from './pipelineBusyGate';
import { startConsciousnessStreamRun } from './consciousnessStreamRunner';
import { getKvSync, setKvSync } from './browserStorage';
import { listGraphSessionIdsWithPersistedCooperativeCheckpoints } from './graphPipelineCheckpointDiscovery';
import { rehydrateGraphPipelineSessionStores } from './graphPipelineSessionHydrate';
import { validCooperativePipelineCheckpoint } from './graphPipelineStore';

const RESUME_SESSION_KEY = 'mybrain_graph_reconnect_resume';

/** @type {boolean | null} null = never probed yet */
let lastProbeOk = null;
let intervalId = null;
let debounceTimer = null;

/**
 * True when failure text looks like transport/API outage (safe to auto-retry on reconnect).
 * @param {string} text
 */
export function isTransientReconnectFailure(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/NO_AUTO_RETRY/i.test(s)) return false;
  const lower = s.toLowerCase();
  if (/\b(502|503|504)\b/.test(lower)) return true;
  if (/bad gateway|service unavailable|gateway timeout/.test(lower)) return true;
  if (/failed to fetch|networkerror|network request failed|load failed|net::err/.test(lower)) return true;
  if (/cannot reach|connection refused|econnreset|etimedout|socket hang up/.test(lower)) return true;
  if (/abort(ed|error)?|timed out|timeout\b/.test(lower)) return true;
  if (/api unreachable|api offline|offline\b|wrong origin/.test(lower)) return true;
  if (/http\s*408|http\s*429|\b429\b|rate limit|too many requests/.test(lower)) return true;
  if (/typeerror.*fetch|fetch.*failed/i.test(s)) return true;
  return false;
}

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
  const rt = getRuntimeSettings();
  if (rt.autoResumeGraphPipelineOnReconnect === false) return;

  const gp = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();
  const err = String(gp.runError || '').trim();
  const eligible = Boolean(gp.runInterrupted) || isTransientReconnectFailure(err);
  if (!eligible) return;
  if (cs.isProcessing || gp.isRunning) return;
  if (!graphPipelineInterruptedHasResumeInput()) return;

  if (!consumeGraphReconnectResumeSlot(rt)) {
    console.info('[reconnect] graph resume skipped (cooldown cap)');
    return;
  }

  console.info('[reconnect] silent graph/stream resume');
  void startConsciousnessStreamRun({ reconnectResume: true });
}

/**
 * Try to resume from a persisted cooperative-pause checkpoint (reload-safe). Scans every graph session
 * KV for repairable checkpoints (newest first), not only the first matching session id.
 * @returns {Promise<{ graphStarted: boolean, graphReason: string, otherGraphCheckpointSessions?: number } | null>} null if no checkpoint to try
 */
async function tryResumeFromCooperativeCheckpoint() {
  const ordered = listGraphSessionIdsWithPersistedCooperativeCheckpoints();
  const total = ordered.length;
  const otherAfterSuccess = Math.max(0, total - 1);

  let gp = graphPipelineStore.getState();
  let ck = validCooperativePipelineCheckpoint(gp.pipelineCheckpoint);

  const outcome = (processing) => ({
    graphStarted: Boolean(processing),
    graphReason: processing ? 'started_from_checkpoint' : 'not_started',
    otherGraphCheckpointSessions: processing ? otherAfterSuccess : total,
  });

  try {
    if (ck) {
      await startConsciousnessStreamRun({ resumeFromCheckpoint: true });
      return outcome(consciousnessStreamStore.getState().isProcessing);
    }

    for (const sid of ordered) {
      rehydrateGraphPipelineSessionStores(sid);
      gp = graphPipelineStore.getState();
      ck = validCooperativePipelineCheckpoint(gp.pipelineCheckpoint);
      if (!ck) continue;
      await startConsciousnessStreamRun({ resumeFromCheckpoint: true });
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
 * User-triggered (Dashboard): resume interrupted graph/stream without reconnect cooldown caps.
 * Also resumes a cooperative-pause checkpoint ("Pause & save") from persisted per-session KV when
 * present (takes precedence over reconnect replay when valid).
 * Ignores `autoResumeGraphPipelineOnReconnect` so an explicit click always attempts when safe.
 * @returns {Promise<{ graphStarted: boolean, graphReason: string, otherGraphCheckpointSessions?: number }>}
 */
export async function resumeInterruptedGraphPipelineManual() {
  const gp0 = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();

  if (cs.isProcessing || gp0.isRunning) {
    return { graphStarted: false, graphReason: 'already_running', otherGraphCheckpointSessions: 0 };
  }
  if (isInteractiveGraphOrStreamActive()) {
    return { graphStarted: false, graphReason: 'pipeline_busy', otherGraphCheckpointSessions: 0 };
  }

  const ckOutcome = await tryResumeFromCooperativeCheckpoint();
  if (ckOutcome?.graphStarted) return ckOutcome;
  if (ckOutcome && String(ckOutcome.graphReason || '').startsWith('error:')) return ckOutcome;

  const gp = graphPipelineStore.getState();
  const err = String(gp.runError || '').trim();
  const eligible = Boolean(gp.runInterrupted) || isTransientReconnectFailure(err);
  if (!eligible) {
    return ckOutcome ?? { graphStarted: false, graphReason: 'not_interrupted', otherGraphCheckpointSessions: 0 };
  }

  if (!graphPipelineInterruptedHasResumeInput()) {
    return ckOutcome ?? { graphStarted: false, graphReason: 'no_recoverable_input', otherGraphCheckpointSessions: 0 };
  }
  try {
    await startConsciousnessStreamRun({ reconnectResume: true });
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
