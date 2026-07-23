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
  getDashboardScheduledPausedFromDbCache,
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
import {
  getGraphWorkspaceMindSessionStorage,
  graphPipelineWorkspaceHref,
  resolveGraphSessionMindStorageProfile,
} from './graphSessionMindProfile';
import { PLAYGROUND_GRAPH_SESSION_A, PLAYGROUND_GRAPH_SESSION_B } from './playgroundDualGraphRunner';
import { MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR } from './mindEntityContext';

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
  return `${graphPipelineWorkspaceHref(sid)}#graph-pipeline-bottom`;
}

/** Dashboard / Live Analytics card tint: mirror registry + sticky sessionStorage, not only `playground-dual-b`. */
function dashboardGraphSessionSystemAccent(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return 'a';
  const remembered =
    typeof window !== 'undefined' ? getGraphWorkspaceMindSessionStorage(sid) : null;
  const profile = remembered ?? resolveGraphSessionMindStorageProfile(sid);
  return profile === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR ? 'b' : 'a';
}

/**
 * Which playground leg is foreground for Dashboard (only one row — avoid ghost “Module: Running” on the peer).
 * @param {string} sessionForRow - from bound / stream / last-opened / default
 */
function resolvePlaygroundSystemChatForegroundSessionId(sessionForRow) {
  const streamSid = getActiveConsciousnessStreamGraphSessionId();
  if (streamSid === PLAYGROUND_GRAPH_SESSION_A || streamSid === PLAYGROUND_GRAPH_SESSION_B) {
    return streamSid;
  }
  const bound = getGraphPipelineSessionId();
  if (bound === PLAYGROUND_GRAPH_SESSION_A || bound === PLAYGROUND_GRAPH_SESSION_B) {
    return bound;
  }
  if (sessionForRow === PLAYGROUND_GRAPH_SESSION_A || sessionForRow === PLAYGROUND_GRAPH_SESSION_B) {
    return sessionForRow;
  }
  return PLAYGROUND_GRAPH_SESSION_A;
}

/**
 * One row for System Chat dual graph (`playground-dual-a` / `playground-dual-b`): live store when that
 * session is bound + running; otherwise persisted peek for the peer leg.
 */
function buildPlaygroundSystemChatGraphRow(sid, gp, cs, graphOrStreamActive, idle) {
  const peek = peekGraphPipelineUiPersisted(sid);
  const draft = peekConsciousnessStreamDraftForSession(sid);
  const bound = getGraphPipelineSessionId();
  const streamSid = getActiveConsciousnessStreamGraphSessionId();
  const useLive =
    graphOrStreamActive &&
    bound === sid &&
    (gp.isRunning || cs.isProcessing) &&
    (streamSid === sid || streamSid == null);

  const ms = useLive
    ? gp.moduleStatuses && typeof gp.moduleStatuses === 'object'
      ? gp.moduleStatuses
      : {}
    : peek?.moduleStatuses && typeof peek.moduleStatuses === 'object'
      ? peek.moduleStatuses
      : {};
  const modName = getFirstProcessingModuleName(ms);
  const uploading = useLive ? Boolean(gp.uploading) : Boolean(peek?.uploading);

  let regEntry = null;
  try {
    const reg = typeof window !== 'undefined' ? getGraphPipelineSessionRegistry() : [];
    regEntry = reg.find((r) => String(r?.id || '').trim() === sid) || null;
  } catch {
    regEntry = null;
  }

  const promptHint = useLive
    ? clip(String(cs.activeRunTopic || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(String(gp.runContextLabel || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(lastUserPromptFromEntries(cs.entries), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(gp.input, ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(String(cs.input || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX)
    : clip(String(peek?.runContextLabel || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(lastUserPromptFromEntries(draft.entries), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(String(peek?.input || '').trim(), ACTIVE_PIPELINE_PRIMARY_MAX) ||
      clip(graphSessionDisplayTitle(sid, regEntry?.label, regEntry?.threadRootLabel), ACTIVE_PIPELINE_PRIMARY_MAX);

  const prefix = sid === PLAYGROUND_GRAPH_SESSION_A ? 'System A' : 'System B';
  const title = `${prefix} · ${promptHint || 'Graph pipeline'}`;

  const lead = formatGraphRunProgressLine({
    uploading,
    moduleName: modName,
    isActive: useLive,
  });
  const tail = [];
  const lc = useLive ? Number(gp.loopCount) || 0 : Number(peek?.loopCount) || 0;
  if (lc > 0) tail.push(`Supervisor reruns: ${lc}`);
  const detail = formatActivePipelineDetail(lead, tail, idle);

  return {
    key: `graph-pipeline-session-${sid}`,
    pageName: prefix,
    href: graphPipelineDeepLinkForSession(sid),
    title,
    detail,
    variant: 'graph',
    pipelineProgress: computeDashboardPipelineProgress(ms, useLive),
    pipelineProgressIndeterminate: false,
    moduleStatuses: ms,
    interrupted: false,
    playgroundSystemAccent: sid === PLAYGROUND_GRAPH_SESSION_A ? 'a' : 'b',
  };
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
  /**
   * Stale session KV: `flushPersist` no-ops when {@link graphPipelineUiStorageKey} is null (lobby / unbound
   * session), so `isRunning` can stay true while every module is already settled — typical after a deferred
   * supervisor rerun was enqueued from Executive Gate. Require the Voice/placeholder line that the graph
   * saves for that case so we do not hide rows during a scheduled continuation that set `isRunning` before
   * the first module marks `processing`.
   */
  if (peek.isRunning && !peekModuleStatusesShowProcessing(peek) && !draft.inFlight) {
    const fo = String(peek.finalOutput || '').trim();
    if (
      /Supervisor RERUN scheduled/i.test(fo) ||
      /Voice pending/i.test(fo) ||
      /\bRERUN scheduled\b/i.test(fo)
    ) {
      return true;
    }
  }
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
  /**
   * Registry already cleared for this workspace but session KV still has `isRunning` (persist never bound
   * to the graph session key). Do not keep a ghost “active pipeline” row.
   */
  if (
    !s.isProcessing &&
    peek?.isRunning &&
    !peekModuleStatusesShowProcessing(peek) &&
    !draft.inFlight
  ) {
    return false;
  }
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
 *   playgroundSystemAccent?: 'a' | 'b',
 * }} DashboardActiveWorkRow
 */

/**
 * Blue vs red UI accents: mirror graph session B only; everything else (primary mind) is A.
 * Used by Live Analytics and Dashboard active-pipeline cards.
 * @param {{ key: string, playgroundSystemAccent?: 'a'|'b' }} row
 * @returns {'a'|'b'}
 */
export function resolveDashboardRowPlaygroundSystemAccent(row) {
  if (row.playgroundSystemAccent === 'a' || row.playgroundSystemAccent === 'b') {
    return row.playgroundSystemAccent;
  }
  if (row.key.startsWith('graph-pipeline-session-')) {
    const sid = row.key.slice('graph-pipeline-session-'.length).trim();
    return dashboardGraphSessionSystemAccent(sid);
  }
  if (
    row.key === 'graph-pipeline' ||
    row.key === 'graph-pipeline-checkpoint' ||
    row.key === 'graph-pipeline-interrupted'
  ) {
    const sid =
      getGraphPipelineSessionId() ||
      getActiveConsciousnessStreamGraphSessionId() ||
      getLastOpenedGraphPipelineSessionId() ||
      DEFAULT_GRAPH_SESSION_ID;
    return dashboardGraphSessionSystemAccent(sid);
  }
  return 'a';
}

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

    if (sessionForRow === PLAYGROUND_GRAPH_SESSION_A || sessionForRow === PLAYGROUND_GRAPH_SESSION_B) {
      handledGraphSessionIds.add(PLAYGROUND_GRAPH_SESSION_A);
      handledGraphSessionIds.add(PLAYGROUND_GRAPH_SESSION_B);
      const foregroundSid = resolvePlaygroundSystemChatForegroundSessionId(sessionForRow);
      rows.push(buildPlaygroundSystemChatGraphRow(foregroundSid, gp, cs, graphOrStreamActive, idle));
    } else {
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
  }

  /**
   * Per-session registry + KV peek: must run **before** cooperative-checkpoint / interrupted-only rows.
   * Otherwise we add the checkpoint session to `handledGraphSessionIds` and skip a still-active session
   * (e.g. cross-tab or registry-driven runs that do not mirror `gp.isRunning` in this tab).
   */
  const registry = typeof window !== 'undefined' ? getGraphPipelineSessionRegistry() : [];
  const registrySorted = [...registry].sort((a, b) =>
    String(a?.id || '').localeCompare(String(b?.id || ''))
  );
  for (const s of registrySorted) {
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
              'Resume from this save via Graph Pipeline (Continue), Dashboard Load saved + Resume on this row, or dismiss the reload notice on the graph page — progress is kept until you discard.',
            ],
            'Paused'
          )
        : formatActivePipelineDetail(
            'Paused — cooperative checkpoint saved',
            ['Continue in Graph Pipeline or use Dashboard Load saved + Resume on this row.'],
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

    const schMirror = String(sch.mind_storage_profile || '').trim() === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;
    if (typeKey === 'curiosity_pursuit') {
      pageName = schMirror ? 'Curiosity Queue (B)' : 'Curiosity Queue';
      variant = 'curiosity';
      const cBase = schMirror ? '/curiosity/mirror' : '/curiosity';
      href = targetC ? `${cBase}?focus=${encodeURIComponent(targetC)}` : '/scheduler';
    } else if (typeKey === 'goal_pursuit') {
      pageName = schMirror ? 'Goals (B)' : 'Goals';
      variant = 'goal';
      const gBase = schMirror ? '/goals/mirror' : '/goals';
      href = targetG ? `${gBase}?focus=${encodeURIComponent(targetG)}` : '/scheduler';
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
      playgroundSystemAccent: schMirror ? 'b' : undefined,
    });
  }

  const schedulerPaused = getDashboardScheduledPausedFromDbCache() || [];
  const runningIds = new Set(schedulerRunning.map((r) => String(r?.id || '')));
  for (const sch of schedulerPaused) {
    if (!sch?.id) continue;
    const sid = String(sch.id);
    if (runningIds.has(sid)) continue;

    const typeKey = String(sch.task_type || '').trim().toLowerCase();
    const targetC = String(sch.target_curiosity_id || '').trim();
    const targetG = String(sch.target_goal_id || '').trim();

    if (typeKey === 'curiosity_pursuit') {
      if (targetC && curiositySnap[targetC]?.running) continue;
      if (!targetC && Object.values(curiositySnap).some((p) => p?.running)) continue;
      if (targetC && curiositySnap[targetC]?.cooperativePaused) continue;
      if (!targetC && Object.values(curiositySnap).some((p) => p?.cooperativePaused)) continue;
    }
    if (typeKey === 'goal_pursuit') {
      if (targetG && goalsSnap[targetG]?.running) continue;
      if (!targetG && Object.values(goalsSnap).some((p) => p?.running)) continue;
      if (targetG && goalsSnap[targetG]?.cooperativePaused) continue;
      if (!targetG && Object.values(goalsSnap).some((p) => p?.cooperativePaused)) continue;
    }

    const typeLabel = getSchedulerTaskTypeLabel(sch.task_type);
    const topic = getScheduledTaskTopicSummary(sch);
    const title =
      clip(topic, ACTIVE_PIPELINE_PRIMARY_MAX) || clip(typeLabel, ACTIVE_PIPELINE_PRIMARY_MAX);

    let pageName = 'Scheduler';
    let href = '/scheduler';
    let variant = 'scheduler';

    const schPausedMirror = String(sch.mind_storage_profile || '').trim() === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;
    if (typeKey === 'curiosity_pursuit') {
      pageName = schPausedMirror ? 'Curiosity Queue (B)' : 'Curiosity Queue';
      variant = 'curiosity';
      const cBase = schPausedMirror ? '/curiosity/mirror' : '/curiosity';
      href = targetC ? `${cBase}?focus=${encodeURIComponent(targetC)}` : '/scheduler';
    } else if (typeKey === 'goal_pursuit') {
      pageName = schPausedMirror ? 'Goals (B)' : 'Goals';
      variant = 'goal';
      const gBase = schPausedMirror ? '/goals/mirror' : '/goals';
      href = targetG ? `${gBase}?focus=${encodeURIComponent(targetG)}` : '/scheduler';
    } else {
      pageName = 'Graph Pipeline';
      href = `/graph-pipeline/scheduled/${encodeURIComponent(String(sch.id))}?from=default`;
    }

    const schedEntry = schedulerUiSnap.byTaskId?.[String(sch.id)];
    const ms = schedEntry?.ui?.moduleStatuses;
    const detail = formatActivePipelineDetail(
      'Paused — cooperative checkpoint saved',
      [typeLabel, 'Use Dashboard Load saved + Resume on this row, or open Scheduler to continue.'],
      idle
    );

    const pipelineProgress = computeDashboardPipelineProgress(ms || {}, false);

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
      paused: true,
      playgroundSystemAccent: schPausedMirror ? 'b' : undefined,
    });
  }

  for (const [id, p] of Object.entries(curiositySnap)) {
    if (!p?.running && !p?.interruptedByReload && !p?.cooperativePaused) continue;
    const q = String(p.question || '').trim();
    const prog = String(p.pursuitProgress || '').trim();
    const modName = getFirstProcessingModuleName(p.curiosityPipelineUi?.moduleStatuses);
    const coopPausedIdle = Boolean(p?.cooperativePaused) && !p?.running;
    const isMirrorPursuit = p.mindStorageProfile === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;
    const curiosityBase = isMirrorPursuit ? '/curiosity/mirror' : '/curiosity';
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
      pageName: isMirrorPursuit ? 'Curiosity Queue (B)' : 'Curiosity Queue',
      href: `${curiosityBase}?focus=${encodeURIComponent(String(id))}`,
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
      playgroundSystemAccent: isMirrorPursuit ? 'b' : 'a',
    });
  }

  for (const [id, p] of Object.entries(goalsSnap)) {
    if (!p?.running && !p?.interruptedByReload && !p?.cooperativePaused) continue;
    const g = String(p.goalStatement || '').trim();
    const prog = String(p.pursuitProgress || '').trim();
    const modName = getFirstProcessingModuleName(p.goalPipelineUi?.moduleStatuses);
    const coopPausedIdle = Boolean(p?.cooperativePaused) && !p?.running;
    const isMirrorGoal = p.mindStorageProfile === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;
    const goalBase = isMirrorGoal ? '/goals/mirror' : '/goals';
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
      pageName: isMirrorGoal ? 'Goals (B)' : 'Goals',
      href: `${goalBase}?focus=${encodeURIComponent(String(id))}`,
      title: g ? clip(g, ACTIVE_PIPELINE_PRIMARY_MAX) : `Goal ···${String(id).slice(-6)}`,
      detail,
      variant: 'goal',
      pipelineProgress: computeDashboardPipelineProgress(p.goalPipelineUi?.moduleStatuses, Boolean(p?.running)),
      pipelineProgressIndeterminate: false,
      moduleStatuses: p.goalPipelineUi?.moduleStatuses || null,
      interrupted: Boolean(p?.interruptedByReload),
      paused: coopPausedIdle,
      playgroundSystemAccent: isMirrorGoal ? 'b' : 'a',
    });
  }

  for (const row of rows) {
    row.playgroundSystemAccent = resolveDashboardRowPlaygroundSystemAccent(row);
  }

  return rows;
}

function graphRegistryActiveWorkSnapshotKey() {
  if (typeof window === 'undefined') return '';
  const reg = [...getGraphPipelineSessionRegistry()].sort((a, b) =>
    String(a?.id || '').localeCompare(String(b?.id || ''))
  );
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
  const pausedList = getDashboardScheduledPausedFromDbCache() || [];
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
        `${r.id}\x00${r.task_type}\x00${r.reason}\x00${r.input_text}\x00${r.run_started_at}\x00${r.target_curiosity_id}\x00${r.target_goal_id}\x00${r.mind_storage_profile || ''}\x00`
    )
    .join('\x02');
  const pausedPart = pausedList
    .map(
      (r) =>
        `${r.id}\x00${r.task_type}\x00${r.reason}\x00${r.input_text}\x00${r.run_started_at}\x00${r.target_curiosity_id}\x00${r.target_goal_id}\x00${r.mind_storage_profile || ''}\x00`
    )
    .join('\x02');
  return `${listPart}\x03${pausedPart}\x04${u.running ? '1' : '0'}\x00${uiParts}`;
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
        `${r.key}\x00${r.title}\x00${r.detail}\x00${r.variant}\x00${r.pipelineProgress ?? ''}\x00${r.pipelineProgressIndeterminate ? '1' : ''}\x00${r.interrupted ? '1' : ''}\x00${r.paused ? '1' : ''}\x00${r.playgroundSystemAccent ?? ''}\x00${compactModuleStatusKey(r.moduleStatuses)}`
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
  void syncDashboardScheduledRunningFromDb().then(() => onStoreChange());
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
