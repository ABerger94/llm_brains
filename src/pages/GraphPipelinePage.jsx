import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, GitBranch, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import GraphPipelineExecutionPanel from '../components/pipeline/GraphPipelineExecutionPanel';
import GraphPipelineInteractiveControls from '../components/pipeline/GraphPipelineInteractiveControls';
import GraphPipelineInspector from '../components/graphPipeline/GraphPipelineInspector';
import GraphSessionLabelInline from '../components/graphPipeline/GraphSessionLabelInline';
import { Button } from '../components/ui';
import { cn } from '../lib/utils';
import {
  rehydrateGraphPipelineSessionStores,
  resetGraphPipelineSessionStoresAfterLeavingWorkspace,
} from '../lib/graphPipelineSessionHydrate';
import {
  getGraphPipelineSessionRegistry,
  prepareNewGraphPipelineSession,
  registerOpenGraphPipelineWorkspace,
  subscribeGraphPipelineRegistry,
} from '../lib/graphPipelineSessionRegistry';
import { DEFAULT_GRAPH_SESSION_ID } from '../lib/graphPipelineSessionScope';
import { healGraphRegistryWhenPersistSaysIdle } from '../lib/graphSessionStaleRunningHeal';
import { graphPipelineStore, subscribeGraphPipeline } from '../lib/graphPipelineStore';
import { consciousnessStreamStore, subscribeConsciousnessStream } from '../lib/consciousnessStreamStore';

function SessionSelectDropdown({ sessionId, sessions, onSessionSelect }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-input bg-background px-1">
      <GitBranch className="ml-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <label className="sr-only" htmlFor="graph-session-select">Active session</label>
      <select
        id="graph-session-select"
        value={sessionId}
        onChange={onSessionSelect}
        className="h-8 min-w-[8rem] max-w-[min(100%,16rem)] border-0 bg-transparent py-0 pr-6 text-xs font-medium text-foreground focus:outline-none focus:ring-0"
      >
        {!sessions.some((s) => s.id === sessionId) ? (
          <option value={sessionId}>
            {sessionId === DEFAULT_GRAPH_SESSION_ID ? 'Default' : sessionId.slice(0, 14)}...
          </option>
        ) : null}
        {sessions.map((s) => {
          const label = String(s.threadRootLabel || s.label || '').trim();
          const display = label ? label.slice(0, 40) : s.id.slice(0, 14) + '...';
          return (
            <option key={s.id} value={s.id}>
              {display}{s.isProcessing ? ' \u00b7 running' : ''}
            </option>
          );
        })}
      </select>
    </div>
  );
}

export default function GraphPipelinePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { sessionId: rawSessionId } = useParams();
  const sessionId = String(rawSessionId || '').trim();
  const [searchParams, setSearchParams] = useSearchParams();
  const schedulerFocusParam = searchParams.get('schedulerFocus');
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState(() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      if (t === 'scheduled' || t === 'sessions' || t === 'context' || t === 'graph' || t === 'execution') return t;
    } catch {
      /* ignore */
    }
    return 'execution';
  });

  const sessions = useSyncExternalStore(
    subscribeGraphPipelineRegistry,
    getGraphPipelineSessionRegistry,
    getGraphPipelineSessionRegistry
  );

  const gpSnap = useSyncExternalStore(
    subscribeGraphPipeline,
    () => graphPipelineStore.getState(),
    () => graphPipelineStore.getState()
  );
  const csSnap = useSyncExternalStore(
    subscribeConsciousnessStream,
    () => consciousnessStreamStore.getState(),
    () => consciousnessStreamStore.getState()
  );

  useLayoutEffect(() => {
    if (!sessionId) return undefined;
    rehydrateGraphPipelineSessionStores(sessionId);
    registerOpenGraphPipelineWorkspace(sessionId);
    return () => {
      resetGraphPipelineSessionStoresAfterLeavingWorkspace(sessionId);
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    const h = (location.hash || '').replace(/^#/, '');
    if (h !== 'graph-pipeline-bottom' && h !== 'graph-pipeline-anchor') return;
    document.getElementById('graph-pipeline-bottom')?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    const path = `${location.pathname}${location.search || ''}`;
    navigate(path, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  useLayoutEffect(() => {
    const raw = schedulerFocusParam;
    if (!raw) return;
    const focusId = String(raw).trim();
    if (!focusId) {
      setSearchParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete('schedulerFocus');
          return n;
        },
        { replace: true }
      );
      return;
    }
    navigate(
      `/graph-pipeline/scheduled/${encodeURIComponent(focusId)}?from=${encodeURIComponent(sessionId)}`,
      { replace: true }
    );
  }, [schedulerFocusParam, sessionId, navigate]);

  useLayoutEffect(() => {
    const t = searchParams.get('tab');
    if (t !== 'scheduled' && t !== 'sessions' && t !== 'context' && t !== 'graph' && t !== 'execution') return;
    setInspectorTab(t);
    setSearchParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete('tab');
        return n;
      },
      { replace: true }
    );
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    healGraphRegistryWhenPersistSaysIdle();
  }, []);

  if (!sessionId) {
    return <Navigate to="/graph-pipeline" replace />;
  }

  const onSessionSelect = (e) => {
    const next = String(e.target.value || '').trim();
    if (!next || next === sessionId) return;
    navigate(`/graph-pipeline/${encodeURIComponent(next)}`);
  };

  const newWorkspace = () => {
    const id = prepareNewGraphPipelineSession();
    navigate(`/graph-pipeline/${encodeURIComponent(id)}`);
  };

  const runLabel = String(gpSnap.runContextLabel || '').trim();
  const isProcessing = Boolean(gpSnap.isRunning || csSnap.isProcessing);

  const currentSession = sessions.find((x) => x.id === sessionId);

  return (
    <div className="scroll-mt-4 flex min-h-0 flex-1 flex-col overflow-x-hidden bg-background">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-card/40 px-4 py-2.5 sm:px-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2">
          {/* Breadcrumb row */}
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Link
              to="/graph-pipeline"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <ArrowLeft className="h-3 w-3" aria-hidden />
              All runs
            </Link>
            <ChevronRight className="h-3 w-3 text-border" aria-hidden />
            <span className="truncate font-medium text-foreground">
              {currentSession?.threadRootLabel || currentSession?.label || 'Workspace'}
            </span>
            {isProcessing ? (
              <span className="ml-1 inline-flex h-2 w-2 animate-ping rounded-full bg-primary" />
            ) : null}
          </div>
          {/* Toolbar row */}
          <div className="flex flex-wrap items-center gap-2">
            <SessionSelectDropdown sessionId={sessionId} sessions={sessions} onSessionSelect={onSessionSelect} />
            <GraphSessionLabelInline
              sessionId={sessionId}
              label={currentSession?.label}
              threadRootLabel={currentSession?.threadRootLabel}
              compact
            />
            <div className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="hidden h-8 gap-1 text-xs text-muted-foreground lg:inline-flex"
                onClick={() => setInspectorOpen((v) => !v)}
                aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
              >
                {inspectorOpen ? (
                  <PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden />
                )}
                <span>{inspectorOpen ? 'Hide inspector' : 'Inspector'}</span>
              </Button>
              <Button type="button" size="sm" className="h-8 gap-1 text-xs" onClick={newWorkspace}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden sm:inline">New workspace</span>
              </Button>
            </div>
          </div>
          {runLabel ? (
            <p className="line-clamp-1 text-xs text-muted-foreground" title={runLabel}>
              <span className="font-medium">Topic:</span> {runLabel}
            </p>
          ) : null}
        </div>
      </div>

      {/* Main content: tabbed on mobile, two-panel on lg */}
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 overflow-hidden">
        {/* Inspector: full area on mobile (tabs include execution log), sidebar on lg */}
        {inspectorOpen ? (
          <div
            className={cn(
              'shrink-0 overflow-y-auto border-border/70 bg-muted/5',
              'w-full lg:w-[340px] lg:border-r',
              'min-h-0 flex-1 lg:flex-none'
            )}
          >
            <div className="px-3 py-3">
              <GraphPipelineInspector
                tab={inspectorTab}
                onTabChange={setInspectorTab}
                currentSessionId={sessionId}
                executionLogSlot={<GraphPipelineExecutionPanel />}
                className="max-w-none"
              />
            </div>
          </div>
        ) : null}

        {/* Standalone execution panel -- visible on lg always, hidden on mobile (it's a tab in the inspector) */}
        <div className={cn(
          'min-h-0 min-w-0 flex-1 overflow-y-auto',
          'hidden lg:block'
        )}>
          <GraphPipelineExecutionPanel />
        </div>
      </div>

      <GraphPipelineInteractiveControls graphSessionId={sessionId} />

      <div id="graph-pipeline-bottom" className="h-px w-full shrink-0 scroll-mt-4" aria-hidden />
    </div>
  );
}
