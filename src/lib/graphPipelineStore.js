import { clipTextComplete } from '../../shared/textClip.mjs';
import { slimSharedMemoryForPipelinePost } from './slimSharedMemory';
import { getKvSync, removeKvSync, setKvSync } from './browserStorage';
import {
  getGraphPipelineSessionId,
  graphPipelineUiLegacyFallbackKey,
  graphPipelineUiStorageKey,
} from './graphPipelineSessionScope';
import { MIND_STORAGE_CHANGED } from './mindStorageEvents';

const listeners = new Set();

/** @param {() => void} listener */
export function subscribeGraphPipeline(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  listeners.forEach((l) => l());
}

const defaultState = {
  input: '',
  /** User-facing label for this run (prompt + attachment hint); for dashboard Topic, not execution log. */
  runContextLabel: '',
  executionLog: [],
  loopCount: 0,
  moduleStatuses: {},
  moduleOutputs: {},
  finalOutput: '',
  lastSharedMemory: null,
  /** Last provider/model from any graph pipeline module_complete SSE (Dashboard when /api/health lags). */
  lastLlmProvider: null,
  lastLlmModel: null,
  mindPhase: 'focus',
  arousal: 0.55,
  intent: '',
  attachments: [],
  isRunning: false,
  runInterrupted: false,
  runError: null,
  uploading: false,
  /** Saved cooperative-pause resume payload (per session KV). */
  pipelineCheckpoint: null,
  /**
   * While an interactive graph SSE is live, the token POSTed with `/api/pipeline/stream` (also in-memory registry).
   * Persisted so Dashboard / another tab can POST `/api/pipeline/pause-request` for runs shown only via session peek.
   */
  cooperativePauseToken: null,
  /**
   * Per-run metacognition caps for the next graph POST; null fields use global runtime defaults.
   * maxMetacognitionReruns: max supervisor-triggered reruns per user message/run (cumulative across continuation legs; same semantics as Mind Settings).
   * @type {{ maxMetacognitionReruns: number | null, metacognitionRerunDelayMinutes: number | null }}
   */
  pipelineMetacognitionOverrides: { maxMetacognitionReruns: null, metacognitionRerunDelayMinutes: null },
  /**
   * Ephemeral: another tab or pipeline persist updated IndexedDB — next SSE leg should merge fresh prep slices.
   * Not written to session KV.
   */
  pipelineIntegrationPrepStale: false,
};

/**
 * Cooperative pause checkpoint must include execution cursor + shared memory or resume will fail.
 * @param {unknown} cp
 * @returns {object | null}
 */
export function validCooperativePipelineCheckpoint(cp) {
  if (!cp || typeof cp !== 'object') return null;
  const ec = cp.executionCursor;
  if (!ec || typeof ec !== 'object') return null;
  const sm = cp.slimSharedMemory;
  if (!sm || typeof sm !== 'object') return null;
  return cp;
}

/**
 * Restore a cooperative checkpoint after export/import or older saves where `slimSharedMemory` was
 * missing but the graph blob still has `lastSharedMemory` (same pause payload).
 * @param {unknown} rawCp - `pipelineCheckpoint` from persisted graph UI JSON
 * @param {unknown} lastSharedMemoryFallback - top-level `lastSharedMemory` from same blob
 * @returns {object | null}
 */
export function repairCooperativePipelineCheckpoint(rawCp, lastSharedMemoryFallback) {
  const ok = validCooperativePipelineCheckpoint(rawCp);
  if (ok) return ok;
  if (!rawCp || typeof rawCp !== 'object') return null;
  const ec = rawCp.executionCursor;
  if (!ec || typeof ec !== 'object') return null;
  let sm = rawCp.slimSharedMemory;
  if (!sm || typeof sm !== 'object') {
    sm =
      lastSharedMemoryFallback && typeof lastSharedMemoryFallback === 'object' ? lastSharedMemoryFallback : null;
  }
  if (!sm || typeof sm !== 'object') return null;
  return validCooperativePipelineCheckpoint({ ...rawCp, slimSharedMemory: sm });
}

function clipModuleOutputs(obj, perKey = 24_000) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    let s = '';
    if (typeof v === 'string') s = v;
    else if (v == null) s = '';
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') s = String(v);
    else if (typeof v === 'object') {
      try {
        s = JSON.stringify(v);
      } catch {
        s = '';
      }
    } else s = String(v);
    out[k] = s ? clipTextComplete(s, perKey, { ellipsis: false }) : s;
  }
  return out;
}

function readStorage() {
  if (typeof window === 'undefined') return { ...defaultState };
  const primaryKey = graphPipelineUiStorageKey();
  if (!primaryKey) return { ...defaultState };
  try {
    let raw = getKvSync(primaryKey);
    const fallbackKey = graphPipelineUiLegacyFallbackKey();
    if (!raw && fallbackKey && fallbackKey !== primaryKey) {
      raw = getKvSync(fallbackKey);
    }
    if (!raw) return { ...defaultState };
    const parsed = JSON.parse(raw);
    let isRunning = Boolean(parsed.isRunning);
    const runInterrupted = isRunning ? true : Boolean(parsed.runInterrupted);
    let cooperativePauseToken =
      typeof parsed.cooperativePauseToken === 'string' ? String(parsed.cooperativePauseToken).trim() : '';
    if (isRunning) {
      isRunning = false;
      cooperativePauseToken = '';
    }
    return {
      input: typeof parsed.input === 'string' ? parsed.input : '',
      runContextLabel: typeof parsed.runContextLabel === 'string' ? parsed.runContextLabel : '',
      executionLog: Array.isArray(parsed.executionLog) ? parsed.executionLog : [],
      loopCount: Number(parsed.loopCount) || 0,
      moduleStatuses: parsed.moduleStatuses && typeof parsed.moduleStatuses === 'object' ? parsed.moduleStatuses : {},
      moduleOutputs: parsed.moduleOutputs && typeof parsed.moduleOutputs === 'object' ? parsed.moduleOutputs : {},
      finalOutput: typeof parsed.finalOutput === 'string' ? parsed.finalOutput : '',
      lastSharedMemory:
        parsed.lastSharedMemory && typeof parsed.lastSharedMemory === 'object' ? parsed.lastSharedMemory : null,
      lastLlmProvider: typeof parsed.lastLlmProvider === 'string' ? parsed.lastLlmProvider : null,
      lastLlmModel: typeof parsed.lastLlmModel === 'string' ? parsed.lastLlmModel : null,
      mindPhase: typeof parsed.mindPhase === 'string' ? parsed.mindPhase : 'focus',
      arousal: Number.isFinite(Number(parsed.arousal)) ? Number(parsed.arousal) : 0.55,
      intent: typeof parsed.intent === 'string' ? parsed.intent : '',
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      isRunning,
      runInterrupted,
      runError: typeof parsed.runError === 'string' ? parsed.runError : null,
      uploading: false,
      pipelineCheckpoint: repairCooperativePipelineCheckpoint(parsed.pipelineCheckpoint, parsed.lastSharedMemory),
      cooperativePauseToken: cooperativePauseToken || null,
      pipelineMetacognitionOverrides: (() => {
        const o = parsed.pipelineMetacognitionOverrides;
        if (!o || typeof o !== 'object') {
          return { maxMetacognitionReruns: null, metacognitionRerunDelayMinutes: null };
        }
        const maxR = o.maxMetacognitionReruns;
        const del = o.metacognitionRerunDelayMinutes;
        return {
          maxMetacognitionReruns:
            maxR != null && maxR !== '' && Number.isFinite(Number(maxR)) ? Number(maxR) : null,
          metacognitionRerunDelayMinutes:
            del != null && del !== '' && Number.isFinite(Number(del)) ? Number(del) : null,
        };
      })(),
      pipelineIntegrationPrepStale: false,
    };
  } catch {
    return { ...defaultState };
  }
}

let state = { ...defaultState };

let persistTimer = null;

/** Keep in-memory log bounded — long SSE runs used to grow without limit and OOM-crash WebKit (iOS). */
const MAX_IN_MEMORY_EXECUTION_LOG_LINES = 400;

/** System Chat (`playground-dual-a` / `playground-dual-b`) keeps the full execution.log for an accurate line count. */
const PLAYGROUND_GRAPH_SESSION_IDS = new Set(['playground-dual-a', 'playground-dual-b']);

function isPlaygroundSystemChatSession() {
  const sid = getGraphPipelineSessionId();
  return Boolean(sid && PLAYGROUND_GRAPH_SESSION_IDS.has(sid));
}

function maxExecutionLogLinesForCurrentSession() {
  return isPlaygroundSystemChatSession() ? Number.POSITIVE_INFINITY : MAX_IN_MEMORY_EXECUTION_LOG_LINES;
}

function maxPersistExecutionLogLinesForCurrentSession() {
  return isPlaygroundSystemChatSession() ? Number.POSITIVE_INFINITY : MAX_IN_MEMORY_EXECUTION_LOG_LINES;
}

/**
 * @param {unknown} log
 * @returns {Array<{ time?: number, msg?: string, detail?: string }>}
 */
function capExecutionLogInMemory(log) {
  if (!Array.isArray(log)) return [];
  const max = maxExecutionLogLinesForCurrentSession();
  const windowed = log.length <= max ? log : log.slice(-max);
  return windowed.map((e) => {
    if (!e || typeof e !== 'object') return { time: Date.now(), msg: '' };
    const msg = typeof e.msg === 'string' ? clipTextComplete(e.msg, 4000, { ellipsis: false }) : String(e.msg || '').slice(0, 4000);
    const out = {
      time: typeof e.time === 'number' && Number.isFinite(e.time) ? e.time : Date.now(),
      msg,
    };
    if (e.detail != null && typeof e.detail === 'string') {
      out.detail = clipTextComplete(e.detail, 12_000, { ellipsis: false });
    }
    return out;
  });
}

function persistNow() {
  if (typeof window === 'undefined') return;
  const storageKey = graphPipelineUiStorageKey();
  if (!storageKey) return;
  try {
    const logArr = Array.isArray(state.executionLog) ? state.executionLog : [];
    const persistCap = maxPersistExecutionLogLinesForCurrentSession();
    const rawLog = logArr.length <= persistCap ? logArr : logArr.slice(-persistCap);
    const mo = clipModuleOutputs(state.moduleOutputs, 200_000);
    let smSave = null;
    if (state.lastSharedMemory && typeof state.lastSharedMemory === 'object') {
      try {
        smSave = slimSharedMemoryForPipelinePost(state.lastSharedMemory);
      } catch {
        smSave = null;
      }
    }
    const toSave = {
      input: state.input,
      runContextLabel: String(state.runContextLabel || ''),
      executionLog: rawLog.map((e) => ({
        time: e.time,
        msg: e.msg,
        ...(e.detail ? { detail: clipTextComplete(String(e.detail), 200_000, { ellipsis: false }) } : {}),
      })),
      loopCount: state.loopCount ?? 0,
      moduleStatuses: state.moduleStatuses || {},
      moduleOutputs: mo,
      finalOutput: clipTextComplete(String(state.finalOutput || ''), 32_000, { ellipsis: false }),
      lastSharedMemory: smSave,
      lastLlmProvider: typeof state.lastLlmProvider === 'string' ? state.lastLlmProvider : null,
      lastLlmModel: typeof state.lastLlmModel === 'string' ? state.lastLlmModel : null,
      mindPhase: state.mindPhase,
      arousal: state.arousal,
      intent: state.intent,
      attachments: Array.isArray(state.attachments)
        ? state.attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            mimeType: a.mimeType,
            ...(a.kind ? { kind: a.kind } : {}),
          }))
        : [],
      isRunning: state.isRunning,
      runInterrupted: state.runInterrupted,
      runError:
        state.runError != null
          ? clipTextComplete(String(state.runError), 200_000, { ellipsis: false })
          : null,
      uploading: false,
      pipelineCheckpoint: state.pipelineCheckpoint,
      cooperativePauseToken:
        state.isRunning && state.cooperativePauseToken ? String(state.cooperativePauseToken).trim() : null,
      pipelineMetacognitionOverrides: state.pipelineMetacognitionOverrides || {
        maxMetacognitionReruns: null,
        metacognitionRerunDelayMinutes: null,
      },
    };
    setKvSync(storageKey, JSON.stringify(toSave));
  } catch {
    /* quota */
  }
}

function schedulePersist() {
  if (state.isRunning) {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, 500);
    return;
  }
  persistNow();
}

export const graphPipelineStore = {
  getState() {
    return state;
  },
  setState(partial) {
    state = { ...state, ...partial };
    if (Array.isArray(state.executionLog)) {
      state = { ...state, executionLog: capExecutionLogInMemory(state.executionLog) };
    }
    emit();
    schedulePersist();
  },
  /** Batch updates without multiple emits (still one persist schedule). */
  patch(partial) {
    state = { ...state, ...partial };
    if (Array.isArray(state.executionLog)) {
      state = { ...state, executionLog: capExecutionLogInMemory(state.executionLog) };
    }
    emit();
    schedulePersist();
  },
  resetPersisted() {
    state = { ...defaultState };
    if (typeof window !== 'undefined') {
      const k = graphPipelineUiStorageKey();
      const fk = graphPipelineUiLegacyFallbackKey();
      if (k) removeKvSync(k);
      if (fk) removeKvSync(fk);
    }
    emit();
    persistNow();
  },
  dismissRunInterrupted() {
    state = { ...state, runInterrupted: false, runError: null };
    emit();
    schedulePersist();
  },
  clearPipelineCheckpoint() {
    state = { ...state, pipelineCheckpoint: null };
    emit();
    schedulePersist();
  },
  /** Reload state from KV for the current {@link getGraphPipelineSessionId}. */
  rehydrateFromPersisted() {
    state = readStorage();
    emit();
  },
  /** Write graph UI blob immediately (e.g. cooperative pause token for cross-tab Dashboard). */
  flushPersist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistNow();
  },
  /** In-memory empty state without disk writes (lobby). */
  resetToEmptyInMemory() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    state = { ...defaultState };
    emit();
  },
};

/** Any pipeline SSE path (graph, consciousness, one-shot, scheduler, pursuits) — Dashboard last-LLM hint. */
export function patchDashboardLlmFromPipelineSseEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  if (evt.type === 'module_complete' && evt.provider && evt.model) {
    graphPipelineStore.patch({
      lastLlmProvider: String(evt.provider),
      lastLlmModel: String(evt.model),
    });
  } else if (evt.type === 'complete' && evt.providerUsed && evt.modelUsed) {
    graphPipelineStore.patch({
      lastLlmProvider: String(evt.providerUsed),
      lastLlmModel: String(evt.modelUsed),
    });
  }
}

let mindStoragePrepStaleTimer = null;
if (typeof window !== 'undefined') {
  window.addEventListener(MIND_STORAGE_CHANGED, () => {
    if (mindStoragePrepStaleTimer) clearTimeout(mindStoragePrepStaleTimer);
    mindStoragePrepStaleTimer = setTimeout(() => {
      mindStoragePrepStaleTimer = null;
      graphPipelineStore.patch({ pipelineIntegrationPrepStale: true });
    }, 400);
  });
}
