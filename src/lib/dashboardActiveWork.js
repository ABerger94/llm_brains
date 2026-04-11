import {
  getFirstProcessingModuleName,
  getServerExecutionLayers,
  hasKnownPipelineModuleProcessing,
} from './cognitiveModules';
import { graphPipelineStore, subscribeGraphPipeline, validCooperativePipelineCheckpoint } from './graphPipelineStore';
import { consciousnessStreamStore, subscribeConsciousnessStream } from './consciousnessStreamStore';
import {
  getCuriosityPagePursuitSnapshot,
  subscribeCuriosityPagePursuit,
} from './curiosityPagePursuitStore';
import { getGoalPagePursuitSnapshot, subscribeGoalPagePursuit } from './goalPagePursuitStore';
import { isTransientReconnectFailure } from './reconnectRecovery';
import { MIND_STORAGE_CHANGED } from './mindStorageEvents';
import {
  getDashboardScheduledRunningFromDbCache,
  subscribeDashboardScheduledRunningSync,
  syncDashboardScheduledRunningFromDb,
} from './dashboardScheduledRunningSync';
import { getScheduledTaskTopicSummary } from './schedulerTaskDisplayTopic';
import { getSchedulerTaskTypeLabel } from './schedulerTaskLabels';
import {
  getSchedulerPipelineUiSnapshot,
  subscribeSchedulerPipelineUi,
} from './schedulerPipelineUiStore';
import {
  formatActivePipelineDetail,
  formatGraphRunProgressLine,
  formatPursuitPipelineStatusDetailLines,
  formatPursuitPipelineStatusDetailWithInterrupted,
} from './pursuitThreadStatusFormat';
import { graphSessionDisplayTitle } from '../components/graphPipeline/GraphSessionLabelInline';
import { PIPELINE_DASHBOARD_FALLBACK_DETAIL } from './activePipelineStatusLabels';
import { peekConsciousnessStreamDraftForSession, peekGraphPipelineUiPersisted } from './graphPipelineCrossSessionPeek';
import { getActiveConsciousnessStreamGraphSessionId } from './consciousnessStreamRunner';
import {
  getGraphPipelineSessionRegistry,
  getLastOpenedGraphPipelineSessionId,
  subscribeGraphPipelineRegistry,
} from './graphPipelineSessionRegistry';
import { DEFAULT_GRAPH_SESSION_ID, getGraphPipelineSessionId } from './graphPipelineSessionScope';

function clip(s, max = 160) {
  const t = String(s || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function lastUserPromptFromEntries(entries) {
  if (!Array.isArray(entries)) return '';
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e?.type === 'user-input') {
      const c = String(e.content || '').trim();
      if (c) return c;
    }
  }
  return '';
}

/** Primary line max length (topic / prompt / question) — same for every pipeline row. */
const ACTIVE_PIPELINE_PRIMARY_MAX = 200;

function graphPipelineDeepLinkForSession(sessionId) {
  const sid = String(sessionId || '').trim() || DEFAULT_GRAPH_SESSION_ID;
  return `/graph-pipeline/${encodeURIComponent(sid)}#graph-pipeline-bottom`;
}

/**
 * Registry row + persisted peek: active when a run is in flight for this session.
 * Uses in-memory graph/consciousness stores for {@link getActiveConsciousnessStreamGraphSessionId} so the
 * Dashboard row does not flicker off while KV persist lags (debounced flush) or `healGraphRegistryWhenPersistSaysIdle`
 * mis-fires. Also treats peek `moduleStatuses.processing` as active so cross-tab rows survive until modules settle.
 */
function peekModuleStatusesShowProcessing(peek) {
  const ms = peek?.moduleStatuses && typeof peek.moduleStatuses === 'object' ? peek.moduleStatuses : {};
  return hasKnownPipelineModuleProcessing(ms);
}

/**
 * Persisted graph UI shows a finished run with Voice text and no module still processing.
 * Used so Dashboard / Live Analytics drop “active” cards once Voice output is present (registry/KV can lag).
 * @param {ReturnType<typeof peekGraphPipelineUiPersisted> | null | undefined} peek
 * @param {{ inFlight?: boolean }} draft
 */
export function isGraphPeekPipelineCompleteWithVoice(peek, draft) {
  if (!peek || peek.isRunning) return false;
  if (draft?.inFlight) return false;
  const fo = String(peek.finalOutput || '').trim();
  if (!fo) return false;
  if (peekModuleStatusesShowProcessing(peek)) return false;
  return true;
}

/**
 * Idle for Dashboard purposes: nothing says the pipeline is actively running.
 * A run is effectively complete when no flags say "running" and no modules are processing,
 * even if `finalOutput` is empty (e.g. interrupted before Voice).
 */
export function isGraphPeekPipelineEffectivelyComplete(peek, draft) {
  if (isGraphPeekPipelineCompleteWithVoice(peek, draft)) return true;
  if (!peek) return false;
  if (draft?.inFlight) return false;
  if (peek.uploading) return false;
  if (peek.isRunning) return false;
  if (peekModuleStatusesShowProcessing(peek)) return false;
  return true;
}

function graphSessionLooksActiveFromPeek(s, peek, draft) {
  const sid = String(s?.id || '').trim();
  const streamSid = getActiveConsciousnessStreamGraphSessionId();
  if (sid && streamSid && sid === streamSid) {
    const gp = graphPipelineStore.getState();
    const cs = consciousnessStreamStore.getState();
    if (gp.isRunning || cs.isProcessing) return true;
    return false;
  }
  if (isGraphPeekPipelineEffectivelyComplete(peek, draft)) return false;
  const registryOrKvSaysRunning = Boolean(
    s.isProcessing || peek?.isRunning || draft.inFlight
  );
  if (registryOrKvSaysRunning) return true;
  return false;
}

/**
 * Linear progress by pipeline stage (layers), aligned with graph / pursuit module order.
 * @param {Record<string, string>} moduleStatuses
 * @param {boolean} isActive
 * @returns {number} 0–100
 */
function computeDashboardPipelineProgress(moduleStatuses, isActive) {
  const layers = getServerExecutionLayers();
  const total = layers.length;
  if (total === 0) return isActive ? 5 : 0;

  const ms = moduleStatuses && typeof moduleStatuses === 'object' ? moduleStatuses : {};
  let anyStatus = false;
  let completedLayers = 0;

  for (const row of layers) {
    const ids = row.moduleIds || [];
    if (ids.length === 0) continue;

    let allComplete = true;
    let anyProcessing = false;
    for (const id of ids) {
      const st = ms[id];
      if (st) anyStatus = true;
      if (st === 'processing') {
        anyProcessing = true;
        allComplete = false;
      } else if (st !== 'complete') {
        allComplete = false;
      }
    }

    if (allComplete) {
      completedLayers += 1;
    } else if (anyProcessing) {
      return Math.min(100, Math.round(((completedLayers + 0.55) / total) * 100));
    } else {
      break;
    }
  }

  if (completedLayers >= total) return 100;
  if (isActive && !anyStatus) return 8;
  return Math.min(100, Math.round((completedLayers / total) * 100));
}

/**
 * @typedef {{
 *   key: string,
 *   pageName: string,
 *   href: string,
 *   title: string,
 *   detail: string,
 *   variant: 'graph' | 'curiosity' | 'goal' | 'scheduler',
 *   pipelineProgress: number | null,
 *   pipelineProgressIndeterminate?: boolean,
 *   moduleStatuses?: Record<string, string> | null,
 *   interrupted?: boolean,
 *   paused?: boolean,
 * }} DashboardActiveWorkRow
 */

/**
 * Build rows for “what is running” (interactive UI–tracked work plus in-flight scheduler pipeline jobs).
 * @returns {DashboardActiveWorkRow[]}
 */
export function buildDashboardActiveWorkRows() {
  /** @type {DashboardActiveWorkRow[]} */
  const rows = [];

  const idle = PIPELINE_DASHBOARD_FALLBACK_DETAIL;

  const gp = graphPipelineStore.getState();
  const cs = consciousnessStreamStore.getState();
  const graphOrStreamActive = Boolean(gp.isRunning || cs.isProcessing);

  const graphInterrupted =
    !graphOrStreamActive &&
    (Boolean(gp.runInterrupted) ||
      Boolean(cs.runInterrupted) ||
      (gp.runError && isTransientReconnectFailure(gp.runError)));

  const cooperativeCheckpoint = validCooperativePipelineCheckpoint(gp.pipelineCheckpoint);

  const boundGraphSid = getGraphPipelineSessionId();
  /** @type {Set<string>} */
  const handledGraphSessionIds = new Set();

  if (graphOrStreamActive) {
    const modName = getFirstProcessingModuleName(gp.moduleStatuses);
    const uploading = Boolean(gp.uploading);
    const promptHint =
      clip(String(cs.activeRunTopic || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(String(gp.runContextLabel || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(lastUserPromptFromEntries(cs.entries), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(gp.input, ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(String(cs.input || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX);

    const title = promptHint || 'Graph pipeline';

    const lead = formatGraphRunProgressLine({
      uploading,
      moduleName: modName,
      isActive: graphOrStreamActive,
    });
    const tail = [];
    if (gp.loopCount > 0) tail.push(`Supervisor reruns: ${gp.loopCount}`);
    const detail = formatActivePipelineDetail(lead, tail, idle);

    const sessionForRow =
      boundGraphSid ||
      getActiveConsciousnessStreamGraphSessionId() ||
      getLastOpenedGraphPipelineSessionId() ||
      DEFAULT_GRAPH_SESSION_ID;
    handledGraphSessionIds.add(sessionForRow);

    rows.push({
      key: 'graph-pipeline',
      pageName: 'Graph Pipeline',
      href: graphPipelineDeepLinkForSession(sessionForRow),
      title,
      detail,
      variant: 'graph',
      pipelineProgress: computeDashboardPipelineProgress(gp.moduleStatuses, graphOrStreamActive),
      pipelineProgressIndeterminate: false,
      moduleStatuses: gp.moduleStatuses,
      interrupted: false,
    });
  }

  /**
   * Per-session registry + KV peek: must run **before** cooperative-checkpoint / interrupted-only rows.
   * Otherwise we add the checkpoint session to `handledGraphSessionIds` and skip a still-active session
   * (e.g. cross-tab or registry-driven runs that do not mirror `gp.isRunning` in this tab).
   */
  const registry = typeof window !== 'undefined' ? getGraphPipelineSessionRegistry() : [];
  for (const s of registry) {
    const sid = String(s?.id || '').trim();
    if (!sid) continue;
    const peek = peekGraphPipelineUiPersisted(sid);
    const draft = peekConsciousnessStreamDraftForSession(sid);
    const looksActive = graphSessionLooksActiveFromPeek(s, peek, draft);
    if (!looksActive) continue;
    if (handledGraphSessionIds.has(sid)) continue;

    const ms = peek?.moduleStatuses && typeof peek.moduleStatuses === 'object' ? peek.moduleStatuses : {};
    const modName = getFirstProcessingModuleName(ms);
    const uploading = Boolean(peek?.uploading);
    const promptHint =
      clip(String(peek?.runContextLabel || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(lastUserPromptFromEntries(draft.entries), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(String(peek?.input || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(graphSessionDisplayTitle(sid, s.label, s.threadRootLabel), ACTIVE_PIPELINE_PRIMARY_MAX);

    const title = promptHint || 'Graph pipeline';
    const lead = formatGraphRunProgressLine({
      uploading,
      moduleName: modName,
      isActive: true,
    });
    const tail = [];
    const lc = Number(peek?.loopCount) || 0;
    if (lc > 0) tail.push(`Supervisor reruns: ${lc}`);
    const detail = formatActivePipelineDetail(lead, tail, idle);

    handledGraphSessionIds.add(sid);
    rows.push({
      key: `graph-pipeline-session-${sid}`,
      pageName: 'Graph Pipeline',
      href: graphPipelineDeepLinkForSession(sid),
      title,
      detail,
      variant: 'graph',
      pipelineProgress: computeDashboardPipelineProgress(ms, true),
      pipelineProgressIndeterminate: false,
      moduleStatuses: ms,
      interrupted: false,
    });
  }

  if (!graphOrStreamActive && cooperativeCheckpoint) {
    const sessionForCk =
      boundGraphSid ||
      getActiveConsciousnessStreamGraphSessionId() ||
      getLastOpenedGraphPipelineSessionId() ||
      DEFAULT_GRAPH_SESSION_ID;
    if (!handledGraphSessionIds.has(sessionForCk)) {
      const promptHint =
        clip(String(cs.activeRunTopic || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
        clip(String(gp.runContextLabel || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
        clip(lastUserPromptFromEntries(cs.entries), ACTIVE_PIPELINE_PRIMARY_MAX) ||
        clip(gp.input, ACTIVE_PIPELINE_PRIMARY_MAX) ||
        clip(String(cs.input || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX);
      const title = promptHint || 'Graph pipeline';
      const alsoReloadNotice =
        Boolean(gp.runInterrupted) ||
        Boolean(cs.runInterrupted) ||
        (gp.runError && isTransientReconnectFailure(gp.runError));
      const detail = alsoReloadNotice
        ? formatActivePipelineDetail(
            'Paused — cooperative checkpoint saved',
            [
              'Resume from this save via Graph Pipeline (Continue), Dashboard Resume all, or dismiss the reload notice on the graph page — progress is kept until you discard.',
            ],
            'Paused'
          )
        : formatActivePipelineDetail(
            'Paused — cooperative checkpoint saved',
            ['Continue in Graph Pipeline or use Dashboard Resume all.'],
            'Paused'
          );
      handledGraphSessionIds.add(sessionForCk);
      rows.push({
        key: 'graph-pipeline-checkpoint',
        pageName: 'Graph Pipeline',
        href: graphPipelineDeepLinkForSession(sessionForCk),
        title,
        detail,
        variant: 'graph',
        pipelineProgress: computeDashboardPipelineProgress(gp.moduleStatuses, false),
        pipelineProgressIndeterminate: false,
        moduleStatuses: gp.moduleStatuses,
        interrupted: false,
        paused: true,
      });
    }
  }

  if (!graphOrStreamActive && graphInterrupted) {
    const sessionForInterrupted =
      boundGraphSid || getLastOpenedGraphPipelineSessionId() || DEFAULT_GRAPH_SESSION_ID;
    if (!handledGraphSessionIds.has(sessionForInterrupted)) {
      const promptHint =
        clip(String(cs.activeRunTopic || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
        clip(String(gp.runContextLabel || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
        clip(lastUserPromptFromEntries(cs.entries), ACTIVE_PIPELINE_PRIMARY_MAX) ||
        clip(gp.input, ACTIVE_PIPELINE_PRIMARY_MAX) ||
        clip(String(cs.input || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX);
      const title = promptHint || 'Graph pipeline';
      const errHint = gp.runError && isTransientReconnectFailure(gp.runError) ? 'Last error looks recoverable' : null;
      const detail = formatActivePipelineDetail(
        'Interrupted by reload or disconnect (no saved checkpoint in this session yet)',
        [errHint, 'Open Graph Pipeline to resume, or Clear to dismiss this notice'].filter(Boolean),
        'Interrupted'
      );
      rows.push({
        key: 'graph-pipeline-interrupted',
        pageName: 'Graph Pipeline',
        href: graphPipelineDeepLinkForSession(sessionForInterrupted),
        title,
        detail,
        variant: 'graph',
        pipelineProgress: computeDashboardPipelineProgress(gp.moduleStatuses, false),
        pipelineProgressIndeterminate: false,
        moduleStatuses: gp.moduleStatuses,
        interrupted: true,
      });
    }
  }

  const curiositySnap = getCuriosityPagePursuitSnapshot().pursuits || {};
  const goalsSnap = getGoalPagePursuitSnapshot().pursuits || {};
  const schedulerUiSnap = getSchedulerPipelineUiSnapshot();

  const schedulerRunning = getDashboardScheduledRunningFromDbCache() || [];
  for (const sch of schedulerRunning) {
    if (!sch?.id) continue;
    const typeKey = String(sch.task_type || '').trim().toLowerCase();
    const targetC = String(sch.target_curiosity_id || '').trim();
    const targetG = String(sch.target_goal_id || '').trim();

    if (typeKey === 'curiosity_pursuit') {
      if (targetC && curiositySnap[targetC]?.running) continue;
      if (!targetC && Object.values(curiositySnap).some((p) => p?.running)) continue;
    }
    if (typeKey === 'goal_pursuit') {
      if (targetG && goalsSnap[targetG]?.running) continue;
      if (!targetG && Object.values(goalsSnap).some((p) => p?.running)) continue;
    }

    const typeLabel = getSchedulerTaskTypeLabel(sch.task_type);
    const topic = getScheduledTaskTopicSummary(sch);
    const title =
      clip(topic, ACTIVE_PIPELINE_PRIMARY_MAX) || clip(typeLabel, ACTIVE_PIPELINE_PRIMARY_MAX);

    let pageName = 'Scheduler';
    let href = '/scheduler';
    let variant = 'scheduler';

    if (typeKey === 'curiosity_pursuit') {
      pageName = 'Curiosity Queue';
      variant = 'curiosity';
      href = targetC ? `/curiosity?focus=${encodeURIComponent(targetC)}` : '/scheduler';
    } else if (typeKey === 'goal_pursuit') {
      pageName = 'Goals';
      variant = 'goal';
      href = targetG ? `/goals?focus=${encodeURIComponent(targetG)}` : '/scheduler';
    } else {
      pageName = 'Graph Pipeline';
      href = `/graph-pipeline/scheduled/${encodeURIComponent(String(sch.id))}?from=default`;
    }

    const schedEntry = schedulerUiSnap.byTaskId?.[String(sch.id)];
    const ms = schedEntry?.ui?.moduleStatuses;
    const modName = getFirstProcessingModuleName(ms);
    const lead = formatGraphRunProgressLine({ moduleName: modName, isActive: true });
    const detail = formatActivePipelineDetail(lead, [typeLabel], idle);

    const pipelineProgress = computeDashboardPipelineProgress(ms || {}, true);

    rows.push({
      key: `scheduler-task-${sch.id}`,
      pageName,
      href,
      title,
      detail,
      variant,
      pipelineProgress,
      pipelineProgressIndeterminate: false,
      moduleStatuses: ms || null,
      interrupted: false,
    });
  }

  for (const [id, p] of Object.entries(curiositySnap)) {
    if (!p?.running && !p?.interruptedByReload && !p?.cooperativePaused) continue;
    const q = String(p.question || '').trim();
    const prog = String(p.pursuitProgress || '').trim();
    const modName = getFirstProcessingModuleName(p.curiosityPipelineUi?.moduleStatuses);
    const coopPausedIdle = Boolean(p?.cooperativePaused) && !p?.running;
    const detail = p?.interruptedByReload
      ? formatPursuitPipelineStatusDetailWithInterrupted({
          moduleName: modName,
          pursuitProgressRaw: prog,
          interruptedLead: 'Reload interrupted · open Curiosity to continue',
        })
      : coopPausedIdle
        ? formatPursuitPipelineStatusDetailWithInterrupted({
            moduleName: modName,
            pursuitProgressRaw: prog,
            interruptedLead: 'Paused — cooperative checkpoint · open Curiosity to continue',
          })
        : formatPursuitPipelineStatusDetailLines({
            moduleName: modName,
            pursuitProgressRaw: prog,
            idleFallback: idle,
          });
    rows.push({
      key: `curiosity-${id}`,
      pageName: 'Curiosity Queue',
      href: `/curiosity?focus=${encodeURIComponent(String(id))}`,
      title: q ? clip(q, ACTIVE_PIPELINE_PRIMARY_MAX) : `Curiosity ···${String(id).slice(-6)}`,
      detail,
      variant: 'curiosity',
      pipelineProgress: computeDashboardPipelineProgress(
        p.curiosityPipelineUi?.moduleStatuses,
        Boolean(p?.running)
      ),
      pipelineProgressIndeterminate: false,
      moduleStatuses: p.curiosityPipelineUi?.moduleStatuses || null,
      interrupted: Boolean(p?.interruptedByReload),
      paused: coopPausedIdle,
    });
  }

  for (const [id, p] of Object.entries(goalsSnap)) {
    if (!p?.running && !p?.interruptedByReload && !p?.cooperativePaused) continue;
    const g = String(p.goalStatement || '').trim();
    const prog = String(p.pursuitProgress || '').trim();
    const modName = getFirstProcessingModuleName(p.goalPipelineUi?.moduleStatuses);
    const coopPausedIdle = Boolean(p?.cooperativePaused) && !p?.running;
    const detail = p?.interruptedByReload
      ? formatPursuitPipelineStatusDetailWithInterrupted({
          moduleName: modName,
          pursuitProgressRaw: prog,
          interruptedLead: 'Reload interrupted · open Goals to continue',
        })
      : coopPausedIdle
        ? formatPursuitPipelineStatusDetailWithInterrupted({
            moduleName: modName,
            pursuitProgressRaw: prog,
            interruptedLead: 'Paused — cooperative checkpoint · open Goals to continue',
          })
        : formatPursuitPipelineStatusDetailLines({
            moduleName: modName,
            pursuitProgressRaw: prog,
            idleFallback: idle,
          });
    rows.push({
      key: `goal-${id}`,
      pageName: 'Goals',
      href: `/goals?focus=${encodeURIComponent(String(id))}`,
      title: g ? clip(g, ACTIVE_PIPELINE_PRIMARY_MAX) : `Goal ···${String(id).slice(-6)}`,
      detail,
      variant: 'goal',
      pipelineProgress: computeDashboardPipelineProgress(p.goalPipelineUi?.moduleStatuses, Boolean(p?.running)),
      pipelineProgressIndeterminate: false,
      moduleStatuses: p.goalPipelineUi?.moduleStatuses || null,
      interrupted: Boolean(p?.interruptedByReload),
      paused: coopPausedIdle,
    });
  }

  return rows;
}

function graphRegistryActiveWorkSnapshotKey() {
  if (typeof window === 'undefined') return '';
  const reg = getGraphPipelineSessionRegistry();
  return reg
    .map((s) => {
      const id = String(s?.id || '').trim();
      if (!id) return '';
      const peek = peekGraphPipelineUiPersisted(id);
      const draft = peekConsciousnessStreamDraftForSession(id);
      const active = graphSessionLooksActiveFromPeek(s, peek, draft);
      const ms = peek?.moduleStatuses && typeof peek.moduleStatuses === 'object' ? peek.moduleStatuses : {};
      const p = computeDashboardPipelineProgress(ms, active);
      const mod = getFirstProcessingModuleName(ms) || '';
      const labelHint = String(peek?.runContextLabel || '').slice(0, 120);
      return `${id}\x00${s.isProcessing ? '1' : '0'}\x00${peek?.isRunning ? '1' : '0'}\x00${draft.inFlight ? '1' : '0'}\x00${p}\x00${mod}\x00${labelHint}`;
    })
    .join('\x03');
}

function schedulerRunningRowKey() {
  const list = getDashboardScheduledRunningFromDbCache() || [];
  const u = getSchedulerPipelineUiSnapshot();
  const by = u.byTaskId || {};
  const uiParts = Object.keys(by)
    .sort()
    .map((tid) => {
      const ent = by[tid];
      const p = ent?.ui
        ? computeDashboardPipelineProgress(ent.ui.moduleStatuses, true)
        : '';
      const mod = ent?.ui ? getFirstProcessingModuleName(ent.ui.moduleStatuses) || '' : '';
      return `${tid}:${p}:${mod}`;
    })
    .join('|');
  const listPart = list
    .map(
      (r) =>
        `${r.id}\x00${r.task_type}\x00${r.reason}\x00${r.input_text}\x00${r.run_started_at}\x00${r.target_curiosity_id}\x00${r.target_goal_id}\x00`
    )
    .join('\x02');
  return `${listPart}\x03${u.running ? '1' : '0'}\x00${uiParts}`;
}

function compactModuleStatusKey(ms) {
  if (!ms || typeof ms !== 'object') return '';
  const keys = Object.keys(ms);
  if (keys.length === 0) return '';
  keys.sort();
  return keys.map((k) => `${k}=${ms[k]}`).join(',');
}

function activeWorkSnapshotKey(rows, schedKey) {
  const rowPart = rows
    .map(
      (r) =>
        `${r.key}\x00${r.title}\x00${r.detail}\x00${r.variant}\x00${r.pipelineProgress ?? ''}\x00${r.pipelineProgressIndeterminate ? '1' : ''}\x00${r.interrupted ? '1' : ''}\x00${r.paused ? '1' : ''}\x00${compactModuleStatusKey(r.moduleStatuses)}`
    )
    .join('\x01');
  return `${rowPart}\x02${schedKey}`;
}

/** Cached snapshot so useSyncExternalStore getSnapshot stays referentially stable when data is unchanged. */
let cachedActiveWorkSnapshot = { rows: [] };
let cachedActiveWorkKey = activeWorkSnapshotKey(cachedActiveWorkSnapshot.rows, '');

/**
 * Rows for “what is running” on the dashboard (interactive UI, pursuits, and headless scheduler pipelines).
 * @returns {{ rows: DashboardActiveWorkRow[] }}
 */
export function getDashboardActiveWorkSnapshot() {
  const rows = buildDashboardActiveWorkRows();
  const key = `${activeWorkSnapshotKey(rows, schedulerRunningRowKey())}\x04${graphRegistryActiveWorkSnapshotKey()}`;
  if (key === cachedActiveWorkKey) return cachedActiveWorkSnapshot;
  cachedActiveWorkKey = key;
  cachedActiveWorkSnapshot = { rows };
  return cachedActiveWorkSnapshot;
}

/** Subscribe to every store that can change {@link getDashboardActiveWorkSnapshot}. */
export function subscribeDashboardActiveWork(onStoreChange) {
  const u1 = subscribeGraphPipeline(onStoreChange);
  const u2 = subscribeConsciousnessStream(onStoreChange);
  const u3 = subscribeCuriosityPagePursuit(onStoreChange);
  const u4 = subscribeGoalPagePursuit(onStoreChange);
  const u5 = subscribeDashboardScheduledRunningSync(onStoreChange);
  const u6 = subscribeSchedulerPipelineUi(onStoreChange);
  const u7 = subscribeGraphPipelineRegistry(onStoreChange);
  const onMind = (e) => {
    if (e?.detail?.source !== 'scheduled-tasks') return;
    void syncDashboardScheduledRunningFromDb();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener(MIND_STORAGE_CHANGED, onMind);
  }
  return () => {
    u1();
    u2();
    u3();
    u4();
    u5();
    u6();
    u7();
    if (typeof window !== 'undefined') {
      window.removeEventListener(MIND_STORAGE_CHANGED, onMind);
    }
  };
}
