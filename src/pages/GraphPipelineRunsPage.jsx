import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, Book, Clock, GitBranch, MessageSquare, Plus, X } from 'lucide-react';
import { Button } from '../components/ui';
import PageShell from '../components/PageShell';
import { cn } from '../lib/utils';
import GraphPipelineExecutionPanel from '../components/pipeline/GraphPipelineExecutionPanel';
import SchedulerTaskPipelineLivePanel from '../components/pipeline/SchedulerTaskPipelineLivePanel';
import GraphPipelineRunsSessionCard from '../components/graphPipeline/GraphPipelineRunsSessionCard';
import {
  getGraphPipelineSessionRegistry,
  getLastOpenedGraphPipelineSessionId,
  prepareNewGraphPipelineSession,
  subscribeGraphPipelineLastOpened,
  subscribeGraphPipelineRegistry,
} from '../lib/graphPipelineSessionRegistry';
import { DEFAULT_GRAPH_SESSION_ID } from '../lib/graphPipelineSessionScope';
import {
  getDashboardScheduledRunningFromDbCache,
  subscribeDashboardScheduledRunningSync,
  syncDashboardScheduledRunningFromDb,
} from '../lib/dashboardScheduledRunningSync';
import { MIND_STORAGE_CHANGED } from '../lib/mindStorageEvents';
import { getScheduledTaskTopicSummary } from '../lib/schedulerTaskDisplayTopic';
import { getSchedulerTaskTypeLabel } from '../lib/schedulerTaskLabels';
import {
  rehydrateGraphPipelineSessionStores,
  resetGraphPipelineSessionStoresAfterLeavingWorkspace,
} from '../lib/graphPipelineSessionHydrate';
import { healGraphRegistryWhenPersistSaysIdle } from '../lib/graphSessionStaleRunningHeal';

function formatTime(ts) {
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

/** @typedef {{ type: 'session', sessionId: string, title: string } | { type: 'scheduler', taskId: string, title: string }} PipelinePeek */

export default function GraphPipelineRunsPage() {
  const navigate = useNavigate();
  /** @type {[PipelinePeek | null, (v: PipelinePeek | null) => void]} */
  const [pipelinePeek, setPipelinePeek] = useState(null);
  const sessions = useSyncExternalStore(
    subscribeGraphPipelineRegistry,
    getGraphPipelineSessionRegistry,
    getGraphPipelineSessionRegistry
  );
  const lastOpened = useSyncExternalStore(
    subscribeGraphPipelineLastOpened,
    getLastOpenedGraphPipelineSessionId,
    getLastOpenedGraphPipelineSessionId
  );
  const scheduledRunning = useSyncExternalStore(
    subscribeDashboardScheduledRunningSync,
    getDashboardScheduledRunningFromDbCache,
    getDashboardScheduledRunningFromDbCache
  );

  useEffect(() => {
    healGraphRegistryWhenPersistSaysIdle();
  }, []);

  useEffect(() => {
    void syncDashboardScheduledRunningFromDb();
    const t = setInterval(() => void syncDashboardScheduledRunningFromDb(), 4000);
    const onMind = (e) => {
      if (e?.detail?.source !== 'scheduled-tasks') return;
      void syncDashboardScheduledRunningFromDb();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener(MIND_STORAGE_CHANGED, onMind);
    }
    return () => {
      clearInterval(t);
      if (typeof window !== 'undefined') {
        window.removeEventListener(MIND_STORAGE_CHANGED, onMind);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!pipelinePeek || pipelinePeek.type !== 'session') return undefined;
    rehydrateGraphPipelineSessionStores(pipelinePeek.sessionId);
    return () => {
      resetGraphPipelineSessionStoresAfterLeavingWorkspace(pipelinePeek.sessionId);
    };
  }, [pipelinePeek]);

  useEffect(() => {
    if (!pipelinePeek) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setPipelinePeek(null);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [pipelinePeek]);

  const runningSessions = sessions.filter((s) => s.isProcessing);
  const idle = sessions.filter((s) => !s.isProcessing);
  const hasRunningSection = runningSessions.length > 0 || scheduledRunning.length > 0;

  const newWorkspace = () => {
    const id = prepareNewGraphPipelineSession();
    navigate(`/graph-pipeline/${encodeURIComponent(id)}`);
  };

  const onPeekSession = (payload) => {
    setPipelinePeek({ type: 'session', sessionId: payload.sessionId, title: payload.title });
  };

  const onSessionRemovedFromList = (sessionId) => {
    setPipelinePeek((peek) => (peek?.type === 'session' && peek.sessionId === sessionId ? null : peek));
  };

  const ScheduledPipelineRow = ({ task }) => {
    const typeLabel = getSchedulerTaskTypeLabel(task.task_type);
    const topic = getScheduledTaskTopicSummary(task);
    const primaryTitle = topic || typeLabel;
    const showTypeSub = Boolean(topic);
    const href = `/graph-pipeline/scheduled/${encodeURIComponent(task.id)}?from=${encodeURIComponent(DEFAULT_GRAPH_SESSION_ID)}`;
    const status = (
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm">
          <Clock className="h-3 w-3" aria-hidden />
          Scheduled run
        </span>
        {formatTime(task.run_started_at) ? (
          <span className="text-[10px] text-muted-foreground">{formatTime(task.run_started_at)}</span>
        ) : null}
      </div>
    );
    return (
      <div className="overflow-hidden rounded-lg border border-emerald-500/45 bg-card/40 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-stretch">
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-emerald-500/[0.06] sm:flex-row sm:items-center sm:justify-between"
            onClick={() =>
              setPipelinePeek({ type: 'scheduler', taskId: task.id, title: primaryTitle })
            }
          >
            <div className="min-w-0 flex items-start gap-3">
              <span
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm"
                aria-hidden
              >
                <Clock className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="line-clamp-2 text-sm font-medium text-foreground" title={primaryTitle}>
                  {primaryTitle}
                </div>
                {showTypeSub ? (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{typeLabel}</div>
                ) : null}
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/90">{task.id}</div>
                <p className="mt-1 text-[10px] text-emerald-700 dark:text-emerald-300">Open live pipeline view</p>
              </div>
            </div>
            {status}
          </button>
          <div className="flex shrink-0 items-center justify-center border-t border-border/70 bg-muted/10 px-3 py-2 sm:w-36 sm:border-l sm:border-t-0 sm:flex-col sm:gap-1">
            <Link
              to={href}
              className="text-center text-xs font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400"
              onClick={(e) => e.stopPropagation()}
            >
              Open workspace
            </Link>
          </div>
        </div>
      </div>
    );
  };

  const runningCount = runningSessions.length + scheduledRunning.length;

  return (
    <PageShell
      icon={GitBranch}
      title="Graph Pipeline"
      description="Each session is an isolated workspace with live stage tracking, module execution, and an interaction composer."
      maxWidth="max-w-4xl"
      actions={
        <>
          {lastOpened ? (
            <Link
              to={`/graph-pipeline/${encodeURIComponent(lastOpened)}`}
              className={cn(
                'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-4 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
              )}
            >
              Resume last session
            </Link>
          ) : null}
          <Button type="button" className="h-9 gap-2" onClick={newWorkspace}>
            <Plus className="h-4 w-4" aria-hidden />
            New workspace
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {hasRunningSection ? (
          <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="h-4 w-4 text-emerald-500" aria-hidden />
              <h2 className="text-sm font-semibold text-foreground">Running now</h2>
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                {runningCount}
              </span>
            </div>
            <div className="space-y-2">
              {runningSessions.map((s) => (
                <GraphPipelineRunsSessionCard
                  key={s.id}
                  s={s}
                  mode="running"
                  updatedLabel={formatTime(s.updatedAt)}
                  onPeekSession={onPeekSession}
                />
              ))}
              {scheduledRunning.map((t) => (
                <ScheduledPipelineRow key={t.id} task={t} />
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <div className="mb-3 flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h2 className="text-sm font-semibold text-foreground">
              {hasRunningSection ? 'Other sessions' : 'Sessions'}
            </h2>
            {idle.length > 0 ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums font-medium text-muted-foreground">
                {idle.length}
              </span>
            ) : null}
          </div>
          {idle.length === 0 && !hasRunningSection ? (
            <div className="rounded-xl border border-dashed border-border bg-muted/10 px-6 py-12 text-center">
              <GitBranch className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" aria-hidden />
              <p className="text-sm font-medium text-foreground/80">No workspaces yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Use <span className="font-medium text-foreground/90">New workspace</span> above to create your first session.
              </p>
            </div>
          ) : idle.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/80 bg-muted/10 px-4 py-6 text-center text-sm text-muted-foreground">
              All sessions are currently running.
            </p>
          ) : (
            <div className="space-y-2">
              {idle.map((s) => (
                <GraphPipelineRunsSessionCard
                  key={s.id}
                  s={s}
                  mode="idle"
                  updatedLabel={formatTime(s.updatedAt)}
                  onPeekSession={onPeekSession}
                  onSessionRemoved={onSessionRemovedFromList}
                />
              ))}
            </div>
          )}
        </section>

        <div className="flex items-center justify-center gap-4 border-t border-border/60 pt-4 text-xs text-muted-foreground">
          <Link to="/dialogue" className="inline-flex items-center gap-1.5 text-primary underline-offset-2 hover:underline">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            Dialogue
          </Link>
          <span className="text-border">|</span>
          <Link to="/user-manual" className="inline-flex items-center gap-1.5 text-primary underline-offset-2 hover:underline">
            <Book className="h-3.5 w-3.5" aria-hidden />
            User manual
          </Link>
        </div>
      </div>

      {pipelinePeek ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="graph-runs-pipeline-peek-title">
          <button
            type="button"
            className="absolute inset-0 bg-background/80 backdrop-blur-[2px]"
            aria-label="Close pipeline view"
            onClick={() => setPipelinePeek(null)}
          />
          <div
            className={cn(
              'relative z-10 flex max-h-[min(92dvh,880px)] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-border bg-background shadow-2xl',
              'sm:max-h-[min(88vh,900px)] sm:rounded-xl'
            )}
          >
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border bg-card/50 px-4 py-3">
              <div className="min-w-0">
                <h2 id="graph-runs-pipeline-peek-title" className="truncate text-sm font-semibold text-foreground">
                  Live pipeline
                </h2>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{pipelinePeek.title}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {pipelinePeek.type === 'session' ? (
                  <Link
                    to={`/graph-pipeline/${encodeURIComponent(pipelinePeek.sessionId)}`}
                    className="hidden text-xs font-medium text-primary underline-offset-2 hover:underline sm:inline"
                    onClick={() => setPipelinePeek(null)}
                  >
                    Full workspace
                  </Link>
                ) : (
                  <Link
                    to={`/graph-pipeline/scheduled/${encodeURIComponent(pipelinePeek.taskId)}?from=${encodeURIComponent(DEFAULT_GRAPH_SESSION_ID)}`}
                    className="hidden text-xs font-medium text-primary underline-offset-2 hover:underline sm:inline"
                    onClick={() => setPipelinePeek(null)}
                  >
                    Full workspace
                  </Link>
                )}
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => setPipelinePeek(null)} aria-label="Close">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
              {pipelinePeek.type === 'session' ? (
                <GraphPipelineExecutionPanel />
              ) : (
                <SchedulerTaskPipelineLivePanel taskId={pipelinePeek.taskId} />
              )}
            </div>
            <div className="shrink-0 border-t border-border bg-muted/20 px-4 py-2 sm:hidden">
              {pipelinePeek.type === 'session' ? (
                <Link
                  to={`/graph-pipeline/${encodeURIComponent(pipelinePeek.sessionId)}`}
                  className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                  onClick={() => setPipelinePeek(null)}
                >
                  Open full workspace
                </Link>
              ) : (
                <Link
                  to={`/graph-pipeline/scheduled/${encodeURIComponent(pipelinePeek.taskId)}?from=${encodeURIComponent(DEFAULT_GRAPH_SESSION_ID)}`}
                  className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                  onClick={() => setPipelinePeek(null)}
                >
                  Open full workspace
                </Link>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
