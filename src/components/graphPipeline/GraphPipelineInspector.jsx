import { useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clock, FileText, GitBranch, Info, Layers, Loader2, Network, Trash2 } from 'lucide-react';
import GraphSessionLabelInline, { graphSessionDisplayTitle } from './GraphSessionLabelInline';
import GraphCanvas from '../pipeline/GraphCanvas';
import { graphPipelineStore, subscribeGraphPipeline } from '../../lib/graphPipelineStore';
import { humanizeUnityRationaleForDisplay } from '../../lib/worldModelSchema';
import { ScheduledTaskListPanel } from './ScheduledTaskPipelineViews';
import { Button } from '../ui';
import { cn } from '../../lib/utils';
import {
  getGraphPipelineSessionRegistry,
  subscribeGraphPipelineRegistry,
  removeGraphPipelineSession,
} from '../../lib/graphPipelineSessionRegistry';
import { DEFAULT_GRAPH_SESSION_ID } from '../../lib/graphPipelineSessionScope';

/** Defer UI that must survive blur/reorder from inline session renames (trash → confirm). */
function scheduleAfterReactFlush(fn) {
  if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else Promise.resolve().then(fn);
}

function formatSessionRowTime(ts) {
  const s = String(ts ?? '').trim();
  if (!s) return '';
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) {
    try {
      return new Date(n).toLocaleString();
    } catch {
      return '';
    }
  }
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed) && parsed > 0) {
    try {
      return new Date(parsed).toLocaleString();
    } catch {
      return '';
    }
  }
  return '';
}

function ExecutionGraphPanel() {
  const snap = useSyncExternalStore(
    subscribeGraphPipeline,
    () => graphPipelineStore.getState(),
    () => graphPipelineStore.getState()
  );
  const { moduleStatuses, moduleOutputs } = snap;

  return (
    <div className="max-h-[min(360px,40vh)] min-h-[10rem] overflow-y-auto overflow-x-hidden rounded-lg border border-border/80 bg-card/30 p-3">
      <GraphCanvas moduleStatuses={moduleStatuses} moduleOutputs={moduleOutputs} compact />
    </div>
  );
}

function RunContextPanel() {
  const snap = useSyncExternalStore(
    subscribeGraphPipeline,
    () => graphPipelineStore.getState(),
    () => graphPipelineStore.getState()
  );
  const sm = snap.lastSharedMemory;

  const hasPn = Boolean(sm?.phenomenalNow?.line);
  const gw = sm?.globalWorkspace;
  const bindings = Array.isArray(gw?.bindings) ? gw.bindings : [];
  const hasBindings = bindings.length > 0;
  const hasGw =
    gw &&
    typeof gw === 'object' &&
    (gw.provisionalStance ||
      (Array.isArray(gw.broadcastWinners) && gw.broadcastWinners.length > 0) ||
      hasBindings);
  const hasPolicy = Boolean(sm?.cognitivePolicy);
  const hasAudit = Boolean(sm?.boundaryAudit?.length);

  if (!sm || (!hasPn && !hasGw && !hasPolicy && !hasAudit)) {
    return (
      <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">
        No workspace snapshot for this run yet — it appears after modules write shared memory.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {hasPn ? (
        <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-sky-400">Phenomenal now</h3>
          <p className="text-xs leading-relaxed text-foreground">{sm.phenomenalNow.line}</p>
          {sm.phenomenalNow.rationale ? (
            <p className="mt-1 text-[11px] text-muted-foreground">{sm.phenomenalNow.rationale}</p>
          ) : null}
        </div>
      ) : null}
      {hasGw ? (
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-violet-400">
            Global workspace (this run)
          </h3>
          {gw.phenomenalUnity ? (
            <p className="text-[11px] text-muted-foreground">
              Unity label:{' '}
              <span className="font-medium text-foreground/90">{String(gw.phenomenalUnity)}</span>
            </p>
          ) : null}
          {Array.isArray(gw.broadcastWinners) && gw.broadcastWinners.length > 0 ? (
            <ul className="mt-1 list-inside list-disc text-[11px] text-foreground/90">
              {gw.broadcastWinners.slice(0, 4).map((w, i) => (
                <li key={i}>{String(w)}</li>
              ))}
            </ul>
          ) : null}
          {gw.unityRationale ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {humanizeUnityRationaleForDisplay(gw.unityRationale)}
            </p>
          ) : null}
          {gw.provisionalStance ? (
            <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-foreground/85">
              {String(gw.provisionalStance)}
            </p>
          ) : null}
          {hasBindings ? (
            <div className="mt-3 border-t border-violet-500/20 pt-2">
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-violet-400/90">
                Thread coupling (integration heuristic)
              </h4>
              <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground">
                Edges from Integration <span className="font-mono">bindings</span>: which modules support which distilled
                claims. For debugging only — not a consciousness or Φ measure.
              </p>
              <ul className="max-h-40 space-y-2 overflow-y-auto text-[11px] text-foreground/85">
                {bindings.slice(0, 12).map((b, i) => {
                  const mods = Array.isArray(b?.sourceModules) ? b.sourceModules : [];
                  const claim = String(b?.claim || '').trim();
                  return (
                    <li key={i} className="rounded-md border border-border/50 bg-background/40 px-2 py-1.5">
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {mods.length ? mods.map((m) => String(m)).join(' → ') : '(no modules)'} → claim
                      </div>
                      {claim ? <div className="mt-0.5 whitespace-pre-wrap">{claim}</div> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {hasPolicy ? (
        <div className="rounded-xl border border-border bg-muted/15 p-3 text-[11px] text-muted-foreground">
          <div className="font-semibold text-foreground/80">Affective policy{sm.cognitivePolicy.sampledFrom ? ' (stochastic)' : ''}</div>
          <div className="mt-1 space-y-0.5 font-mono">
            <div>memory: {sm.cognitivePolicy.memoryBreadth}</div>
            <div>voice: {sm.cognitivePolicy.voiceGuidance}</div>
            <div>contradiction: {sm.cognitivePolicy.contradictionAggression}</div>
            <div>beliefs: {sm.cognitivePolicy.beliefWriteMode}</div>
            <div>planning: {sm.cognitivePolicy.planningBranches}</div>
            {sm.cognitivePolicy.phase ? <div>phase: {sm.cognitivePolicy.phase}</div> : null}
          </div>
        </div>
      ) : null}
      {hasAudit ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-[11px]">
          <div className="font-semibold text-amber-600">Constitution audit</div>
          <ul className="mt-1 list-inside list-disc text-muted-foreground">
            {sm.boundaryAudit.slice(-4).map((b, i) => (
              <li key={i}>{b.note || b.constitutionLine}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const BASE_TABS = [
  { id: 'graph', label: 'Execution graph', icon: Network },
  { id: 'sessions', label: 'Sessions', icon: Layers },
  { id: 'context', label: 'Run context', icon: Info },
  { id: 'scheduled', label: 'Scheduled', icon: Clock },
];

const EXECUTION_LOG_TAB = { id: 'execution', label: 'Execution log', icon: FileText, mobileOnly: true };

function SessionsListPanel({ currentSessionId }) {
  const navigate = useNavigate();
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const sessions = useSyncExternalStore(
    subscribeGraphPipelineRegistry,
    getGraphPipelineSessionRegistry,
    getGraphPipelineSessionRegistry
  );

  if (sessions.length === 0) {
    return (
      <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">
        No sessions in the registry yet. Use <span className="font-medium">New workspace</span> above or open{' '}
        <Link to="/graph-pipeline" className="text-primary underline-offset-2 hover:underline">
          Graph pipeline runs
        </Link>{' '}
        to manage workspaces.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
        Switch workspaces — each session keeps its own state and conversation scope.{' '}
        <Link to="/graph-pipeline" className="text-primary underline-offset-2 hover:underline">
          All sessions
        </Link>
      </p>
      <div className="space-y-2">
        {sessions.map((s) => {
          const href = `/graph-pipeline/${encodeURIComponent(s.id)}`;
          const title = graphSessionDisplayTitle(s.id, s.label, s.threadRootLabel);
          const active = s.id === currentSessionId;
          const canRemoveFromList = s.id !== DEFAULT_GRAPH_SESSION_ID;
          const confirmRemove = () => {
            removeGraphPipelineSession(s.id);
            setPendingDeleteId(null);
            if (s.id === currentSessionId) {
              navigate('/graph-pipeline', { replace: true });
            }
          };
          const statusMeta = (
            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
              {s.isProcessing ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Running
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
                  Idle
                </span>
              )}
              {formatSessionRowTime(s.updatedAt) ? (
                <span className="text-[11px] text-muted-foreground">{formatSessionRowTime(s.updatedAt)}</span>
              ) : null}
            </div>
          );
          return (
            <div
              key={s.id}
              className={cn(
                'flex items-stretch gap-0 overflow-hidden rounded-lg border transition-colors',
                active
                  ? 'border-primary/50 bg-primary/5 shadow-sm'
                  : 'border-border/80 bg-card/40 hover:bg-muted/30'
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <Link
                    to={href}
                    className="shrink-0 pt-0.5 text-primary hover:opacity-80"
                    aria-label={`Open workspace ${title}`}
                  >
                    <GitBranch className="h-4 w-4" aria-hidden />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0">
                      <GraphSessionLabelInline
                        sessionId={s.id}
                        label={s.label}
                        threadRootLabel={s.threadRootLabel}
                        titleLinkTo={href}
                        compact
                      />
                      {active ? (
                        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">current</span>
                      ) : null}
                    </div>
                    <Link
                      to={href}
                      className="mt-0.5 block font-mono text-[11px] text-muted-foreground/70 hover:underline"
                    >
                      {s.id}
                    </Link>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end sm:text-right text-muted-foreground">
                  {statusMeta}
                </div>
              </div>
              {canRemoveFromList ? (
                <div
                  className="relative z-20 isolate flex min-w-[7.5rem] shrink-0 flex-col items-stretch justify-center border-l border-border/70 bg-muted/5 px-1 py-1 sm:min-w-[8.5rem] sm:px-2"
                  data-graph-session-remove-root
                >
                  {pendingDeleteId === s.id ? (
                    <div className="flex flex-col gap-1.5">
                      <span className="px-0.5 text-[11px] leading-tight text-muted-foreground">
                        Remove from list only (data is kept).
                      </span>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 flex-1 text-xs"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setPendingDeleteId(null);
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="h-7 flex-1 text-xs"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            confirmRemove();
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${title} from list`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const sid = s.id;
                        scheduleAfterReactFlush(() => setPendingDeleteId(sid));
                      }}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * @param {{
 *   tab: 'graph' | 'context' | 'scheduled' | 'sessions' | 'execution'
 *   onTabChange: (id: string) => void
 *   currentSessionId?: string
 *   executionLogSlot?: import('react').ReactNode
 *   className?: string
 * }} props
 */
export default function GraphPipelineInspector({ tab, onTabChange, currentSessionId, executionLogSlot, className }) {
  const tabs = executionLogSlot ? [...BASE_TABS, EXECUTION_LOG_TAB] : BASE_TABS;

  return (
    <div className={cn('mx-auto w-full max-w-4xl', className)}>
      <div
        className="mb-2 flex flex-wrap gap-1 rounded-lg border border-border/70 bg-muted/20 p-1"
        role="tablist"
        aria-label="Pipeline inspector"
      >
        {tabs.map((t) => {
          const TabIcon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`inspector-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`inspector-panel-${t.id}`}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                tab === t.id
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                t.mobileOnly && 'lg:hidden'
              )}
              onClick={() => onTabChange(t.id)}
            >
              <TabIcon className="h-3.5 w-3.5" aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id="inspector-panel-graph"
        aria-labelledby="inspector-tab-graph"
        className="min-h-[8rem] rounded-lg border border-border/60 bg-muted/5 px-2 py-3 sm:px-3"
        hidden={tab !== 'graph'}
      >
        {tab === 'graph' ? <ExecutionGraphPanel /> : null}
      </div>
      <div
        role="tabpanel"
        id="inspector-panel-sessions"
        aria-labelledby="inspector-tab-sessions"
        className="min-h-[8rem] rounded-lg border border-border/60 bg-muted/5 px-2 py-3 sm:px-3"
        hidden={tab !== 'sessions'}
      >
        {tab === 'sessions' ? <SessionsListPanel currentSessionId={currentSessionId} /> : null}
      </div>
      <div
        role="tabpanel"
        id="inspector-panel-context"
        aria-labelledby="inspector-tab-context"
        className="min-h-[8rem] rounded-lg border border-border/60 bg-muted/5 px-2 py-3 sm:px-3"
        hidden={tab !== 'context'}
      >
        {tab === 'context' ? <RunContextPanel /> : null}
      </div>
      <div
        role="tabpanel"
        id="inspector-panel-scheduled"
        aria-labelledby="inspector-tab-scheduled"
        className="min-h-[8rem] rounded-lg border border-border/60 bg-muted/5 px-2 py-3 sm:px-3"
        hidden={tab !== 'scheduled'}
      >
        {tab === 'scheduled' ? <ScheduledTaskListPanel currentSessionId={currentSessionId} /> : null}
      </div>
      {executionLogSlot ? (
        <div
          role="tabpanel"
          id="inspector-panel-execution"
          aria-labelledby="inspector-tab-execution"
          className="rounded-lg border border-border/60 bg-muted/5 lg:hidden"
          hidden={tab !== 'execution'}
        >
          {tab === 'execution' ? executionLogSlot : null}
        </div>
      ) : null}
    </div>
  );
}
