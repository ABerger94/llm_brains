import { clipTextComplete } from '../../shared/textClip.mjs';
import { freshPursuitPipelineUiForNewGraphRun, initialCuriosityPipelineUi } from './curiosityPipelineSseUi';
import { getKvSync, removeKvSync, setKvSync } from './browserStorage';

const STORAGE_KEY = 'mybrain_curiosity_page_pursuits_v1';
const listeners = new Set();

/**
 * @typedef {{
 *   pursuitProgress: string | null,
 *   curiosityPipelineUi: ReturnType<typeof initialCuriosityPipelineUi>,
 *   running: boolean,
 *   question?: string,
 *   interruptedByReload?: boolean,
 *   cooperativePaused?: boolean,
 *   mindStorageProfile?: string,
 * }} CuriosityPursuitEntry
 */

function emptyEntry() {
  return {
    pursuitProgress: null,
    curiosityPipelineUi: initialCuriosityPipelineUi(),
    running: false,
    question: undefined,
    interruptedByReload: false,
    cooperativePaused: false,
    mindStorageProfile: undefined,
  };
}

function slimModuleOutputs(mo) {
  if (!mo || typeof mo !== 'object') return {};
  const out = {};
  for (const k of Object.keys(mo)) {
    out[k] = clipTextComplete(String(mo[k] || ''), 8000, { ellipsis: false });
  }
  return out;
}

/** @param {unknown} e */
function normalizeLoadedEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const running = Boolean(e.running);
  const uiIn = e.curiosityPipelineUi;
  const ui =
    uiIn && typeof uiIn === 'object'
      ? {
          executionLog: Array.isArray(uiIn.executionLog) ? uiIn.executionLog.slice(-40) : [],
          moduleStatuses: uiIn.moduleStatuses && typeof uiIn.moduleStatuses === 'object' ? uiIn.moduleStatuses : {},
          moduleOutputs: slimModuleOutputs(uiIn.moduleOutputs),
          loopCount: Number(uiIn.loopCount) || 0,
          finalOutput: clipTextComplete(String(uiIn.finalOutput || ''), 12000, { ellipsis: false }),
          metacognitionMaxReruns:
            uiIn.metacognitionMaxReruns != null && Number.isFinite(Number(uiIn.metacognitionMaxReruns))
              ? Number(uiIn.metacognitionMaxReruns)
              : null,
          metacognitionRerunDelayMinutes:
            uiIn.metacognitionRerunDelayMinutes != null &&
            Number.isFinite(Number(uiIn.metacognitionRerunDelayMinutes))
              ? Number(uiIn.metacognitionRerunDelayMinutes)
              : null,
        }
      : initialCuriosityPipelineUi();

  const coopPause = Boolean(e.cooperativePaused);

  const out = {
    pursuitProgress: typeof e.pursuitProgress === 'string' ? e.pursuitProgress : null,
    curiosityPipelineUi: ui,
    running: false,
    question: typeof e.question === 'string' ? e.question : undefined,
    interruptedByReload: Boolean(e.interruptedByReload),
    cooperativePaused: coopPause,
    mindStorageProfile: typeof e.mindStorageProfile === 'string' ? e.mindStorageProfile : undefined,
  };

  if (running) {
    if (coopPause) {
      out.interruptedByReload = false;
      out.cooperativePaused = true;
      if (!out.pursuitProgress) {
        out.pursuitProgress = 'Paused — cooperative checkpoint saved. Open Curiosity to continue.';
      }
    } else {
      out.interruptedByReload = true;
      out.cooperativePaused = false;
      if (!out.pursuitProgress) out.pursuitProgress = 'Interrupted by page reload';
    }
  }

  if (!out.cooperativePaused && !out.interruptedByReload) {
    out.curiosityPipelineUi = freshPursuitPipelineUiForNewGraphRun(out.curiosityPipelineUi);
  }
  return out;
}

function readPersistedSnapshot() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = getKvSync(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    const pursuits = {};
    for (const [id, e] of Object.entries(p.pursuits || {})) {
      const n = normalizeLoadedEntry(e);
      if (n) pursuits[id] = n;
    }
    return Object.keys(pursuits).length ? { pursuits } : null;
  } catch {
    return null;
  }
}

/** @type {{ pursuits: Record<string, CuriosityPursuitEntry> }} */
let snapshot = readPersistedSnapshot() || { pursuits: {} };

let persistTimer = null;

function persistCuriosityPursuitsNow() {
  if (typeof window === 'undefined') return;
  try {
    const pursuits = {};
    for (const [id, e] of Object.entries(snapshot.pursuits)) {
      const ui = e.curiosityPipelineUi || initialCuriosityPipelineUi();
      pursuits[id] = {
        running: Boolean(e.running),
        interruptedByReload: Boolean(e.interruptedByReload),
        cooperativePaused: Boolean(e.cooperativePaused),
        pursuitProgress: e.pursuitProgress,
        question: e.question,
        mindStorageProfile: e.mindStorageProfile || undefined,
        curiosityPipelineUi: {
          executionLog: Array.isArray(ui.executionLog) ? ui.executionLog.slice(-40) : [],
          moduleStatuses: ui.moduleStatuses || {},
          moduleOutputs: slimModuleOutputs(ui.moduleOutputs),
          loopCount: Number(ui.loopCount) || 0,
          finalOutput: clipTextComplete(String(ui.finalOutput || ''), 12000, { ellipsis: false }),
          metacognitionMaxReruns:
            ui.metacognitionMaxReruns != null && Number.isFinite(Number(ui.metacognitionMaxReruns))
              ? Number(ui.metacognitionMaxReruns)
              : null,
          metacognitionRerunDelayMinutes:
            ui.metacognitionRerunDelayMinutes != null &&
            Number.isFinite(Number(ui.metacognitionRerunDelayMinutes))
              ? Number(ui.metacognitionRerunDelayMinutes)
              : null,
        },
      };
    }
    if (Object.keys(pursuits).length === 0) {
      removeKvSync(STORAGE_KEY);
      return;
    }
    setKvSync(STORAGE_KEY, JSON.stringify({ pursuits, savedAt: Date.now() }));
  } catch {
    /* quota */
  }
}

function schedulePersistCuriosityPursuits() {
  if (typeof window === 'undefined') return;
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistCuriosityPursuitsNow();
  }, 400);
}

function flushPersistCuriosityPursuits() {
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistCuriosityPursuitsNow();
}

/** Immediate KV write — use after cooperative pause so disk does not keep stale `running: true`. */
export function flushCuriosityPursuitsPersistNow() {
  flushPersistCuriosityPursuits();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPersistCuriosityPursuits);
}

function emit() {
  for (const l of listeners) l();
  schedulePersistCuriosityPursuits();
}

export function subscribeCuriosityPagePursuit(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCuriosityPagePursuitSnapshot() {
  return snapshot;
}

/**
 * Re-merge pursuit slots from persisted KV (Dashboard “Reload runs”) without a full page refresh.
 * @returns {number} pursuits updated from disk
 */
export function reloadCuriosityPursuitsFromPersistedDisk() {
  const disk = readPersistedSnapshot();
  if (!disk || !Object.keys(disk.pursuits).length) return 0;
  const next = { ...snapshot.pursuits };
  let n = 0;
  for (const [id, e] of Object.entries(disk.pursuits)) {
    // Don't overwrite a live in-memory run with stale disk data
    if (next[id]?.running) continue;
    // Only merge entries that are relevant (interrupted or have data worth restoring)
    if (
      !e.interruptedByReload &&
      !e.running &&
      !e.cooperativePaused &&
      !String(e.curiosityPipelineUi?.finalOutput || '').trim()
    )
      continue;
    const normalized = normalizeLoadedEntry(e);
    if (!normalized) continue;
    next[id] = normalized;
    n += 1;
  }
  snapshot = { pursuits: next };
  emit();
  return n;
}

/**
 * Replace in-memory pursuits entirely from KV (after mind archive import). Unlike
 * {@link reloadCuriosityPursuitsFromPersistedDisk}, drops slots not present in persisted data.
 */
export function replaceCuriosityPursuitsSnapshotFromImportedKv() {
  const disk = readPersistedSnapshot();
  snapshot = disk || { pursuits: {} };
  emit();
}

/**
 * After a mind archive import, stale `interruptedByReload` flags from the backup
 * (running was false) would make "Resume all" fan out hundreds of pursuits.
 * Clear reload flags when there is no cooperative checkpoint pause — real
 * reload-interrupted work is still covered by `interruptedByReload` in a live session.
 */
export function sanitizeCuriosityPursuitsReloadFlagsAfterMindImport() {
  const next = { ...snapshot.pursuits };
  let changed = false;
  for (const [id, e] of Object.entries(next)) {
    if (e?.interruptedByReload && !e?.cooperativePaused) {
      next[id] = { ...e, interruptedByReload: false };
      changed = true;
    }
  }
  if (!changed) return;
  snapshot = { pursuits: next };
  emit();
  flushCuriosityPursuitsPersistNow();
}

/**
 * Merge fields into one pursuit slot (creates slot if missing).
 * @param {string} curiosityId
 * @param {Partial<CuriosityPursuitEntry>} patch
 */
export function upsertCuriosityPursuit(curiosityId, patch) {
  const id = String(curiosityId || '');
  if (!id) return;
  const prev = snapshot.pursuits[id] || emptyEntry();
  let nextEntry = { ...prev, ...patch };
  if (nextEntry.running === false && !nextEntry.cooperativePaused && !nextEntry.interruptedByReload) {
    nextEntry = {
      ...nextEntry,
      curiosityPipelineUi: freshPursuitPipelineUiForNewGraphRun(nextEntry.curiosityPipelineUi),
    };
  }
  snapshot = {
    ...snapshot,
    pursuits: { ...snapshot.pursuits, [id]: nextEntry },
  };
  emit();
}

/**
 * @param {string} curiosityId
 * @param {Partial<CuriosityPursuitEntry>} patch
 */
export function patchCuriosityPursuitEntry(curiosityId, patch) {
  const id = String(curiosityId || '');
  if (!id || !snapshot.pursuits[id]) return;
  let merged = { ...snapshot.pursuits[id], ...patch };
  if (merged.running === false && !merged.cooperativePaused && !merged.interruptedByReload) {
    merged = {
      ...merged,
      curiosityPipelineUi: freshPursuitPipelineUiForNewGraphRun(merged.curiosityPipelineUi),
    };
  }
  snapshot = {
    ...snapshot,
    pursuits: {
      ...snapshot.pursuits,
      [id]: merged,
    },
  };
  emit();
}

/**
 * @param {(prev: ReturnType<typeof initialCuriosityPipelineUi>) => ReturnType<typeof initialCuriosityPipelineUi>} updater
 */
export function updateCuriosityPursuitPipelineUiForId(curiosityId, updater) {
  const id = String(curiosityId || '');
  const entry = snapshot.pursuits[id];
  if (!entry) return;
  const prev = entry.curiosityPipelineUi;
  const next = updater(prev);
  if (next === prev) return;
  snapshot = {
    ...snapshot,
    pursuits: {
      ...snapshot.pursuits,
      [id]: { ...entry, curiosityPipelineUi: next },
    },
  };
  emit();
}

/**
 * Append one execution log line to every running pursuit in a single emit.
 * Used by Dashboard “Pause & save all” so N running pursuits do not trigger N Dashboard re-renders.
 * @param {{ time: number, msg: string }} line
 */
export function appendCuriosityPursuitExecutionLogLineAllRunning(line) {
  const pursuits = snapshot.pursuits;
  const next = { ...pursuits };
  let changed = false;
  for (const [id, e] of Object.entries(pursuits)) {
    if (!e?.running) continue;
    const prev = e.curiosityPipelineUi || initialCuriosityPipelineUi();
    next[id] = {
      ...e,
      curiosityPipelineUi: {
        ...prev,
        executionLog: [...(prev.executionLog || []), line].slice(-40),
      },
    };
    changed = true;
  }
  if (!changed) return;
  snapshot = { pursuits: next };
  emit();
}

/** @param {string} curiosityId */
export function removeCuriosityPursuit(curiosityId) {
  const id = String(curiosityId || '');
  if (!id || !snapshot.pursuits[id]) return;
  const rest = { ...snapshot.pursuits };
  delete rest[id];
  snapshot = { ...snapshot, pursuits: rest };
  emit();
}
