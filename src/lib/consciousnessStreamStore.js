import { clipTextComplete } from '../../shared/textClip.mjs';
import { COGNITIVE_MODULES } from './cognitiveModules';
import { streamTimeLabel } from './conversationStreamEntries';
import { graphPipelineStore } from './graphPipelineStore';
import { getKvSync, removeKvSync, setKvSync } from './browserStorage';
import { consciousnessStreamDraftKey, consciousnessStreamUiKey } from './graphPipelineSessionScope';

const listeners = new Set();

export function subscribeConsciousnessStream(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  listeners.forEach((l) => l());
}

const defaultState = {
  entries: [],
  input: '',
  /** Mirrors graph run context for dashboard Topic; set when a run starts, cleared when it ends. */
  activeRunTopic: '',
  attachments: [],
  isProcessing: false,
  paused: false,
  mindPhase: 'focus',
  arousal: 0.55,
  streamIntent: '',
  runInterrupted: false,
  dbHydrated: false,
};

function readUiPrefs() {
  if (typeof window === 'undefined') return {};
  const key = consciousnessStreamUiKey();
  if (!key) return {};
  try {
    const raw = getKvSync(key);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return {
      mindPhase: typeof p.mindPhase === 'string' ? p.mindPhase : undefined,
      arousal: Number.isFinite(Number(p.arousal)) ? Number(p.arousal) : undefined,
      streamIntent: typeof p.streamIntent === 'string' ? p.streamIntent : undefined,
      paused: typeof p.paused === 'boolean' ? p.paused : undefined,
    };
  } catch {
    return {};
  }
}

function readDraft() {
  if (typeof window === 'undefined') return { inFlight: false, entries: [], interrupted: false };
  const key = consciousnessStreamDraftKey();
  if (!key) return { inFlight: false, entries: [], interrupted: false };
  try {
    const raw = getKvSync(key);
    if (!raw) return { inFlight: false, entries: [], interrupted: false };
    const p = JSON.parse(raw);
    const inFlight = Boolean(p.inFlight);
    const entries = Array.isArray(p.entries) ? p.entries : [];
    return { inFlight, entries, interrupted: inFlight };
  } catch {
    return { inFlight: false, entries: [], interrupted: false };
  }
}

function persistUiPrefs(s) {
  if (typeof window === 'undefined') return;
  const key = consciousnessStreamUiKey();
  if (!key) return;
  try {
    setKvSync(
      key,
      JSON.stringify({
        mindPhase: s.mindPhase,
        arousal: s.arousal,
        streamIntent: s.streamIntent,
        paused: s.paused,
      })
    );
  } catch {
    /* quota */
  }
}

let persistDraftTimer = null;

function persistDraftNow(entries, inFlight) {
  if (typeof window === 'undefined') return;
  const key = consciousnessStreamDraftKey();
  if (!key) return;
  try {
    const capped = (entries || []).slice(-280).map((e) => ({
      ...e,
      content: typeof e.content === 'string' ? clipTextComplete(e.content, 12_000, { ellipsis: false }) : e.content,
      detail: typeof e.detail === 'string' ? clipTextComplete(e.detail, 8000, { ellipsis: false }) : e.detail,
    }));
    if (!inFlight && capped.length === 0) {
      removeKvSync(key);
      return;
    }
    setKvSync(key, JSON.stringify({ inFlight, entries: capped, savedAt: Date.now() }));
  } catch {
    /* quota */
  }
}

function scheduleDraftPersist(entries, inFlight) {
  if (inFlight) {
    if (persistDraftTimer) return;
    persistDraftTimer = setTimeout(() => {
      persistDraftTimer = null;
      persistDraftNow(entries, true);
    }, 600);
    return;
  }
  persistDraftNow(entries, false);
}

let state = {
  ...defaultState,
  entries: [],
  isProcessing: false,
  runInterrupted: false,
  dbHydrated: false,
};

/**
 * Call after loading messages from DB. Merges interrupted draft tail.
 * Pass `{ force: true }` to replace state while a run is in flight (e.g. explicit reload).
 * Optional `conversationRows`: role/content/shared_memory message rows — last assistant `arousal` updates the live bar.
 */
export function hydrateConsciousnessStreamFromDb(dbEntries, { force = false, conversationRows = null } = {}) {
  if (!force && state.isProcessing) {
    return;
  }
  const draft = readDraft();
  const ids = new Set((dbEntries || []).map((e) => e.id));
  let merged = dbEntries || [];
  if (draft.interrupted && draft.entries.length) {
    for (const e of draft.entries) {
      if (e?.id && !ids.has(e.id)) {
        merged = [...merged, e];
        ids.add(e.id);
      }
    }
  }
  let arousalFromSession = null;
  if (Array.isArray(conversationRows) && conversationRows.length) {
    const dateMs = (r) => { const t = Date.parse(r?.created_date); return Number.isFinite(t) ? t : 0; };
    const sorted = [...conversationRows].sort((a, b) => dateMs(a) - dateMs(b));
    const lastAsst = [...sorted].reverse().find((r) => r.role === 'assistant');
    const ar = lastAsst?.shared_memory?.arousal;
    if (typeof ar === 'number' && Number.isFinite(ar)) arousalFromSession = ar;
  }
  state = {
    ...state,
    ...(arousalFromSession != null ? { arousal: arousalFromSession } : {}),
    entries: merged,
    dbHydrated: true,
    isProcessing: false,
    activeRunTopic: '',
  };
  if (draft.interrupted) {
    const dk = consciousnessStreamDraftKey();
    if (dk) removeKvSync(dk);
  }
  if (arousalFromSession != null) {
    persistUiPrefs(state);
  }
  emit();
}

export const consciousnessStreamStore = {
  getState() {
    return state;
  },
  setState(partial) {
    state = { ...state, ...partial };
    emit();
    persistUiPrefs(state);
    if (state.isProcessing) {
      scheduleDraftPersist(state.entries, true);
    }
  },
  patch(partial) {
    state = { ...state, ...partial };
    emit();
    persistUiPrefs(state);
    if (state.isProcessing) {
      scheduleDraftPersist(state.entries, true);
    }
  },
  appendEntry(type, content, moduleId = null, extra = {}) {
    const { bypassPause, ...restExtra } = extra;
    if (state.paused && !bypassPause) return;
    const mod = moduleId ? COGNITIVE_MODULES.find((m) => m.id === moduleId) : null;
    const row = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      content,
      moduleId,
      moduleName: mod?.name,
      moduleColor: mod?.color,
      moduleGlyph: mod?.name ? mod.name.charAt(0) : '·',
      time: streamTimeLabel(),
      ...restExtra,
    };
    state = { ...state, entries: [...state.entries, row] };
    emit();
    if (state.isProcessing) {
      scheduleDraftPersist(state.entries, true);
    }
  },
  clearDraftPersist() {
    if (typeof window !== 'undefined') {
      const key = consciousnessStreamDraftKey();
      if (key) removeKvSync(key);
    }
  },
  dismissInterrupted() {
    state = { ...state, runInterrupted: false };
    emit();
    graphPipelineStore.dismissRunInterrupted();
  },
  clearEntries() {
    state = { ...state, entries: [], activeRunTopic: '' };
    emit();
    const key = consciousnessStreamDraftKey();
    if (typeof window !== 'undefined' && key) {
      removeKvSync(key);
    }
    graphPipelineStore.patch({
      moduleStatuses: {},
      moduleOutputs: {},
      finalOutput: '',
      executionLog: [],
      loopCount: 0,
      lastSharedMemory: null,
      runError: null,
      runContextLabel: '',
    });
  },
  /** Reload prefs + draft flags from KV for the current session (after {@link setGraphPipelineSessionId}). */
  rehydrateFromPersisted() {
    if (persistDraftTimer) {
      clearTimeout(persistDraftTimer);
      persistDraftTimer = null;
    }
    const prefs = readUiPrefs();
    const draft = readDraft();
    const graphReloadInterrupted = Boolean(graphPipelineStore.getState().runInterrupted);
    state = {
      ...defaultState,
      ...prefs,
      paused: false,
      entries: [],
      isProcessing: false,
      runInterrupted: Boolean(draft.interrupted) || graphReloadInterrupted,
      dbHydrated: false,
    };
    emit();
  },
  resetToEmptyInMemory() {
    if (persistDraftTimer) {
      clearTimeout(persistDraftTimer);
      persistDraftTimer = null;
    }
    state = {
      ...defaultState,
      entries: [],
      isProcessing: false,
      runInterrupted: false,
      dbHydrated: false,
    };
    emit();
  },
};
