import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, GitBranch, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import GraphPipelineExecutionPanel from '../components/pipeline/GraphPipelineExecutionPanel';
import GraphPipelineInteractiveControls from '../components/pipeline/GraphPipelineInteractiveControls';
import GraphPipelineStreamResumeBanners from '../components/pipeline/GraphPipelineStreamResumeBanners';
import GraphPipelineInspector from '../components/graphPipeline/GraphPipelineInspector';
import GraphSessionLabelInline from '../components/graphPipeline/GraphSessionLabelInline';
import PageShell from '../components/PageShell';
import { Button } from '../components/ui';
import {
  isSessionPipelineLive,
  rehydrateGraphPipelineSessionStores,
  resetGraphPipelineSessionStoresAfterLeavingWorkspace,
} from '../lib/graphPipelineSessionHydrate';
import {
  getGraphPipelineSessionRegistry,
  registerOpenGraphPipelineWorkspace,
  subscribeGraphPipelineRegistry,
  upsertGraphPipelineSession,
} from '../lib/graphPipelineSessionRegistry';
import NewGraphWorkspaceControl from '../components/graphPipeline/NewGraphWorkspaceControl';
import {
  DEFAULT_GRAPH_SESSION_ID,
  getGraphPipelineSessionId,
  subscribeGraphPipelineSessionId,
} from '../lib/graphPipelineSessionScope';
import {
  getPlaygroundOrchestrationDepthSnapshot,
  PLAYGROUND_GRAPH_SESSION_A,
  PLAYGROUND_GRAPH_SESSION_B,
  subscribePlaygroundOrchestration,
} from '../lib/playgroundDualGraphRunner';
import { healGraphRegistryWhenPersistSaysIdle } from '../lib/graphSessionStaleRunningHeal';
import {
  graphPathMirrorSessionIdFromPathname,
  graphPipelineWorkspaceHref,
  graphPipelineWorkspaceMindProfileFromLocation,
  setGraphWorkspaceMindSessionStorage,
} from '../lib/graphSessionMindProfile';
import { MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR, MIND_STORAGE_PROFILE_PRIMARY } from '../lib/mindEntityContext';
import { graphPipelineStore, subscribeGraphPipeline } from '../lib/graphPipelineStore';
import { consciousnessStreamStore, subscribeConsciousnessStream } from '../lib/consciousnessStreamStore';
import { cn } from '../lib/utils';

function SessionSelectDropdown({ sessionId, sessions, onSessionSelect }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-input bg-background px-1">
      <GitBranch className="ml-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <label className="sr-only" htmlFor="graph-session-select">
        Active session
      </label>
      <select
        id="graph-session-select"
        value={sessionId}
        onChange={onSessionSelect}
        className="h-8 min-w-[8rem] max-w-[min(100%,16rem)] border-0 bg-transparent py-0 pr-6 text-xs font-medium text-foreground focus:outline-none focus:ring-0"
      >
        {!sessions.some((s) => s.id === sessionId) ? (
          <option value={sessionId}>
            {sessionId === DEFAULT_GRAPH_SESSION_ID ? 'Default' : `${sessionId.slice(0, 14)}…`}
          </option>
        ) : null}
        {sessions.map((s) => {
          const label = String(s.threadRootLabel || s.label || '').trim();
          const display = label ? label.slice(0, 40) : `${s.id.slice(0, 14)}…`;
          return (
            <option key={s.id} value={s.id}>
              {display}
              {s.isProcessing ? ' · running' : ''}
            </option>
          );
        })}
      </select>
    </div>
  );
}

/**
 * Graph workspace: one URL session id, one “pipeline” session id (may differ during System Chat),
 * and one mind profile for runs — always derived from {@link graphPipelineWorkspaceMindProfileFromLocation}
 * using the **pipeline** session id so System A/B matches what `startConsciousnessStreamRun` persists.
 */
export default function GraphPipelinePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { sessionId: routeSessionIdRaw } = useParams();
  const routeSessionId = String(routeSessionIdRaw || '').trim();
  const [searchParams, setSearchParams] = useSearchParams();
  const schedulerFocusParam = searchParams.get('schedulerFocus');

  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorTab, setInspectorTab] = useState(() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      if (t === 'execution') return 'graph';
      if (t === 'scheduled' || t === 'sessions' || t === 'context' || t === 'graph') return t;
    } catch {
      /* ignore */
    }
    return 'graph';
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

  const boundGraphSessionId = useSyncExternalStore(
    subscribeGraphPipelineSessionId,
    getGraphPipelineSessionId,
    getGraphPipelineSessionId
  );
  const orchestrationDepth = useSyncExternalStore(
    subscribePlaygroundOrchestration,
    getPlaygroundOrchestrationDepthSnapshot,
    getPlaygroundOrchestrationDepthSnapshot
  );

  const boundPlaygroundSession =
    boundGraphSessionId === PLAYGROUND_GRAPH_SESSION_A || boundGraphSessionId === PLAYGROUND_GRAPH_SESSION_B;
  const playgroundPipelineStillLive =
    isSessionPipelineLive(PLAYGROUND_GRAPH_SESSION_A) || isSessionPipelineLive(PLAYGROUND_GRAPH_SESSION_B);
  const playgroundRunLocksWorkspace =
    boundPlaygroundSession && (orchestrationDepth > 0 || playgroundPipelineStillLive);

  /** KV + composer + runs: playground may temporarily own the interactive pipeline. */
  const pipelineSessionId =
    playgroundRunLocksWorkspace && boundGraphSessionId ? boundGraphSessionId : routeSessionId;

  /** Single mind profile for badges, chrome, and `startConsciousnessStreamRun` (must use pipelineSessionId). */
  const mindProfile = graphPipelineWorkspaceMindProfileFromLocation(pipelineSessionId, location.pathname);
  const isSystemB = mindProfile === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR;

  const showSystemChatRouteHint = Boolean(
    playgroundRunLocksWorkspace && boundGraphSessionId && routeSessionId && boundGraphSessionId !== routeSessionId
  );
  const showPlaygroundResumeStrip =
    pipelineSessionId === PLAYGROUND_GRAPH_SESSION_A || pipelineSessionId === PLAYGROUND_GRAPH_SESSION_B;

  const mirrorPathSessionId = graphPathMirrorSessionIdFromPathname(location.pathname);
  const routeMirrorUrlMatches = mirrorPathSessionId != null && mirrorPathSessionId === routeSessionId;

  const orchestrationDepthPrevRef = useRef(null);

  useLayoutEffect(() => {
    if (!routeSessionId) return undefined;
    rehydrateGraphPipelineSessionStores(routeSessionId);
    registerOpenGraphPipelineWorkspace(routeSessionId);
    return () => {
      resetGraphPipelineSessionStoresAfterLeavingWorkspace(routeSessionId);
    };
  }, [routeSessionId]);

  /** Registry + sessionStorage mirror primary for the **route** workspace (MindScope + new workspace). */
  useLayoutEffect(() => {
    const sid = routeSessionId;
    if (!sid || sid === 'scheduled' || sid === 'run' || sid === 'mirror') return;

    if (sid === PLAYGROUND_GRAPH_SESSION_B) {
      if (routeMirrorUrlMatches) {
        setGraphWorkspaceMindSessionStorage(sid, MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR);
        upsertGraphPipelineSession({ id: sid, mindStorageProfile: MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR });
      }
      return;
    }
    if (sid === PLAYGROUND_GRAPH_SESSION_A) {
      if (!routeMirrorUrlMatches) {
        setGraphWorkspaceMindSessionStorage(sid, MIND_STORAGE_PROFILE_PRIMARY);
        upsertGraphPipelineSession({ id: sid, mindStorageProfile: MIND_STORAGE_PROFILE_PRIMARY });
      }
      return;
    }

    if (routeMirrorUrlMatches) {
      setGraphWorkspaceMindSessionStorage(sid, MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR);
      upsertGraphPipelineSession({ id: sid, mindStorageProfile: MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR });
    } else {
      setGraphWorkspaceMindSessionStorage(sid, MIND_STORAGE_PROFILE_PRIMARY);
      upsertGraphPipelineSession({ id: sid, mindStorageProfile: MIND_STORAGE_PROFILE_PRIMARY });
    }
  }, [routeSessionId, routeMirrorUrlMatches]);

  useLayoutEffect(() => {
    if (!routeSessionId) return;
    const prev = orchestrationDepthPrevRef.current;
    orchestrationDepthPrevRef.current = orchestrationDepth;
    if (prev != null && prev > 0 && orchestrationDepth === 0) {
      rehydrateGraphPipelineSessionStores(routeSessionId);
    }
  }, [routeSessionId, orchestrationDepth]);

  useLayoutEffect(() => {
    const h = (location.hash || '').replace(/^#/, '');
    if (h !== 'graph-pipeline-bottom' && h !== 'graph-pipeline-anchor') return;
    try {
      document.getElementById('graph-pipeline-bottom')?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } catch {
      /* iOS */
    }
    navigate(`${location.pathname}${location.search || ''}`, { replace: true });
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
      `/graph-pipeline/scheduled/${encodeURIComponent(focusId)}?from=${encodeURIComponent(routeSessionId)}`,
      { replace: true }
    );
  }, [schedulerFocusParam, routeSessionId, navigate, setSearchParams]);

  useLayoutEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'execution') {
      setInspectorTab('graph');
      setSearchParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete('tab');
          return n;
        },
        { replace: true }
      );
      return;
    }
    if (t !== 'scheduled' && t !== 'sessions' && t !== 'context' && t !== 'graph') return;
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

  if (!routeSessionId) {
    return <Navigate to="/graph-pipeline" replace />;
  }

  const onSessionSelect = (e) => {
    const next = String(e.target.value || '').trim();
    if (!next || next === routeSessionId) return;
    navigate(`${graphPipelineWorkspaceHref(next)}${location.search || ''}`);
  };

  const runLabel = String(gpSnap.runContextLabel || '').trim();
  const isProcessing = Boolean(gpSnap.isRunning || csSnap.isProcessing);
  const currentSession = sessions.find((x) => x.id === routeSessionId);
  const workspaceTitle =
    String(currentSession?.threadRootLabel || currentSession?.label || '').trim() || 'Graph workspace';

  return (
    <PageShell
      icon={GitBranch}
      title={workspaceTitle}
      description="Live stages, execution log, and composer for this graph session. System A (primary) and System B (mirror) use the same UI; mirror workspaces use a red border accent (like active pipeline cards) and /graph-pipeline/mirror/:id."
      maxWidth="max-w-6xl"
      fillMain
      className={cn(
        isSystemB && 'shadow-[inset_4px_0_0_0_rgba(239,68,68,0.5)] ring-1 ring-inset ring-red-500/25'
      )}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/graph-pipeline"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 touch-manipulation"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            All runs
          </Link>
          <NewGraphWorkspaceControl />
        </div>
      }
    >
      <div className="space-y-4" data-graph-workspace-mind={isSystemB ? 'mirror' : 'primary'}>
        <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'inherit' }}>
          <Link
            to="/graph-pipeline"
            className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
            style={{ color: 'inherit' }}
          >
            Sessions
          </Link>
          <ChevronRight className="h-3 w-3 opacity-60" aria-hidden />
          <span className="font-mono text-[11px] opacity-75">{routeSessionId.slice(0, 12)}…</span>
          {isProcessing ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
              Running
            </span>
          ) : (
            <span className="text-[10px] opacity-60">Idle</span>
          )}
        </div>

        <div
          className={cn(
            'flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:p-4',
            isSystemB ? 'border-red-500/40' : 'border-border'
          )}
          style={{ backgroundColor: 'var(--card, white)', color: 'inherit' }}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <SessionSelectDropdown
              sessionId={routeSessionId}
              sessions={sessions}
              onSessionSelect={onSessionSelect}
            />
            <span
              className={
                isSystemB
                  ? 'rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-800 dark:text-red-200'
                  : 'rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground'
              }
              title="Mind store used for this pipeline binding (System Chat may bind playground A/B while the URL shows another workspace)."
            >
              {isSystemB ? 'System B (mirror)' : 'System A (primary)'}
            </span>
            <GraphSessionLabelInline
              sessionId={routeSessionId}
              label={currentSession?.label}
              threadRootLabel={currentSession?.threadRootLabel}
              compact
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs"
              onClick={() => setInspectorOpen((v) => !v)}
              aria-expanded={inspectorOpen}
              aria-label={inspectorOpen ? 'Hide inspector panel' : 'Show inspector panel'}
            >
              {inspectorOpen ? <PanelLeftClose className="h-3.5 w-3.5" aria-hidden /> : <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden />}
              <span className="hidden sm:inline">{inspectorOpen ? 'Hide inspector' : 'Inspector'}</span>
              <span className="sm:hidden">{inspectorOpen ? 'Hide' : 'Panel'}</span>
            </Button>
          </div>
        </div>

        {runLabel ? (
          <p
            className={cn(
              'rounded-lg border px-3 py-2 text-xs',
              isSystemB ? 'border-red-500/40' : 'border-border'
            )}
            title={runLabel}
            style={{ backgroundColor: 'var(--muted, #f1f5f9)', color: 'inherit' }}
          >
            <span className="font-medium">Topic:</span> {runLabel}
          </p>
        ) : null}

        {showSystemChatRouteHint ? (
          <div
            className="rounded-lg border border-amber-500 px-3 py-2 text-xs sm:px-4"
            style={{ backgroundColor: 'rgb(254 243 199)', color: 'rgb(120 53 15)' }}
          >
            <span className="font-medium">System Chat</span> is still using this pipeline — the workspace in the URL
            applies after the run finishes.{' '}
            <Link
              to="/playground"
              className="font-medium underline-offset-2 hover:underline"
              style={{ color: 'rgb(180 83 9)' }}
            >
              Open System Chat
            </Link>
          </div>
        ) : null}

        {showPlaygroundResumeStrip ? (
          <div
            className={cn(
              'rounded-lg border',
              isSystemB ? 'border-red-500/40' : 'border-border'
            )}
            style={{ backgroundColor: 'var(--background, white)' }}
          >
            <GraphPipelineStreamResumeBanners
              graphSessionId={pipelineSessionId}
              mindStorageProfileOverride={mindProfile}
            />
          </div>
        ) : null}

        <div className="grid w-full min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(260px,340px)_minmax(0,1fr)] lg:items-start lg:gap-4">
          {inspectorOpen ? (
            <section
              className={cn(
                'min-w-0 rounded-xl border lg:max-h-[720px] lg:overflow-y-auto lg:overscroll-y-contain',
                isSystemB ? 'border-red-500/40' : 'border-border'
              )}
              style={{ backgroundColor: 'var(--muted, #f8fafc)', color: 'inherit' }}
              aria-label="Pipeline inspector"
            >
              <div className="p-3 sm:p-4">
                <GraphPipelineInspector
                  tab={inspectorTab}
                  onTabChange={setInspectorTab}
                  currentSessionId={pipelineSessionId}
                  mirrorWorkspace={isSystemB}
                  className="max-w-none"
                />
              </div>
            </section>
          ) : null}

          <section
            className={cn(
              'min-w-0 rounded-xl border lg:max-h-[720px] lg:overflow-y-auto lg:overscroll-y-contain',
              isSystemB ? 'border-red-500/40' : 'border-border'
            )}
            style={{ backgroundColor: 'var(--background, white)', color: 'inherit' }}
            aria-label="Execution view"
          >
            <GraphPipelineExecutionPanel workspaceSystemAccent={isSystemB ? 'b' : 'a'} />
          </section>
        </div>

        <GraphPipelineInteractiveControls
          graphSessionId={pipelineSessionId}
          hideResumeBanners={showPlaygroundResumeStrip}
          mindStorageProfileForRun={mindProfile}
          mirrorWorkspace={isSystemB}
        />

        <div id="graph-pipeline-bottom" className="h-px w-full scroll-mt-4" aria-hidden />
      </div>
    </PageShell>
  );
}
