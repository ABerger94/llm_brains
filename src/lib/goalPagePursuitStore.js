import { clipTextComplete } from '../../shared/textClip.mjs';
import { freshPursuitPipelineUiForNewGraphRun, initialGoalPipelineUi } from './goalPipelineSseUi';
import { getKvSync, removeKvSync, setKvSync } from './browserStorage';

const STORAGE_KEY = 'mybrain_goal_page_pursuits_v1';
const listeners = new Set();

/**
 * @typedef {{
 *   pursuitProgress: string | null,
 *   goalPipelineUi: ReturnType<typeof initialGoalPipelineUi>,
 *   running: boolean,
 *   goalStatement?: string,
 *   interruptedByReload?: boolean,
 *   cooperativePaused?: boolean,
 *   mindStorageProfile?: string,
 * }} GoalPursuitEntry
 */

function emptyEntry() {
  return {
    pursuitProgress: null,
    goalPipelineUi: initialGoalPipelineUi(),
    running: false,
    goalStatement: undefined,
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
  const uiIn = e.goalPipelineUi;
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
      : initialGoalPipelineUi();

  const coopPause = Boolean(e.cooperativePaused);

  const out = {
    pursuitProgress: typeof e.pursuitProgress === 'string' ? e.pursuitProgress : null,
    goalPipelineUi: ui,
    running: false,
    goalStatement: typeof e.goalStatement === 'string' ? e.goalStatement : undefined,
    interruptedByReload: Boolean(e.interruptedByReload),
    cooperativePaused: coopPause,
    mindStorageProfile: typeof e.mindStorageProfile === 'string' ? e.mindStorageProfile : undefined,
  };

  if (running) {
    if (coopPause) {
      out.interruptedByReload = false;
      out.cooperativePaused = true;
      if (!out.pursuitProgress) {
        out.pursuitProgress = 'Paused — cooperative checkpoint saved. Open Goals to continue.';
      }
    } else {
      out.interruptedByReload = true;
      out.cooperativePaused = false;
      if (!out.pursuitProgress) out.pursuitProgress = 'Interrupted by page reload';
    }
  }

  if (!out.cooperativePaused && !out.interruptedByReload) {
    out.goalPipelineUi = freshPursuitPipelineUiForNewGraphRun(out.goalPipelineUi);
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

/** @type {{ pursuits: Record<string, GoalPursuitEntry> }} */
let snapshot = readPersistedSnapshot() || { pursuits: {} };

let persistTimer = null;

function persistGoalPursuitsNow() {
  if (typeof window === 'undefined') return;
  try {
    const pursuits = {};
    for (const [id, e] of Object.entries(snapshot.pursuits)) {
      const ui = e.goalPipelineUi || initialGoalPipelineUi();
      pursuits[id] = {
        running: Boolean(e.running),
        interruptedByReload: Boolean(e.interruptedByReload),
        cooperativePaused: Boolean(e.cooperativePaused),
        pursuitProgress: e.pursuitProgress,
        goalStatement: e.goalStatement,
        mindStorageProfile: e.mindStorageProfile || undefined,
        goalPipelineUi: {
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

function schedulePersistGoalPursuits() {
  if (typeof window === 'undefined') return;
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistGoalPursuitsNow();
  }, 400);
}

function flushPersistGoalPursuits() {
  if (persistTimer != null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistGoalPursuitsNow();
}

/** Immediate KV write — use after cooperative pause so disk does not keep stale `running: true`. */
export function flushGoalPursuitsPersistNow() {
  flushPersistGoalPursuits();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPersistGoalPursuits);
}

function emit() {
  for (const l of listeners) l();
  schedulePersistGoalPursuits();
}

export function subscribeGoalPagePursuit(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getGoalPagePursuitSnapshot() {
  return snapshot;
}

/**
 * Re-merge pursuit slots from persisted KV (Dashboard “Reload runs”) without a full page refresh.
 * @returns {number} pursuits updated from disk
 */
export function reloadGoalPursuitsFromPersistedDisk() {
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
      !String(e.goalPipelineUi?.finalOutput || '').trim()
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
 * {@link reloadGoalPursuitsFromPersistedDisk}, drops slots not present in persisted data.
 */
export function replaceGoalPursuitsSnapshotFromImportedKv() {
  const disk = readPersistedSnapshot();
  snapshot = disk || { pursuits: {} };
  emit();
}

/**
 * See {@link sanitizeCuriosityPursuitsReloadFlagsAfterMindImport} — same for goals.
 */
export function sanitizeGoalPursuitsReloadFlagsAfterMindImport() {
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
  flushGoalPursuitsPersistNow();
}

/**
 * Merge fields into one pursuit slot (creates slot if missing).
 * @param {string} goalId
 * @param {Partial<GoalPursuitEntry>} patch
 */
export function upsertGoalPursuit(goalId, patch) {
  const id = String(goalId || '');
  if (!id) return;
  const prev = snapshot.pursuits[id] || emptyEntry();
  let nextEntry = { ...prev, ...patch };
  if (nextEntry.running === false && !nextEntry.cooperativePaused && !nextEntry.interruptedByReload) {
    nextEntry = {
      ...nextEntry,
      goalPipelineUi: freshPursuitPipelineUiForNewGraphRun(nextEntry.goalPipelineUi),
    };
  }
  snapshot = {
    ...snapshot,
    pursuits: { ...snapshot.pursuits, [id]: nextEntry },
  };
  emit();
}

/**
 * @param {string} goalId
 * @param {Partial<GoalPursuitEntry>} patch
 */
export function patchGoalPagePursuitEntry(goalId, patch) {
  const id = String(goalId || '');
  if (!id || !snapshot.pursuits[id]) return;
  let merged = { ...snapshot.pursuits[id], ...patch };
  if (merged.running === false && !merged.cooperativePaused && !merged.interruptedByReload) {
    merged = {
      ...merged,
      goalPipelineUi: freshPursuitPipelineUiForNewGraphRun(merged.goalPipelineUi),
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
 * @param {(prev: ReturnType<typeof initialGoalPipelineUi>) => ReturnType<typeof initialGoalPipelineUi>} updater
 */
export function updateGoalPagePursuitPipelineUiForId(goalId, updater) {
  const id = String(goalId || '');
  const entry = snapshot.pursuits[id];
  if (!entry) return;
  const prev = entry.goalPipelineUi;
  const next = updater(prev);
  if (next === prev) return;
  snapshot = {
    ...snapshot,
    pursuits: {
      ...snapshot.pursuits,
      [id]: { ...entry, goalPipelineUi: next },
    },
  };
  emit();
}

/**
 * Append one execution log line to every running pursuit in a single emit (see curiosity batch helper).
 * @param {{ time: number, msg: string }} line
 */
export function appendGoalPursuitExecutionLogLineAllRunning(line) {
  const pursuits = snapshot.pursuits;
  const next = { ...pursuits };
  let changed = false;
  for (const [id, e] of Object.entries(pursuits)) {
    if (!e?.running) continue;
    const prev = e.goalPipelineUi || initialGoalPipelineUi();
    next[id] = {
      ...e,
      goalPipelineUi: {
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

/** @param {string} goalId */
export function removeGoalPursuit(goalId) {
  const id = String(goalId || '');
  if (!id || !snapshot.pursuits[id]) return;
  const rest = { ...snapshot.pursuits };
  delete rest[id];
  snapshot = { ...snapshot, pursuits: rest };
  emit();
}
