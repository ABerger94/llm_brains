import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import moment from 'moment';
import {
  Activity,
  BookMarked,
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Cpu,
  Database,
  FileText,
  FlaskConical,
  GitBranch,
  Globe,
  Layers,
  ListChecks,
  Loader2,
  MessageSquare,
  Moon,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Repeat,
  Pause,
  PauseCircle,
  RotateCcw,
  ScrollText,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
  Zap,
} from 'lucide-react';
import { Button, Input, Textarea, toast } from '../components/ui';
import { ScheduledTask } from '../lib/data';
import { useMindScope, useScopedEntities } from '../context/MindScopeContext';
import MindScopeTabs from '../components/MindScopeTabs';
import { DEFAULT_RUNTIME_SETTINGS, getRuntimeSettings } from '../lib/runtimeSettings';
import { MIND_PHASE_OPTIONS } from '../lib/mindPersistence';
import { useMindStorageRefresh, notifyMindStorageChanged } from '../lib/mindStorageEvents';
import { shareOrDownloadBlob } from '../lib/triggerBlobDownload';
import { cn } from '../lib/utils';
import { APP_NAV_SECTIONS, APP_ROUTES } from '../lib/appSiteMap';
import {
  MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR,
  MIND_STORAGE_PROFILE_PRIMARY,
} from '../lib/mindEntityContext';
import { scheduleTask } from '../lib/schedulerStore';
import { getSchedulerSuggestions, suggestionUsesMindOptions } from '../lib/schedulerSuggestions';
import {
  retryFailedScheduledTask,
  resumePausedScheduledPipelineTask,
  stopScheduledTaskRunFromUi,
  isSchedulerTaskManuallyRerunnable,
  isScheduledTaskSchedulePaused,
  normalizeSchedulerTaskStatus,
  SchedulerRetrySkippedError,
  flushSchedulerDueTasksNow,
} from '../lib/scheduledTaskRunner';
import {
  subscribeCooperativePauseAllExternalHold,
  isCooperativePauseAllExternalHoldActive,
  setCooperativePauseAllExternalHold,
  COOPERATIVE_PAUSE_HOLD_SCHEDULER_MESSAGE,
} from '../lib/cooperativePauseAllExternalHold';
import { SCHEDULER_TASK_GROUPS, SCHEDULER_TASK_LABELS } from '../lib/schedulerTaskLabels';
import { clearPersistedSchedulerHeadlessFlightIfMatches } from '../lib/schedulerHeadlessFlightStore';
import PageShell from '../components/PageShell';

function Panel({ className, children }) {
  return <div className={cn('rounded-2xl border border-border bg-card p-4', className)}>{children}</div>;
}

function EmptyState({ title, description, children }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center">
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

function formatRelative(value) {
  return value ? moment(value).fromNow() : 'just now';
}

const linkOutlineBtnSm =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

function truncate(value, length = 220) {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function sharedMemoryRunMeta(run) {
  const sm = run?.shared_memory;
  const phase = sm?.phase ?? sm?.phaseEffective ?? null;
  const iterationCount = typeof sm?.iterationCount === 'number' ? sm.iterationCount : null;
  const sessionId = typeof sm?.sessionId === 'string' ? sm.sessionId : null;
  return {
    phase: typeof phase === 'string' ? phase : null,
    iterationCount,
    sessionShort: sessionId ? sessionId.slice(0, 8) : null,
    hasMemory: Boolean(sm && typeof sm === 'object'),
  };
}

export function SharedMemoryPage() {
  const { isMirror } = useMindScope();
  const { PipelineRun } = useScopedEntities();
  const [searchParams] = useSearchParams();
  const runFromUrl = String(searchParams.get('run') || '').trim();

  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await PipelineRun.listAll('-created_date');
      let merged = list;
      if (runFromUrl && !list.some((r) => r.id === runFromUrl)) {
        const extra = await PipelineRun.retrieve(runFromUrl);
        if (extra) {
          const rest = list.filter((r) => r.id !== extra.id);
          merged = [extra, ...rest];
        }
      }
      setRuns(merged);
      setSelectedId((prev) => {
        if (runFromUrl && merged.some((r) => r.id === runFromUrl)) return runFromUrl;
        if (prev && merged.some((r) => r.id === prev)) return prev;
        return merged[0]?.id || '';
      });
    } catch (e) {
      console.error('[SharedMemoryPage] load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [runFromUrl, PipelineRun]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const selected = useMemo(() => runs.find((r) => r.id === selectedId) || null, [runs, selectedId]);

  useEffect(() => {
    if (selected?.shared_memory) {
      setDraft(JSON.stringify(selected.shared_memory, null, 2));
    } else if (selected) {
      setDraft(JSON.stringify({ note: 'This run did not save shared_memory yet.' }, null, 2));
    }
  }, [selected]);

  const saveEdits = async () => {
    if (!selected) return;
    let parsed;
    try {
      parsed = JSON.parse(draft);
    } catch {
      toast({ title: 'Invalid JSON', description: 'Fix syntax before saving.', variant: 'destructive' });
      return;
    }
    try {
      await PipelineRun.update(selected.id, { shared_memory: parsed });
      await load();
      notifyMindStorageChanged({ source: 'shared-memory-edit' });
      toast({ title: 'Saved', description: 'Shared memory updated for this pipeline run.' });
    } catch (e) {
      toast({
        title: 'Save failed',
        description: e?.message ? String(e.message) : String(e),
        variant: 'destructive',
      });
    }
  };

  const exportJson = () => {
    void (async () => {
      try {
        const blob = new Blob([draft || '{}'], { type: 'application/json' });
        const mode = await shareOrDownloadBlob(
          blob,
          `metaself-cognitivestack-shared-memory-${selectedId || 'latest'}.json`
        );
        if (mode === 'cancelled') return;
        toast({
          title: mode === 'shared' ? 'JSON shared' : 'Export ready',
          description: mode === 'shared' ? 'Use Save to Files or another app.' : 'Download started.',
        });
      } catch (e) {
        toast({
          title: 'Export failed',
          description: e instanceof Error ? e.message : String(e),
          variant: 'destructive',
        });
      }
    })();
  };

  const importJson = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const text = String(ev.target?.result ?? '');
          const parsed = JSON.parse(text);
          setDraft(JSON.stringify(parsed, null, 2));
          toast({
            title: 'Imported into editor',
            description: 'Save to write this JSON onto the selected run.',
          });
        } catch {
          toast({ title: 'Invalid file', description: 'Choose a valid JSON file.', variant: 'destructive' });
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draft || '');
      toast({ title: 'Copied', description: 'Shared memory JSON copied to clipboard.' });
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard permission denied.', variant: 'destructive' });
    }
  };

  const revertDraft = () => {
    if (!selected) return;
    if (selected.shared_memory) {
      setDraft(JSON.stringify(selected.shared_memory, null, 2));
    } else {
      setDraft(JSON.stringify({ note: 'This run did not save shared_memory yet.' }, null, 2));
    }
    toast({ title: 'Reverted', description: 'Restored text from the selected run.' });
  };

  const selectedMeta = selected ? sharedMemoryRunMeta(selected) : null;

  return (
    <PageShell
      icon={Database}
      title="Shared memory"
      description="Per-run snapshot of the pipeline working state (JSON). Each pass appends moduleOutputs, derives globalWorkspace (INTEGRATION_JSON), hypothesisPortfolio, surpriseAssessment, userStancePrediction, webFindings / webFetchLog, recentExchangeBlock when the input carried RECENT_EXCHANGE, and more — inspect, edit, or export/import here."
      actions={
        <>
          <Button variant="outline" className="gap-2" onClick={() => load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button variant="outline" className="gap-2" onClick={copyDraft} disabled={!draft}>
            <Copy className="h-4 w-4" />
            Copy
          </Button>
          <Button variant="outline" className="gap-2" onClick={importJson}>
            <Upload className="h-4 w-4" />
            Import
          </Button>
          <Button variant="outline" onClick={exportJson} disabled={!draft}>
            Export
          </Button>
          <Button variant="outline" className="gap-2" onClick={revertDraft} disabled={!selected}>
            <RotateCcw className="h-4 w-4" />
            Revert
          </Button>
          <Button onClick={saveEdits} disabled={!selected}>
            Save to run
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <MindScopeTabs />
      </div>
      <Panel className="mb-6 space-y-3 text-sm text-foreground/85">
        <p>
          <strong className="text-foreground">What this is.</strong> Each time you use{' '}
          <Link
            to={isMirror ? '/graph-pipeline/mirror' : '/graph-pipeline'}
            className="text-primary underline-offset-2 hover:underline"
          >
            Graph Pipeline
          </Link>
          , the server builds a single <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">shared_memory</code>{' '}
          object: session id,{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">moduleOutputs</code> from the cognitive graph,
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">globalWorkspace</code> (salience, conflicts, broadcast
          winners, optional hypotheses/bindings), beliefs, goals, phase and rhythm fields, working memory, supervisor rerun
          hints (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">metaCognitionFlags</code>), web lookup fields,{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">webFetchSuppressedForRun</code> when fetches stop, and
          more. That state is what the next module sees; after the run it is stored on the{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">PipelineRun</code> record you select here.
        </p>
        <p>
          <strong className="text-foreground">Continuation.</strong> When you send a follow-up message, the client can post
          a trimmed snapshot (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">slimSharedMemoryForPipelinePost</code>
          ) so the next pass starts from the last turn instead of a blank slate.{' '}
          <Link to={isMirror ? '/memory/mirror' : '/memory'} className="text-primary underline-offset-2 hover:underline">
            Long-Term Memory
          </Link>{' '}
          and biography/consolidation are separate stores; they feed the pipeline, but this JSON is the per-turn workspace.
        </p>
        <p className="text-xs text-muted-foreground">
          Supervisor reruns (Metacognition and Workspace Metacognition) and flags are summarized on{' '}
          <Link to={isMirror ? '/iterations/mirror' : '/iterations'} className="text-primary underline-offset-2 hover:underline">
            Iterations
          </Link>
          . Editing JSON here overwrites that run’s stored snapshot only — use Save to persist.
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Panel className="space-y-2">
          <div className="text-sm font-semibold">Pipeline runs</div>
          <p className="text-xs text-muted-foreground">
            Newest first. Open a run to load its saved <span className="font-mono">shared_memory</span>.
          </p>
          {runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="Run Graph Pipeline to create stored shared memory."
            />
          ) : null}
          <div className="space-y-2">
            {runs.map((r) => {
              const m = sharedMemoryRunMeta(r);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={cn(
                    'w-full rounded-xl border px-3 py-2 text-left text-sm transition-all',
                    selectedId === r.id ? 'border-primary/40 bg-primary/10' : 'border-border hover:bg-muted/20'
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span>{formatRelative(r.created_date)}</span>
                    {m.sessionShort ? <span className="font-mono">· {m.sessionShort}…</span> : null}
                    {!m.hasMemory ? <span className="text-amber-600 dark:text-amber-500">· no snapshot</span> : null}
                  </div>
                  <div className="mt-1 font-medium">{truncate(r.input || 'Untitled', 64)}</div>
                  {(m.phase || m.iterationCount != null) && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {m.phase ? (
                        <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-foreground/80">
                          phase: {m.phase}
                        </span>
                      ) : null}
                      {m.iterationCount != null ? (
                        <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-foreground/80">
                          iterationCount: {m.iterationCount}
                        </span>
                      ) : null}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-sm font-semibold">Shared memory JSON</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Must be valid JSON. Save writes to the selected run and refreshes lists that depend on mind storage.
              </div>
              {selected && selectedMeta ? (
                <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                  <span className="font-mono">run …{selected.id.slice(-8)}</span>
                  {selectedMeta.sessionShort ? (
                    <span className="font-mono">· session {selectedMeta.sessionShort}…</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="min-h-[520px] font-mono text-xs"
          />
        </Panel>
      </div>
    </PageShell>
  );
}

function pipelineRunSurfaceLabel(run) {
  if (
    run?.source === 'consciousness-stream' ||
    run?.source === 'graph-pipeline' ||
    run?.execution_plan?.[0] === 'sse-graph'
  ) {
    return 'Graph Pipeline';
  }
  if (run?.execution_plan?.[0] === 'classic-sequential') {
    return 'Legacy sequential (historical)';
  }
  if (Array.isArray(run?.execution_plan?.[0])) {
    return 'Graph Pipeline';
  }
  if (Array.isArray(run?.execution_plan) && run.execution_plan.length > 0) {
    return 'Graph Pipeline';
  }
  return 'Pipeline';
}

function sessionIdForRun(run) {
  const sid = run?.shared_memory?.sessionId;
  return typeof sid === 'string' && sid.trim() ? sid : null;
}

export function IterationsPage() {
  const { isMirror } = useMindScope();
  const { PipelineRun } = useScopedEntities();
  const [runs, setRuns] = useState([]);
  const [expandedRunId, setExpandedRunId] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await PipelineRun.listAll('-created_date'));
    } catch (e) {
      console.error('[IterationsPage] load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [PipelineRun]);

  useEffect(() => {
    load();
  }, [load]);

  useMindStorageRefresh(load);

  const rerunEvents = useMemo(() => {
    const out = [];
    for (const run of runs) {
      const mem = run.shared_memory;
      const flags = mem?.metaCognitionFlags || [];
      for (const f of flags) {
        out.push({
          id: `${run.id}-${f.at}`,
          at: f.at,
          rerunIndex: f.rerunIndex,
          reason: f.reason,
          runId: run.id,
        });
      }
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [runs]);

  const sessions = useMemo(() => {
    const acc = {};
    for (const run of runs) {
      const sid = sessionIdForRun(run) || 'unknown-session';
      if (!acc[sid]) acc[sid] = [];
      acc[sid].push(run);
    }
    return acc;
  }, [runs]);

  const stats = useMemo(() => {
    const rerunRuns = runs.filter((r) => Number(r.loop_count) > 0).length;
    const totalReruns = runs.reduce((s, r) => s + (Number(r.loop_count) || 0), 0);
    return {
      sessionCount: Object.keys(sessions).length,
      rerunRuns,
      totalReruns,
    };
  }, [runs, sessions]);

  const clearRunHistory = async () => {
    if (
      !confirm(
        'Delete all saved pipeline runs from this browser? This does not clear long-term memory, world model, or ledger—only the Pipeline run log.'
      )
    ) {
      return;
    }
    for (const run of runs) {
      await PipelineRun.delete(run.id);
    }
    setRuns([]);
    setExpandedRunId(null);
    notifyMindStorageChanged({ source: 'iterations-clear' });
    toast({
      title: 'Run history cleared',
      description: 'All PipelineRun records were removed from local storage.',
    });
  };

  const moduleOutputEntries = (run) => {
    const mo = run.module_outputs || {};
    return Object.entries(mo).filter(([k]) => !k.endsWith('__meta'));
  };

  return (
    <PageShell
      icon={ListChecks}
      title="Iterations"
      description={
        'Each row is one full cognitive pass saved as PipelineRun (Graph Pipeline UI, scheduler, or other surfaces). ' +
        'Within a single pass, Metacognition or Workspace Metacognition can trigger reruns that re-execute layers 1–4—stored as loop_count and metaCognitionFlags on that run’s shared memory. ' +
        'Supervisors now emit confidence scores (e.g. RERUN 0.73) and the server uses a soft threshold modulated by interoception entropy. ' +
        'Continuation chats reuse sessionId in shared memory when you post slim sharedMemory back to the server. ' +
        'This page is a local audit trail only.'
      }
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={() => load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Link to={isMirror ? '/graph-pipeline/mirror' : '/graph-pipeline'} className={linkOutlineBtnSm}>
            <Play className="h-4 w-4" />
            Graph Pipeline
          </Link>
          <Link to={isMirror ? '/shared-memory/mirror' : '/shared-memory'} className={linkOutlineBtnSm}>
            <FileText className="h-4 w-4" />
            Shared memory
          </Link>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-destructive hover:text-destructive"
            onClick={clearRunHistory}
            disabled={loading || runs.length === 0}
          >
            <RotateCcw className="h-4 w-4" />
            Clear run log
          </Button>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <MindScopeTabs />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel className="!p-4">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Saved runs</div>
          <p className="mt-1 text-2xl font-bold text-foreground">{runs.length}</p>
        </Panel>
        <Panel className="!p-4">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Sessions (sessionId)</div>
          <p className="mt-1 text-2xl font-bold text-foreground">{stats.sessionCount}</p>
        </Panel>
        <Panel className="!p-4">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Supervisor reruns</div>
          <p className="mt-1 text-2xl font-bold text-foreground">{stats.totalReruns}</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">{stats.rerunRuns} run(s) with loop_count &gt; 0</p>
        </Panel>
        <Panel className="!p-4">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Latest run</div>
          <p className="mt-1 text-lg font-semibold text-foreground">
            {runs[0]?.created_date ? formatRelative(runs[0].created_date) : '—'}
          </p>
        </Panel>
      </div>

      <Panel className="mb-6 text-sm leading-relaxed text-foreground/85">
        <strong className="text-foreground">How this maps to the app:</strong>{' '}
        <span className="text-muted-foreground">
          A <strong className="text-foreground/90">run</strong> is one end-to-end execution through the module graph (Perception → … → Voice,
          with Metacognition, Integration, Workspace Metacognition, and pre-voice modules in between).{' '}
          <strong className="text-foreground/90">loop_count</strong> is how many times a supervisor asked to rerun earlier layers inside{' '}
          <em>that</em> run. <strong className="text-foreground/90">shared_memory.iterationCount</strong> on the snapshot can also increase
          across reruns. After a run, persistence may update long-term memory, world model (e.g. USER_MODEL_DELTA, SELF_MODEL_DELTA),
          self-ledger, working-memory promotions, and belief tensions—see Mind Self and Belief Map.
        </span>
      </Panel>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          title="No pipeline runs yet"
          description="Run Graph Pipeline to create saved history here."
        >
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="sm" className="gap-2" asChild>
              <Link to={isMirror ? '/graph-pipeline/mirror' : '/graph-pipeline'}>
                <Play className="h-3.5 w-3.5" />
                Open Graph Pipeline
              </Link>
            </Button>
          </div>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {runs.map((run, idx) => {
            const sm = run.shared_memory;
            const sid = sessionIdForRun(run);
            const surface = pipelineRunSurfaceLabel(run);
            const open = expandedRunId === run.id;
            const narrative =
              run.module_outputs?.Narrative || run.module_outputs?.narrative || '';
            const voiceOut = run.final_output || run.module_outputs?.Voice || '';

            return (
              <div key={run.id} className="overflow-hidden rounded-2xl border border-border bg-card">
                <button
                  type="button"
                  onClick={() => setExpandedRunId(open ? null : run.id)}
                  className="flex w-full items-center gap-4 p-4 text-left transition-colors hover:bg-muted/25"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 font-mono text-sm font-bold text-primary">
                    #{runs.length - idx}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{run.input || '—'}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                      {sid ? (
                        <span className="font-mono" title={sid}>
                          session {sid.slice(0, 8)}…
                        </span>
                      ) : (
                        <span>no sessionId</span>
                      )}
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatRelative(run.created_date)}
                      </span>
                      {run.phase ? <span>phase {run.phase}</span> : null}
                      {typeof sm?.iterationCount === 'number' ? (
                        <span>sm.iteration {sm.iterationCount}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {surface}
                    </span>
                    <span
                      className={cn(
                        'rounded-md px-2 py-0.5 text-[10px] font-medium',
                        Number(run.loop_count) > 0 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-200' : 'bg-muted/50 text-muted-foreground'
                      )}
                    >
                      loops {Number(run.loop_count) || 0}
                    </span>
                  </div>
                  {open ? (
                    <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                </button>

                {open ? (
                  <div className="space-y-4 border-t border-border px-4 pb-4 pt-3">
                    {run.phenomenal_now?.line || sm?.phenomenalNow?.line ? (
                      <div>
                        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Phenomenal now (snapshot)
                        </h4>
                        <p className="rounded-lg bg-muted/25 px-3 py-2 text-xs leading-relaxed text-foreground/90">
                          {run.phenomenal_now?.line || sm?.phenomenalNow?.line}
                        </p>
                      </div>
                    ) : null}

                    <div>
                      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Voice (final_output)
                      </h4>
                      <div className="max-h-48 overflow-y-auto rounded-lg bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap text-foreground/85">
                        {voiceOut || '—'}
                      </div>
                    </div>

                    {narrative ? (
                      <div>
                        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Narrative module
                        </h4>
                        <div className="max-h-40 overflow-y-auto rounded-lg bg-muted/20 p-3 text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">
                          {narrative}
                        </div>
                      </div>
                    ) : null}

                    <div>
                      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Module outputs
                      </h4>
                      <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
                        {moduleOutputEntries(run).map(([key, val]) => (
                          <div key={key} className="rounded-lg border border-border/80 bg-muted/15 p-2">
                            <div className="font-mono text-[10px] text-primary">{key}</div>
                            <p className="mt-1 line-clamp-4 text-[10px] text-muted-foreground">{String(val)}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {(sm?.metaCognitionFlags || []).length > 0 ? (
                      <div>
                        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Supervisor reruns (this run)
                        </h4>
                        <ul className="space-y-2 text-xs">
                          {(sm.metaCognitionFlags || []).map((f, i) => (
                            <li key={`${f.at}-${i}`} className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2">
                              <span className="text-[10px] text-muted-foreground">
                                #{f.rerunIndex ?? i + 1} · {f.at ? formatRelative(f.at) : ''}
                              </span>
                              <p className="mt-1 whitespace-pre-wrap text-foreground/85">{f.reason || '—'}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {!loading && runs.length > 0 ? (
        <div className="mt-10">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Repeat className="h-4 w-4 text-muted-foreground" />
            Supervisor rerun timeline (all runs)
          </h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Flattened log of every rerun reason stored in shared memory across saved runs (newest first within this list).
          </p>
          {rerunEvents.length === 0 ? (
            <EmptyState
              title="No rerun events"
              description="When Metacognition or Workspace Metacognition triggers layer reruns, reasons appear here and under each expanded run."
            />
          ) : (
            <div className="space-y-2">
              {rerunEvents.map((it) => (
                <Panel key={it.id} className="!py-3">
                  <div className="text-xs text-muted-foreground">
                    {formatRelative(it.at)} · rerun #{it.rerunIndex || 0} · run …{it.runId.slice(-8)}
                  </div>
                  <div className="mt-2 whitespace-pre-wrap text-sm text-foreground/85">{it.reason || 'No reason provided.'}</div>
                </Panel>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </PageShell>
  );
}

export function ExperimentsPage() {
  return (
    <PageShell
      icon={FlaskConical}
      title="Experiments"
      description="A workspace for controlled prompts, pipeline options, and comparing outcomes across runs."
    >
      <Panel>
        <div className="text-sm text-foreground/80">
          This page is wired for local experimentation workflows: use <strong>System Chat</strong> for comparisons, and
          <strong> Datasets</strong>/<strong>Training</strong> for exporting structured results.
        </div>
      </Panel>
    </PageShell>
  );
}

function ManualSection({ icon: Icon, title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/20"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <span className="flex-1 text-sm font-semibold text-foreground">{title}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border px-5 pb-5 pt-1 text-sm leading-relaxed text-foreground/80">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function ManualStep({ n, children }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
        {n}
      </div>
      <div className="text-sm text-foreground/80">{children}</div>
    </div>
  );
}

function ManualNote({ children }) {
  return (
    <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-foreground/90 dark:bg-muted/40 dark:text-foreground/95">
      {children}
    </div>
  );
}

export function UserManualPage() {
  const siteIndexFooterLabel = 'System';

  const layerRows = [
    {
      layer: 'Ingress',
      mods: 'Perception, Attention',
      desc: 'Structure raw input and decide what deserves focus.',
    },
    {
      layer: 'Memory & learning',
      mods: 'Memory, Learning, Temporal Awareness',
      desc: 'Recall context, form associations (Learning ties modules + emits surprise/working-memory promotion JSON), and situate the moment in time (timeline + prior-turn excerpt when present).',
    },
    {
      layer: 'Planning, reasoning, affect, beliefs',
      mods: 'Planning, Reasoning, Emotion, Theory of Mind, Belief Store',
      desc: 'Plans and stance prediction, logic, modeled affect, user modeling, and structured belief updates before deeper self passes.',
    },
    {
      layer: 'Self, social, contradictions',
      mods: 'Self-Reflection, Identity, Social Cognition, Contradiction Engine',
      desc: 'Critique of reasoning, first-person identity, social reading, and tension scanning (using salience, working memory, and emotion as first-class signals). Contradiction Engine optionally runs multi-sample for robustness.',
    },
    {
      layer: 'Meta, integration, language, drives',
      mods: 'Metacognition, Integration, Workspace Metacognition, Language, Curiosity, Goal Generation, Somatic Marker',
      desc: 'Supervision and reruns (Metacognition + Workspace Metacognition share a rerun budget; confidence scores + soft thresholds replace binary RERUN/PROCEED); Integration publishes INTEGRATION_JSON (GWT-style broadcast, optional hypotheses/bindings; optionally multi-sampled). Workspace Metacognition validates the workspace before Language. Then Language, Curiosity, Goal Generation, and Somatic Marker.',
    },
    {
      layer: 'Expression',
      mods: 'Narrative, Voice',
      desc: 'Internal story of the run, then the user-facing Voice line.',
    },
  ];

  return (
    <PageShell
      icon={BookOpen}
      title="User Manual"
      description="How MetaSelf-CognitiveStack fits together: 23-module server pipeline in six layers (see below), dual supervisors, Graph Pipeline (unified transcript + graph), probabilistic integrations (embeddings, adaptive temperature, soft metacognition, stochastic policy, calibrated thresholds), optional web enrichment, persistence after each run, memory and mind pages, Output search, Training sidebar (Datasets, RLHF, Training log, System Chat), full site index below, and local/cloud LLM setup."
    >
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-relaxed text-foreground/85">
          <strong className="text-primary">What is this app?</strong> MetaSelf-CognitiveStack is a local cognitive-architecture workbench: a
          graph of <strong className="text-foreground">23 specialized modules</strong> runs on each input in six sequential
          layers (server-side for Graph Pipeline and scheduled full-stack tasks, or sequentially in System Chat), augmented
          with probabilistic integrations (adaptive temperature, embedding-based similarity, soft metacognition thresholds,
          stochastic cognitive policy, and auto-calibrated decision thresholds). After a run that produces{' '}
          <strong className="text-foreground">Voice</strong>, the app writes a full snapshot to{' '}
          <strong className="text-foreground">Pipeline Run</strong> (including shared memory) and updates mind stores in{' '}
          <strong className="text-foreground">IndexedDB</strong> — long-term memory (phase + settings), self-ledger, belief
          tensions, user-model deltas, a rolling belief digest, curiosity from the Curiosity module, biography touch, a
          consolidation digest row, timeline events (<code className="rounded bg-muted px-1">pipeline_complete</code>,{' '}
          <code className="rounded bg-muted px-1">cognitive_health_metrics</code> with run counts plus latest-run identity/narrative
          hints), pipeline emergence heuristics (Voice + Narrative + Identity module text and structured narrative sections), and an
          integration stance row in the world model when <code className="rounded bg-muted px-1">INTEGRATION_JSON</code>{' '}
          is present. It is deeper than a single chat turn — quality still depends on your models and prompts.
        </div>

        <ManualSection icon={ListChecks} title="Site index — every page">
          <p className="text-sm text-muted-foreground">
            Sidebar order, short labels, and mobile titles all come from{' '}
            <code className="rounded bg-muted px-1 text-xs">src/lib/appSiteMap.js</code> — update that file when you add a route
            so navigation and this list stay aligned.
          </p>
          {APP_NAV_SECTIONS.filter((s) => s.id !== 'footer').map((sec) => {
            const rows = APP_ROUTES.filter((r) => r.nav?.section === sec.id);
            if (!rows.length) return null;
            return (
              <div key={sec.id} className="mt-4 space-y-2">
                {sec.heading ? (
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{sec.heading}</div>
                ) : null}
                {rows.map((r) => (
                  <div key={r.path} className="rounded-lg bg-muted/20 p-3 text-xs">
                    <div>
                      <Link to={r.path} className="font-semibold text-primary hover:underline">
                        {r.title}
                      </Link>
                      {r.nav?.label && r.nav.label !== r.title ? (
                        <span className="ml-2 text-muted-foreground">Sidebar: {r.nav.label}</span>
                      ) : null}
                      <code className="ml-2 rounded bg-muted px-1 text-[10px] text-muted-foreground">{r.path}</code>
                    </div>
                    {r.manualBlurb ? <p className="mt-1.5 leading-relaxed text-muted-foreground">{r.manualBlurb}</p> : null}
                  </div>
                ))}
              </div>
            );
          })}
          <div className="mt-4 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{siteIndexFooterLabel}</div>
            {APP_ROUTES.filter((r) => r.nav?.section === 'footer').map((r) => (
              <div key={r.path} className="rounded-lg bg-muted/20 p-3 text-xs">
                <div>
                  <Link to={r.path} className="font-semibold text-primary hover:underline">
                    {r.title}
                  </Link>
                  {r.nav?.label && r.nav.label !== r.title ? (
                    <span className="ml-2 text-muted-foreground">Sidebar: {r.nav.label}</span>
                  ) : null}
                  <code className="ml-2 rounded bg-muted px-1 text-[10px] text-muted-foreground">{r.path}</code>
                </div>
                {r.manualBlurb ? <p className="mt-1.5 leading-relaxed text-muted-foreground">{r.manualBlurb}</p> : null}
              </div>
            ))}
          </div>
          <div className="mt-4 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Other routes</div>
            {APP_ROUTES.filter((r) => !r.nav).map((r) => (
              <div key={r.path} className="rounded-lg bg-muted/20 p-3 text-xs">
                <div>
                  <Link to={r.path} className="font-semibold text-primary hover:underline">
                    {r.title}
                  </Link>
                  <code className="ml-2 rounded bg-muted px-1 text-[10px] text-muted-foreground">{r.path}</code>
                </div>
                {r.manualBlurb ? <p className="mt-1.5 leading-relaxed text-muted-foreground">{r.manualBlurb}</p> : null}
              </div>
            ))}
          </div>
        </ManualSection>

        <div className="space-y-3">
          <ManualSection icon={Brain} title="Why it exists — the idea" defaultOpen>
            <p>
              Plain chat treats each message in isolation. This stack adds parallel layers of modules, persistent stores, and
              views (beliefs, timeline, health) so you can study how a structured &ldquo;mind&rdquo; behaves over many runs.
              Probabilistic integrations (embedding similarity, adaptive temperature, stochastic policy, soft metacognition
              thresholds, calibrated parameters) bridge the gap between the LLM&apos;s inherent stochasticity and the system&apos;s
              structured pipeline, so the architecture can adapt its behavior based on internal state rather than relying
              solely on fixed rules.
            </p>
            <p>
              Graph Pipeline executes the full dependency graph with server-side parallelism and SSE progress.{' '}
              <strong className="text-foreground">Metacognition</strong> and <strong className="text-foreground">Workspace Metacognition</strong>{' '}
              can signal <strong className="text-foreground">reruns</strong> of layers 1–4 (shared cap in Settings); the transcript shows how
              many completed. Supervisors may emit <code className="rounded bg-muted px-1">META_ACTIONS</code> (e.g. narrative/voice word caps,
              phase nudge). Contradiction-focused reruns work best when attention, working-memory slots, hypothesis portfolio, and emotion outputs
              stay aligned — server prompts emphasize that linkage.
            </p>
          </ManualSection>

          <ManualSection icon={GitBranch} title="Architecture — 23 modules in layers">
            <p>
              Modules are scheduled in dependency layers (see <code className="rounded bg-muted px-1">LAYERS</code> in{' '}
              <code className="rounded bg-muted px-1">server/prompts.js</code> / <code className="rounded bg-muted px-1">shared/pipelineModules.mjs</code>
              ). Later layers consume outputs from earlier ones. Very large shared-memory JSON may use server{' '}
              <strong className="text-foreground">map → merge → reduce</strong> ingest so each LLM call stays within context.
            </p>
            <div className="mt-2 space-y-2">
              {layerRows.map((l) => (
                <div key={l.layer} className="rounded-lg bg-muted/20 p-3 text-xs">
                  <div className="mb-0.5 font-semibold text-primary">{l.layer}</div>
                  <div className="font-medium text-foreground">{l.mods}</div>
                  <div className="mt-0.5 text-muted-foreground">{l.desc}</div>
                </div>
              ))}
            </div>
            <ManualNote>
              Graph Pipeline shows <strong className="font-semibold text-foreground">Final voice</strong> (user-facing) and{' '}
              <strong className="font-semibold text-foreground">Internal narrative</strong> when the run returns both.
            </ManualNote>
            <ManualNote>
              <strong className="font-semibold text-foreground">Voice, constitution, and meta-talk:</strong> Shared module
              prompts in{' '}
              <code className="rounded bg-muted px-1">shared/pipelineModules.mjs</code> (re-exported by{' '}
              <code className="rounded bg-muted px-1">server/prompts.js</code>) steer Identity → Narrative → Language → Voice so
              mind constitution and workspace stance from Settings show up as <em>substance and tone</em> in the final reply, not
              as summaries of policy blocks, &ldquo;my constitution,&rdquo; &ldquo;per my rules,&rdquo; training-data disclaimers,
              or generic assistant framing. Adjust those strings if you want different behavior.
            </ManualNote>
          </ManualSection>

          <ManualSection icon={Cpu} title="Probabilistic pipeline integrations">
            <p>
              The pipeline augments its deterministic module execution with several probabilistic features that bridge
              the gap between the LLM&apos;s inherent stochasticity and the system&apos;s structured processing. All features
              degrade gracefully: when embeddings are unavailable, env vars are unset, or calibration data does not
              exist, the system uses the original deterministic defaults.
            </p>
            <div className="mt-2 space-y-2">
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="mb-0.5 font-semibold text-primary">Embedding-based semantic similarity</div>
                <div className="mt-0.5 text-muted-foreground">
                  Replaces lexical Jaccard overlap with cosine similarity over vector embeddings in epistemic fusion,
                  personality facet ranking, and memory retrieval. Requires an OpenAI-compatible <code className="rounded bg-muted px-1">/v1/embeddings</code>{' '}
                  endpoint. Falls back to Jaccard when <code className="rounded bg-muted px-1">EMBEDDING_DISABLED=1</code> or unavailable.
                  Configure via <code className="rounded bg-muted px-1">EMBEDDING_MODEL</code>, <code className="rounded bg-muted px-1">EMBEDDING_BASE_URL</code>,{' '}
                  <code className="rounded bg-muted px-1">EMBEDDING_CACHE_SIZE</code> in <code className="rounded bg-muted px-1">.env</code>.
                </div>
              </div>
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="mb-0.5 font-semibold text-primary">Adaptive temperature</div>
                <div className="mt-0.5 text-muted-foreground">
                  LLM sampling temperature is derived from interoception signals (uncertainty pressure, curiosity, tension,
                  cognitive load) and the current cognitive phase. High uncertainty or curiosity raises temperature for more
                  exploratory generation; focused phases lower it. Disable with <code className="rounded bg-muted px-1">ADAPTIVE_TEMPERATURE_DISABLED=1</code>.
                </div>
              </div>
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="mb-0.5 font-semibold text-primary">Probabilistic metacognition</div>
                <div className="mt-0.5 text-muted-foreground">
                  Metacognition and Workspace Metacognition now emit confidence scores (e.g.{' '}
                  <code className="rounded bg-muted px-1">RERUN 0.73</code>). The rerun decision uses a soft threshold modulated by
                  interoception entropy, not a hard binary. The baseline threshold is set by{' '}
                  <code className="rounded bg-muted px-1">METACOGNITION_RERUN_THRESHOLD</code> (default 0.5).
                </div>
              </div>
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="mb-0.5 font-semibold text-primary">Probabilistic memory retrieval</div>
                <div className="mt-0.5 text-muted-foreground">
                  Long-term memory, belief digests, and timeline entries sent to the pipeline are re-ranked by embedding cosine
                  similarity blended with recency decay, replacing pure recency ordering. This means the most semantically relevant
                  memories surface even if they are not the most recent.
                </div>
              </div>
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="mb-0.5 font-semibold text-primary">Multi-sample modules</div>
                <div className="mt-0.5 text-muted-foreground">
                  Integration and Contradiction Engine can each run N parallel samples and merge results, producing more robust
                  outputs. Enable with <code className="rounded bg-muted px-1">PIPELINE_INTEGRATION_MULTI_SAMPLE=1</code> and{' '}
                  <code className="rounded bg-muted px-1">PIPELINE_CONTRADICTION_MULTI_SAMPLE=1</code>. Merge mode is set by{' '}
                  <code className="rounded bg-muted px-1">PIPELINE_MULTI_SAMPLE_MERGE</code> (<code className="rounded bg-muted px-1">llm</code> or{' '}
                  <code className="rounded bg-muted px-1">mechanical</code>).
                </div>
              </div>
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="mb-0.5 font-semibold text-primary">Stochastic cognitive policy</div>
                <div className="mt-0.5 text-muted-foreground">
                  The deterministic lookup table for <code className="rounded bg-muted px-1">cognitivePolicy</code> (memory breadth,
                  voice guidance, contradiction aggression, etc.) is replaced with distribution sampling modulated by interoception
                  state. This lets the system explore different behavioral strategies naturally. Disable with{' '}
                  <code className="rounded bg-muted px-1">STOCHASTIC_POLICY_DISABLED=1</code>.
                </div>
              </div>
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="mb-0.5 font-semibold text-primary">Calibrated thresholds &amp; telemetry</div>
                <div className="mt-0.5 text-muted-foreground">
                  All hardcoded decision thresholds (integration confidence, conflict pressure, entropy gates, arousal triggers)
                  are loaded from <code className="rounded bg-muted px-1">.data/calibrated-thresholds.json</code> and can be nudged
                  over time via <code className="rounded bg-muted px-1">POST /api/calibrate</code>, which applies exponential moving
                  averages over pipeline telemetry (<code className="rounded bg-muted px-1">.data/pipeline-telemetry.jsonl</code>).
                  View current values at <code className="rounded bg-muted px-1">GET /api/thresholds</code>.
                </div>
              </div>
            </div>
            <ManualNote>
              All probabilistic features are opt-in or on-by-default with env-var toggles. Existing saves, imports,
              and module prompts remain fully compatible. The system always falls back to its original deterministic
              behavior when a probabilistic subsystem is unavailable.
            </ManualNote>
          </ManualSection>

          <ManualSection icon={Radio} title="Global workspace, strict broadcast, and integration hints">
            <p>
              <strong className="text-foreground">Integration</strong> publishes{' '}
              <code className="rounded bg-muted px-1">INTEGRATION_JSON</code> into shared memory as{' '}
              <code className="rounded bg-muted px-1">globalWorkspace</code> (salience, stance, conflicts, broadcast winners,
              optional hypotheses and <strong className="text-foreground">bindings</strong>). Language → Narrative → Voice are
              prompted to treat that object as a Global Workspace Theory–style broadcast — an organizational metaphor, not a claim
              about literal consciousness.
            </p>
            <p>
              <strong className="text-foreground">Strict global-workspace broadcast</strong> (Local Mind → Settings) narrows{' '}
              <code className="rounded bg-muted px-1">SHARED_MEMORY_JSON.moduleOutputs</code> for those three modules so they
              lean on <code className="rounded bg-muted px-1">GLOBAL_WORKSPACE_JSON</code> plus key summaries (Attention,
              Contradiction Engine, Reasoning, supervisors, Integration, and workspace-linked modules). Enable it for
              stricter GWT-style discipline; disable it if replies lose needed detail on dense, belief-heavy turns.
            </p>
            <p>
              After Integration, the server may set <code className="rounded bg-muted px-1">workspaceIgnition</code> (ranked
              topics, optional dominant hypothesis id, conflict pressure, short notes) and lightly amend{' '}
              <strong className="text-foreground">phenomenal now</strong> so the moment line tracks the workspace line. None of
              this is an integrated-information or Φ measurement.
            </p>
            <p>
              On Graph Pipeline, <strong className="text-foreground">Inspector → Run context</strong> can list{' '}
              <strong className="text-foreground">Thread coupling (integration heuristic)</strong> from{' '}
              <code className="rounded bg-muted px-1">bindings</code> (supporting modules → claim). The JSON field{' '}
              <code className="rounded bg-muted px-1">iitProxy.causalTightness</code> is kept for backward compatibility — treat
              it as a heuristic &ldquo;thread tightness&rdquo; dial, not a validated neuroscience metric.
            </p>
            <ManualNote>
              <strong className="font-semibold text-foreground">Suggested manual checks:</strong>{' '}
              <strong className="text-foreground">Split unity</strong> with multiple conflicts — Voice should not force false
              unity; Narrative should respect recorded tension. <strong className="text-foreground">Strict broadcast on</strong>{' '}
              with a contradiction-heavy turn — Voice should not cite details that exist only in trimmed-away modules. Compare
              strict on vs off on the same input when judging the trade-off.{' '}
              <strong className="text-foreground">Workspace Metacognition</strong> should still pass when ignition and amended
              phenomenal now are present.
            </ManualNote>
          </ManualSection>

          <ManualSection icon={Play} title="Getting started — first graph run">
            <ManualStep n={1}>
              Open <strong className="text-foreground">Graph Pipeline</strong> in the sidebar (COGNITION).
            </ManualStep>
            <ManualStep n={2}>
              Optional: set cognitive phase, arousal, and intent — they steer memory breadth, contradiction pressure, and
              planning depth
              on the server.
            </ManualStep>
            <ManualStep n={3}>
              Enter text and/or attach files, then send from the bottom composer. The live transcript shows SSE progress
              (system lines, module chunks, Voice); open the collapsible <strong className="text-foreground">Execution graph</strong>{' '}
              for the node canvas.
            </ManualStep>
            <ManualStep n={4}>
              Read Voice in the transcript (and narrative when surfaced). Open{' '}
              <strong className="text-foreground">Long-Term Memory</strong>, <strong className="text-foreground">Belief Map</strong>,{' '}
              <strong className="text-foreground">Temporal</strong>, and <strong className="text-foreground">Self & consolidation</strong>{' '}
              after runs — auto-persistence runs on every saved Voice turn; Settings still control phase-based LTM auto-save.
              Structured belief extraction from recent runs runs automatically after each saved pipeline.
            </ManualStep>
            <ManualNote>
              Substantive prompts (reflection, trade-offs, scenarios) usually produce richer module traces than one-line trivia.
            </ManualNote>
          </ManualSection>

          <ManualSection icon={Layers} title="Graph Pipeline (unified transcript + graph)">
            <p>
              <strong className="text-foreground">Graph Pipeline</strong> — Single COGNITION entry. Server runs the full graph
              over <code className="rounded bg-muted px-1">POST /api/pipeline/stream</code> (SSE) with metacognitive reruns,
              attachments, and rich local preflight context. The page shows a <strong className="text-foreground">live transcript</strong>{' '}
              (module flow, system lines, Voice), a stage minimap, and optional collapsible panels for{' '}
              <strong className="text-foreground">This run — context</strong> and the <strong className="text-foreground">Execution graph</strong>{' '}
              (node canvas). Saved chat turns reload from the conversation store. The legacy path{' '}
              <code className="rounded bg-muted px-1">/consciousness-stream</code> redirects here. Debug a single module via{' '}
              <code className="rounded bg-muted px-1">POST /api/pipeline/module</code>.
            </p>
            <p>
              <strong className="text-foreground">Optional web lookup</strong> — Some modules may append a{' '}
              <code className="rounded bg-muted px-1">WEB_REQUEST</code> block (Brave Search or a public https URL). When{' '}
              <code className="rounded bg-muted px-1">BRAVE_SEARCH_API_KEY</code> is set on the API server, search requests can be
              fulfilled; otherwise the pipeline continues and notes may appear in shared memory. If a fetch fails or is stopped,{' '}
              <code className="rounded bg-muted px-1">webFetchSuppressedForRun</code> tells modules not to issue new web requests. Use{' '}
              <Link to="/output-search" className="font-medium text-primary underline-offset-2 hover:underline">
                Output search
              </Link>{' '}
              to find past runs by keyword across module text and Voice.{' '}
              <Link to="/live-analytics" className="font-medium text-primary underline-offset-2 hover:underline">
                Live Analytics
              </Link>{' '}
              lists every currently active pipeline (same sources as the Dashboard) with live module outputs for the current session.
            </p>
            <p>
              <strong className="text-foreground">Turn-to-turn context</strong> — By default, each new run clears the prior
              run’s module outputs from shared memory so the model prioritizes your latest message and recent dialogue;
              beliefs, constitution, user model, and long-term stores are unchanged. Enable{' '}
              <strong className="text-foreground">Preserve full module trace</strong> in Settings only if you need the next run to
              build directly on the previous Perception→Voice text. When the client prepends prior dialogue, the composed input can
              include <code className="rounded bg-muted px-1">RECENT_EXCHANGE</code> before the <code className="rounded bg-muted px-1">---</code>{' '}
              separator; the server exposes that head as <code className="rounded bg-muted px-1">recentExchangeBlock</code> for Temporal Awareness
              and continuity. Every module call also receives a <code className="rounded bg-muted px-1">PRIMARY_TURN</code> block echoing the
              current message after the separator.
            </p>
            <ManualStep n={1}>
              The transcript autoscrolls as the run progresses; scroll up in the stream to read earlier lines.
            </ManualStep>
            <ManualStep n={2}>Expand Execution graph at the bottom when you want the visual module layout.</ManualStep>
          </ManualSection>

          <ManualSection icon={Database} title="Memory system">
            <p>Three complementary layers:</p>
            <div className="space-y-2">
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="font-semibold text-sky-600 dark:text-sky-400">Shared Memory</div>
                <p className="mt-0.5 text-muted-foreground">
                  Working snapshot for the active pipeline: module outputs, <code className="rounded bg-muted px-1">globalWorkspace</code>,{' '}
                  hypothesis portfolio, web findings, optional <code className="rounded bg-muted px-1">recentExchangeBlock</code>, policy, phenomenal
                  now, etc. Inspect or edit JSON on the <strong className="text-foreground/90">Shared Memory</strong> page; useful when trimming
                  oversized sessions before another run.
                </p>
              </div>
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="font-semibold text-violet-600 dark:text-violet-400">Long-Term Memory</div>
                <p className="mt-0.5 text-muted-foreground">
                  Durable entries (episodic, semantic, procedural, emotional, dream). Graph Pipeline can auto-save narratives
                  when enabled in Settings. Use the search box to pull entries by relevance. During pipeline runs, memory entries
                  are now re-ranked by embedding cosine similarity blended with recency decay when embeddings are available,
                  surfacing the most semantically relevant context regardless of age.
                </p>
              </div>
              <div className="rounded-lg bg-muted/20 p-3 text-xs">
                <div className="font-semibold text-emerald-600 dark:text-emerald-400">Belief Store</div>
                <p className="mt-0.5 text-muted-foreground">
                  Structured beliefs with confidence and categories. Each completed pipeline updates one rolling row prefixed{' '}
                  <code className="rounded bg-muted px-1">[Pipeline belief digest]</code> with the latest Belief Store module
                  report (so the map does not flood with duplicate full reports). Use{' '}
                  <strong className="text-foreground/90">Extract from Pipeline</strong> or scheduled extraction for many atomic
                  beliefs; the same merge also runs automatically after each saved pipeline (see Settings → Functioning).
                </p>
              </div>
            </div>
            <ManualNote>
              Long text sent to the API is shortened at <strong className="text-foreground">word / sentence / paragraph</strong>{' '}
              boundaries when possible so stored fields and prompts stay complete thoughts rather than mid-word cuts (structured
              JSON fields are trimmed field-wise so payloads stay valid).
            </ManualNote>
            <ManualStep n={1}>Run the graph several times on varied topics.</ManualStep>
            <ManualStep n={2}>
              In Settings, tune <strong className="text-foreground">Auto-save final pipeline narratives</strong> for phase-based
              LTM; belief extraction after runs is always on.
            </ManualStep>
            <ManualStep n={3}>Search Long-Term Memory and open Belief Map to review what accumulated.</ManualStep>
          </ManualSection>

          <ManualSection icon={BookMarked} title="Mind pages — biography, beliefs, curiosity, goals, timeline, self">
            <p>
              <strong className="text-foreground">Mind Biography</strong> —{' '}
              <strong className="text-foreground">Write New Version</strong> synthesizes a first-person narrative from recent
              memories, beliefs, temporal events, and pipeline voices. Versions store summary, identity keywords, core values,
              and change notes. Between manual versions, every saved pipeline <strong className="text-foreground">appends</strong>{' '}
              a dated Voice / Narrative / phenomenal-now section to the latest biography (capped for storage) and{' '}
              <strong className="text-foreground">merges</strong> identity keywords and core values parsed from the Identity module
              and Narrative sections (IDENTITY, CORE VALUES, WHAT CHANGED) so Cognitive Health can score stability.
            </p>
            <p>
              <strong className="text-foreground">Belief Map</strong> — Visual belief network with filters; inspect nodes for
              details and tensions.
            </p>
            <p>
              <strong className="text-foreground">Curiosity Queue</strong> —{' '}
              <strong className="text-foreground">Generate Questions</strong> pulls from recent saved runs; add items manually.{' '}
              Each pipeline also adds an open item when the <strong className="text-foreground">Curiosity</strong> module output
              looks new (deduped). <strong className="text-foreground">Resolve</strong> / <strong className="text-foreground">Reopen</strong>{' '}
              toggles status.
            </p>
            <p>
              <strong className="text-foreground">Goals</strong> — First-class <strong className="text-foreground">GoalItem</strong>{' '}
              rows (manual or auto from <strong className="text-foreground">Goal Generation</strong> output, deduped).{' '}
              <strong className="text-foreground">Pursue (graph)</strong> runs the full pipeline on a framed goal prompt;{' '}
              <strong className="text-foreground">Quick pass</strong> is a single LLM reflection. Scheduled{' '}
              <code className="rounded bg-muted px-1">goal_pursuit</code> and suggestions use the same runners. After a graph pursuit,{' '}
              integration <strong className="text-foreground">open questions</strong> can spawn linked child goals (soft stack, not a hard planner).
            </p>
            <p>
              <strong className="text-foreground">Temporal Timeline</strong> — Shows <code className="rounded bg-muted px-1">pipeline_complete</code>{' '}
              events for every saved Voice run, phase events such as <code className="rounded bg-muted px-1">rhythm_wake</code>,{' '}
              JSON <code className="rounded bg-muted px-1">cognitive_health_metrics</code> snapshots listing store counts plus latest-run
              narrative/identity section flags and biography keyword tallies, plus <strong className="text-foreground">Add Event</strong>{' '}
              milestones you create.
            </p>
            <p>
              <strong className="text-foreground">Self & consolidation</strong> — Self-ledger revisions (identity excerpts),
              user-model snapshots, and <strong className="text-foreground">ConsolidationDigest</strong> rows. Every saved pipeline{' '}
              <strong className="text-foreground">adds</strong> a digest snapshot (Voice + Narrative);{' '}
              <strong className="text-foreground">Run consolidation</strong> (here or scheduled) still runs the deeper LLM merge
              into world hints and self note.
            </p>
            <ManualNote>Wait for several graph runs before the first biography — more context yields a steadier narrative.</ManualNote>
          </ManualSection>

          <ManualSection icon={Globe} title="World Model">
            <p>
              Slots for environment, self, goals, beliefs, relationships, events, constraints, and capabilities.{' '}
              <strong className="text-foreground">Identity</strong> can emit <code className="rounded bg-muted px-1">SELF_MODEL_DELTA</code>{' '}
              (merged into category <strong className="text-foreground">self</strong>).{' '}
              <strong className="text-foreground">Integration</strong> can drive world-model rows from <code className="rounded bg-muted px-1">INTEGRATION_JSON</code>{' '}
              (salience, conflicts, threads, <strong className="text-foreground">broadcast winners</strong>, and{' '}
              <strong className="text-foreground">phenomenal unity</strong> rationale — IIT-inspired labels, not literal Φ).{' '}
              <strong className="text-foreground">Belief Map</strong> rows can be reinforced when the Belief Store emits{' '}
              <code className="rounded bg-muted px-1">BELIEF_REVISIONS</code> (<code className="rounded bg-muted px-1">strengthen</code> /{' '}
              <code className="rounded bg-muted px-1">reinforce</code>).{' '}
              <strong className="text-foreground">Extract from Runs</strong> asks the model to merge broader recent context into
              structured rows.
            </p>
            <ManualStep n={1}>
              Collect some pipeline output and beliefs, then click <strong className="text-foreground">Extract from Runs</strong>.
            </ManualStep>
            <ManualStep n={2}>Edit confidence on each card and use categories to filter the board.</ManualStep>
            <ManualStep n={3}>Add manual rows when you want the mind to treat a fact as ground truth.</ManualStep>
          </ManualSection>

          <ManualSection icon={Moon} title="Dreaming Mode">
            <p>
              <strong className="text-foreground">Start Dream Run</strong> blends recent long-term memories and beliefs into a
              surreal synthesis, saves a dream-run record, and appends a <strong className="text-foreground">dream</strong>{' '}
              memory. It is a single creative pass — not an overnight trainer.
            </p>
            <ManualNote>Works best once long-term memory already has material to recombine.</ManualNote>
          </ManualSection>

          <ManualSection icon={Cpu} title="Training area — Datasets, RLHF, Training, System Chat">
            <p>
              Sidebar <strong className="text-foreground">TRAINING</strong> groups export and experiment tools; nothing here is a
              separate chat app — full SSE graph runs live under <strong className="text-foreground">Graph Pipeline</strong>.
            </p>
            <p>
              <strong className="text-foreground">Datasets</strong> — Create records from the latest pipeline export paths in
              the UI; stored locally for downstream use.
            </p>
            <p>
              <strong className="text-foreground">RLHF Loop</strong> — Rate candidate outputs (
              <strong className="text-foreground">Useful</strong> / <strong className="text-foreground">Weak</strong>); entries
              list as saved feedback for future dataset work.
            </p>
            <p>
              <strong className="text-foreground">Training</strong> — The Training page tracks named runs, objectives, and status
              transitions (draft → running → completed). It is an experiment log, not an on-device fine-tuner.
            </p>
            <p>
              <strong className="text-foreground">System Chat</strong> — Dual sequential <strong className="text-foreground">graph
              pipeline</strong> runs: System A uses your primary mind; System B uses an isolated mirror store. Voice from A becomes
              the user line for B. Optional random topic; see the System Chat section below.
            </p>
            <ManualNote>
              Promoting models, loss curves, and GPU jobs happen outside this UI — export data and train in your own stack.
            </ManualNote>
          </ManualSection>

          <ManualSection icon={Activity} title="Cognitive Health">
            <p>
              Snapshot cards for pipeline runs, beliefs, memories, open curiosity, RLHF balance, and dream runs, plus readiness
              hints. The radar blends belief, curiosity, memory, emergence counts, and biography identity stability (keywords, core
              values, and summary overlap). Use <strong className="text-foreground">Refresh</strong> after intensive sessions. The
              scheduled <strong className="text-foreground">cognitive health</strong> task can still call the LLM for a short narrative
              note; every saved pipeline also logs a <strong className="text-foreground">metrics-only</strong> timeline event you can
              inspect under Temporal.
            </p>
          </ManualSection>

          <ManualSection icon={Zap} title="Emergence Log">
            <p>
              <strong className="text-foreground">Scan for emergence</strong> uses the local JSON LLM (
              <code className="rounded bg-muted px-1">/api/llm/json</code>) to compare your three newest saved graph runs against
              older runs (module traces + voice line; Identity and Narrative are listed first in each bundle). Events above a
              deviation threshold are stored with optional output snapshots and an <strong className="text-foreground">emergence_category</strong>{' '}
              (identity vs reasoning vs style). Mark them reviewed when you have triaged them. <strong className="text-foreground">Pipeline
              heuristics</strong> (goal/belief/conflict language plus narrative sections and identity phrases) also run{' '}
              <strong className="text-foreground">after each saved pipeline</strong> and on the scheduled emergence task.
            </p>
          </ManualSection>

          <ManualSection icon={MessageSquare} title="System Chat">
            <p>
              Runs the <strong className="text-foreground">full server graph pipeline</strong> (SSE) twice in sequence: you compose
              System A&apos;s line (or use <strong className="text-foreground">Random topic</strong> to preview a suggested starter).
              A twin preamble tells System A it is addressing a peer pipeline; <strong className="text-foreground">Voice</strong> from
              A is then fed as System B&apos;s user input (with a short peer prefix). System B persists to a separate mirror mind
              (beliefs, memory, etc.); open <strong className="text-foreground">Mirror beliefs</strong> /{' '}
              <strong className="text-foreground">Mirror memory</strong> under System Chat to inspect. Use{' '}
              <strong className="text-foreground">Graph Pipeline</strong> when you want session tabs and a single primary run.
            </p>
          </ManualSection>

          <ManualSection icon={FlaskConical} title="Iterations">
            <p>
              Lists <strong>supervisor</strong> rerun records from shared memory (reason, rerun index, run id) — Metacognition and/or
              Workspace Metacognition. Pairs with Graph Pipeline when the server performs extra layer-1–4 passes within one saved run.
            </p>
          </ManualSection>

          <ManualSection icon={Radio} title="Scheduler">
            <p>
              Queue <strong>pipeline_run</strong>, <strong>consciousness_stream</strong> (same full SSE graph as Graph Pipeline;
              UI label: Graph pipeline — scheduled), <strong>dreaming</strong>, belief extraction, curiosity, goal pursuit, biography,
              world model, and other task types for later execution. Tasks persist in-browser until a runner executes them.
            </p>
          </ManualSection>

          <ManualSection icon={ScrollText} title="Settings & local / cloud LLM">
            <p>
              <strong className="text-foreground">Runtime</strong> — Model label, delays, max tokens,
              auto-save memories, auto-extract beliefs, <strong className="text-foreground">mind constitution &amp; user model</strong>{' '}
              (injected into pipeline context for Identity/Voice among others), optional per-module prompt overrides. Prefer
              imperative, persona-facing norms in constitution text (what to do / avoid) rather than phrases the model might echo
              verbatim in replies. <strong className="text-foreground">Save Settings</strong> persists to local runtime storage.
            </p>
            <p>
              <strong className="text-foreground">Backend</strong> — The API server can use{' '}
              <strong className="text-foreground">Hugging Face Inference</strong> first (
              <code className="rounded bg-muted px-1">HF_TOKEN</code>, <code className="rounded bg-muted px-1">HF_INFERENCE_MODELS</code>
              , router model ids may need a <code className="rounded bg-muted px-1">:provider</code> suffix), then fall back to{' '}
              <code className="rounded bg-muted px-1">LOCAL_LLM_BASE_URL</code>, <code className="rounded bg-muted px-1">LOCAL_LLM_MODELS</code>
              , and optional <code className="rounded bg-muted px-1">LM_API_TOKEN</code> (LM Studio, Ollama, vLLM, etc.). Set{' '}
              <code className="rounded bg-muted px-1">LLM_CONTEXT_TOKENS_MAX</code> to your loaded model&apos;s context (e.g.{' '}
              <code className="rounded bg-muted px-1">3900</code> for a 4096 <code className="rounded bg-muted px-1">n_ctx</code>
              ) so budgeting matches reality; optional <code className="rounded bg-muted px-1">LOCAL_LLM_COMPRESS_SHARED_MEMORY=1</code>{' '}
              trims prior module text when prompts are huge. Restart the backend after <code className="rounded bg-muted px-1">.env</code>{' '}
              edits; see <code className="rounded bg-muted px-1">.env.example</code> and the Settings guide.
            </p>
            <p>
              <strong className="text-foreground">Probabilistic features</strong> (configured in{' '}
              <code className="rounded bg-muted px-1">.env</code>) —{' '}
              <code className="rounded bg-muted px-1">EMBEDDING_MODEL</code> / <code className="rounded bg-muted px-1">EMBEDDING_BASE_URL</code>{' '}
              / <code className="rounded bg-muted px-1">EMBEDDING_DISABLED</code> for semantic similarity;{' '}
              <code className="rounded bg-muted px-1">ADAPTIVE_TEMPERATURE_DISABLED</code> for fixed temperature;{' '}
              <code className="rounded bg-muted px-1">METACOGNITION_RERUN_THRESHOLD</code> for soft rerun baseline;{' '}
              <code className="rounded bg-muted px-1">PIPELINE_INTEGRATION_MULTI_SAMPLE</code> /{' '}
              <code className="rounded bg-muted px-1">PIPELINE_CONTRADICTION_MULTI_SAMPLE</code> for multi-sample;{' '}
              <code className="rounded bg-muted px-1">STOCHASTIC_POLICY_DISABLED</code> for deterministic policy fallback;{' '}
              <code className="rounded bg-muted px-1">CALIBRATED_THRESHOLDS_PATH</code> /{' '}
              <code className="rounded bg-muted px-1">PIPELINE_TELEMETRY_PATH</code> for threshold calibration data.
              All default to sensible values; see <code className="rounded bg-muted px-1">.env.example</code> for full documentation.
            </p>
            <ManualStep n={1}>
              Point <code className="rounded bg-muted px-1">LOCAL_LLM_BASE_URL</code> at your OpenAI-compatible server (e.g. LM
              Studio on :1234), <strong className="text-foreground">not</strong> the Vite dev port.
            </ManualStep>
            <ManualStep n={2}>
              Set <code className="rounded bg-muted px-1">LOCAL_LLM_MODELS</code> to the exact model id the server exposes.
            </ManualStep>
            <ManualStep n={3}>
              Align <code className="rounded bg-muted px-1">LLM_CONTEXT_TOKENS_MAX</code> with the smallest context you use
              (local <code className="rounded bg-muted px-1">n_ctx</code> vs cloud limit) to avoid provider errors.
            </ManualStep>
            <ManualStep n={4}>Tune <code className="rounded bg-muted px-1">LOCAL_LLM_LOW_SPEC</code>, timeout, and compression flags if calls time out or overflow context.</ManualStep>
          </ManualSection>

          <ManualSection icon={Sparkles} title="Tips">
            <div className="space-y-2">
              {[
                'Run many graph sessions before expecting a stable biography or world model.',
                'Enable auto-save / auto-extract when you trust your model not to flood memory with noise.',
                'Use Belief Map filters to focus on contradictions, then resolve tensions in the data model.',
                'If the API still rejects oversized bodies, enable shared-memory compression in .env or shorten the session; context caps should match your model n_ctx.',
                'Check Cognitive Health and Emergence Log after bursts of runs to see aggregate signals.',
                'Use Graph Pipeline for standard single-primary graph sessions; use System Chat for dual sequential pipelines (primary + mirror peer).',
                'If Voice still sounds like it is quoting constitution or apologizing for training, tighten shared prompts in shared/pipelineModules.mjs or rephrase constitution text in Settings.',
                'Set EMBEDDING_MODEL in .env to enable semantic similarity across epistemic fusion, memory retrieval, and personality facet ranking.',
                'Run POST /api/calibrate after several pipeline sessions to let thresholds self-adjust from your telemetry data.',
                'If pipeline responses feel too random, set STOCHASTIC_POLICY_DISABLED=1 and ADAPTIVE_TEMPERATURE_DISABLED=1 to restore deterministic behavior.',
              ].map((tip, i) => (
                <ManualStep key={tip} n={i + 1}>
                  {tip}
                </ManualStep>
              ))}
            </div>
          </ManualSection>
        </div>
      </div>
    </PageShell>
  );
}

/** Task types that accept the optional prompt field below. */
const SCHEDULER_TASK_TYPES_WITH_PROMPT = new Set(['pipeline_run', 'consciousness_stream']);

/** Graph / stream and full-pipeline review jobs that honor mind phase + arousal. */
const SCHEDULER_PIPELINE_MIND_TASK_TYPES = new Set([
  'pipeline_run',
  'consciousness_stream',
  'metacognition_review',
  'diagnostic',
  'belief_tension_review',
  'curiosity_pursuit',
  'goal_pursuit',
]);

function defaultSchedulerArousalForTaskType() {
  return 0.55;
}

function schedulerPhaseShortLabel(id) {
  return MIND_PHASE_OPTIONS.find((p) => p.id === id)?.label || id || '—';
}

const SCHEDULER_STATUS_STYLES = {
  pending: 'text-amber-600 border-amber-500/25 bg-amber-500/5 dark:text-amber-400',
  running: 'text-primary border-primary/25 bg-primary/5',
  completed: 'text-green-600 border-green-500/25 bg-green-500/5 dark:text-green-400',
  failed: 'text-destructive border-destructive/25 bg-destructive/5',
  cancelled: 'text-muted-foreground border-border bg-muted/10',
  paused: 'text-amber-600 border-amber-500/25 bg-amber-500/5 dark:text-amber-400',
};

const SCHEDULER_STATUS_ICONS = {
  pending: Clock,
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: XCircle,
  paused: PauseCircle,
};

const schedulerSelectClass =
  'w-full rounded-md border border-input bg-muted/30 px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function formatSchedulerTime(value) {
  return value ? moment(value).format('lll') : '—';
}

/** Label for the manual run button (retry vs run due/paused pending now). */
function schedulerManualRunButtonLabel(task, status) {
  if (status === 'paused') return 'Resume';
  const s = normalizeSchedulerTaskStatus(task.status);
  if (s === 'pending') {
    const schedulePaused = isScheduledTaskSchedulePaused(task);
    const due = task.scheduled_at && new Date(task.scheduled_at).getTime() <= Date.now();
    if (schedulePaused || due) return 'Run now';
  }
  return 'Run again';
}

function isLegacyScheduledTask(t) {
  return !t.task_type && (t.name != null || t.cron !== undefined);
}

function SchedulerTaskCard({
  task,
  onCancel,
  onDelete,
  onUpdated,
  onRetryFailed,
  onToggleSchedulePause,
  retrying,
}) {
  const status = normalizeSchedulerTaskStatus(task.status);
  const Icon = SCHEDULER_STATUS_ICONS[status] || Clock;
  const schedulePaused = isScheduledTaskSchedulePaused(task);
  const isDue =
    status === 'pending' &&
    !schedulePaused &&
    task.scheduled_at &&
    new Date(task.scheduled_at) <= new Date();
  const label = SCHEDULER_TASK_LABELS[task.task_type] || task.task_type || 'Task';
  const canEdit = status === 'pending';

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editType, setEditType] = useState(task.task_type || 'dreaming');
  const [editScheduledLocal, setEditScheduledLocal] = useState('');
  const [editRecurrence, setEditRecurrence] = useState('once');
  const [editRecurrenceEnd, setEditRecurrenceEnd] = useState('');
  const [editCustomInterval, setEditCustomInterval] = useState('1');
  const [editCustomUnit, setEditCustomUnit] = useState('hours');
  const [editReason, setEditReason] = useState('');
  const [editInputText, setEditInputText] = useState('');
  const [editMindPhase, setEditMindPhase] = useState('focus');
  const [editMindArousal, setEditMindArousal] = useState(0.55);

  const beginEdit = () => {
    const tt = task.task_type || 'dreaming';
    setEditType(tt);
    setEditScheduledLocal(
      task.scheduled_at ? moment(task.scheduled_at).format('YYYY-MM-DDTHH:mm') : ''
    );
    setEditRecurrence(task.recurrence || 'once');
    setEditRecurrenceEnd(
      task.recurrence_end_date ? moment(task.recurrence_end_date).format('YYYY-MM-DDTHH:mm') : ''
    );
    setEditCustomInterval(String(task.recurrence_interval ?? 1));
    setEditCustomUnit(task.recurrence_unit || 'hours');
    setEditReason(task.reason || '');
    setEditInputText(task.input_text || '');
    setEditMindPhase(
      typeof task.mind_phase === 'string' && task.mind_phase
        ? task.mind_phase
        : getRuntimeSettings().defaultMindPhase || 'focus'
    );
    setEditMindArousal(
      typeof task.mind_arousal === 'number' && Number.isFinite(task.mind_arousal)
        ? task.mind_arousal
        : defaultSchedulerArousalForTaskType(tt)
    );
    setEditing(true);
  };

  const discardEdit = () => setEditing(false);

  const saveEdit = async () => {
    if (!editScheduledLocal.trim()) return;
    setSaving(true);
    try {
      const scheduledIso = new Date(editScheduledLocal).toISOString();
      await ScheduledTask.update(task.id, {
        task_type: editType,
        scheduled_at: scheduledIso,
        recurrence: editRecurrence,
        recurrence_end_date:
          editRecurrence === 'once'
            ? null
            : editRecurrenceEnd.trim()
              ? new Date(editRecurrenceEnd).toISOString()
              : null,
        recurrence_interval: editRecurrence === 'custom' ? Math.max(1, Number(editCustomInterval) || 1) : null,
        recurrence_unit: editRecurrence === 'custom' ? editCustomUnit : null,
        reason: editReason.trim() || null,
        input_text: editInputText.trim() || null,
        ...(SCHEDULER_PIPELINE_MIND_TASK_TYPES.has(editType)
          ? {
              mind_phase: editMindPhase,
              mind_arousal: Math.min(1, Math.max(0, Number(editMindArousal) || 0)),
            }
          : { mind_phase: null, mind_arousal: null }),
      });
      setEditing(false);
      onUpdated?.();
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (status !== 'pending') setEditing(false);
  }, [status, task.id]);

  if (editing && canEdit) {
    return (
      <div
        className={cn(
          'rounded-xl border p-4',
          SCHEDULER_STATUS_STYLES[status] || SCHEDULER_STATUS_STYLES.pending
        )}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">Edit scheduled task</span>
          <span className="text-[10px] text-muted-foreground">{task.id.slice(-12)}</span>
        </div>
        <div className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-3">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">Task type</label>
            <select
              className={schedulerSelectClass}
              value={editType}
              onChange={(e) => setEditType(e.target.value)}
            >
              {SCHEDULER_TASK_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {Object.entries(group.tasks).map(([val, lbl]) => (
                    <option key={val} value={val}>
                      {lbl}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              Run at (local)
            </label>
            <Input
              type="datetime-local"
              value={editScheduledLocal}
              onChange={(e) => setEditScheduledLocal(e.target.value)}
              className="bg-muted/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">Recurrence</label>
            <select
              className={schedulerSelectClass}
              value={editRecurrence}
              onChange={(e) => setEditRecurrence(e.target.value)}
            >
              <option value="once">One-time</option>
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="custom">Custom interval</option>
            </select>
          </div>
          {editRecurrence === 'custom' ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Every</span>
              <Input
                type="number"
                min={1}
                value={editCustomInterval}
                onChange={(e) => setEditCustomInterval(e.target.value)}
                className="w-20 bg-muted/30"
              />
              <select
                className={cn(schedulerSelectClass, 'w-auto min-w-[8rem]')}
                value={editCustomUnit}
                onChange={(e) => setEditCustomUnit(e.target.value)}
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
                <option value="weeks">Weeks</option>
                <option value="months">Months</option>
              </select>
            </div>
          ) : null}
          {editRecurrence !== 'once' ? (
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                End date (optional)
              </label>
              <Input
                type="datetime-local"
                value={editRecurrenceEnd}
                onChange={(e) => setEditRecurrenceEnd(e.target.value)}
                className="bg-muted/30"
              />
            </div>
          ) : null}
          {SCHEDULER_TASK_TYPES_WITH_PROMPT.has(editType) ? (
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">Prompt</label>
              <Textarea
                value={editInputText}
                onChange={(e) => setEditInputText(e.target.value)}
                className="min-h-[72px] bg-muted/30 text-sm"
                placeholder="Optional — same defaults as when creating"
              />
            </div>
          ) : null}
          {SCHEDULER_PIPELINE_MIND_TASK_TYPES.has(editType) ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Cognitive phase
                </label>
                <select
                  className={schedulerSelectClass}
                  value={editMindPhase}
                  onChange={(e) => setEditMindPhase(e.target.value)}
                >
                  {MIND_PHASE_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Arousal {editMindArousal.toFixed(2)}
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={editMindArousal}
                  onChange={(e) => setEditMindArousal(Number(e.target.value))}
                  className="w-full accent-primary"
                />
              </div>
            </div>
          ) : null}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              Reason / note
            </label>
            <Input value={editReason} onChange={(e) => setEditReason(e.target.value)} className="bg-muted/30" />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            className="gap-2"
            disabled={saving || !editScheduledLocal.trim()}
            onClick={saveEdit}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Save changes
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={discardEdit}>
            Discard
          </Button>
        </div>
      </div>
    );
  }

  const manualRunLabel = schedulerManualRunButtonLabel(task, status);

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border p-4',
        SCHEDULER_STATUS_STYLES[status] || SCHEDULER_STATUS_STYLES.pending
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', status === 'running' && 'animate-spin')} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{label}</span>
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-[10px]',
              SCHEDULER_STATUS_STYLES[status] || SCHEDULER_STATUS_STYLES.pending
            )}
          >
            {status}
          </span>
          {task.mind_storage_profile === MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR ? (
            <span
              className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-800 dark:text-violet-200"
              title="Scheduled for System B (mirror) entity stores"
            >
              Mirror
            </span>
          ) : null}
          {schedulePaused ? (
            <span className="font-mono text-[10px] text-muted-foreground">SCHEDULE PAUSED</span>
          ) : isDue ? (
            <span className="font-mono text-[10px] text-amber-600 dark:text-amber-300">DUE NOW</span>
          ) : null}
          {status === 'pending' && Number(task.scheduler_retry_attempt) > 0 ? (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-800 dark:text-amber-200">
              {(() => {
                const rt = getRuntimeSettings();
                const n = Number(task.scheduler_retry_attempt);
                if (rt.schedulerAutoRetryUnlimited !== false) {
                  return <>Auto-retry #{n}</>;
                }
                const max = Math.max(
                  0,
                  Math.floor(
                    Number(rt.schedulerAutoRetryMaxAttempts) ??
                      DEFAULT_RUNTIME_SETTINGS.schedulerAutoRetryMaxAttempts
                  )
                );
                return (
                  <>
                    Auto-retry {n}/{max}
                  </>
                );
              })()}
            </span>
          ) : null}
          <span className="ml-auto text-[10px] text-muted-foreground">
            {task.scheduled_by === 'ai' ? 'AI scheduled' : 'You scheduled'}
          </span>
        </div>
        {task.reason ? <p className="mt-1 text-xs italic text-muted-foreground">{task.reason}</p> : null}
        {SCHEDULER_PIPELINE_MIND_TASK_TYPES.has(task.task_type) &&
        (task.mind_phase != null || typeof task.mind_arousal === 'number') ? (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {task.mind_phase != null ? `Phase: ${schedulerPhaseShortLabel(task.mind_phase)}` : null}
            {task.mind_phase != null && typeof task.mind_arousal === 'number' ? ' · ' : null}
            {typeof task.mind_arousal === 'number' ? `Arousal: ${task.mind_arousal.toFixed(2)}` : null}
          </p>
        ) : null}
        {task.input_text ? <p className="mt-1 truncate text-xs text-foreground/80">&ldquo;{task.input_text}&rdquo;</p> : null}
        {task.result_summary ? (
          status === 'failed' ? (
            <div className="mt-1 space-y-1">
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 p-2 font-sans text-[11px] leading-relaxed text-foreground/90">
                {task.result_summary}
              </pre>
              <p className="text-[10px] text-muted-foreground">
                <span className="font-mono">[health_preflight]</span>: browser could not reach{' '}
                <span className="font-mono">GET /api/ping</span> via the dev proxy — keep{' '}
                <span className="font-mono">npm run dev</span> running (Express + Vite on port 5174, Hugging Face–first),
                same tab origin. Other tags: check <span className="font-mono">LOCAL_LLM_TIMEOUT_MS</span> for long modules.
              </p>
            </div>
          ) : (
            <p className="mt-1 text-xs text-foreground/85">{task.result_summary}</p>
          )
        ) : null}
        <p className="mt-1 text-[10px] text-muted-foreground">
          Scheduled for: {formatSchedulerTime(task.scheduled_at)} ({formatRelative(task.scheduled_at)})
        </p>
        {task.recurrence && task.recurrence !== 'once' ? (
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-primary/80">
            <Repeat className="h-3 w-3 shrink-0" />
            Repeats{' '}
            {task.recurrence === 'custom'
              ? `every ${task.recurrence_interval ?? '?'} ${task.recurrence_unit ?? ''}`
              : task.recurrence}
            {task.recurrence_end_date
              ? ` · ends ${formatSchedulerTime(task.recurrence_end_date)}`
              : ' · no end date'}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {status === 'pending' && onToggleSchedulePause ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            title={schedulePaused ? 'Resume automatic runs on this schedule' : 'Pause automatic runs (manual Run again still works when available)'}
            className="h-8 shrink-0 gap-1 px-2 text-[11px] font-medium"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void onToggleSchedulePause(task);
            }}
          >
            {schedulePaused ? (
              <>
                <Play className="h-3.5 w-3.5" />
                Resume schedule
              </>
            ) : (
              <>
                <Pause className="h-3.5 w-3.5" />
                Pause schedule
              </>
            )}
          </Button>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            title="Edit"
            className="p-1 opacity-40 transition-opacity hover:opacity-100"
            onClick={beginEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {(status === 'pending' || status === 'running') && onCancel ? (
          <button
            type="button"
            title={status === 'running' ? 'Stop run' : 'Cancel task'}
            className="p-1 opacity-40 transition-opacity hover:opacity-100"
            onClick={() => onCancel(task.id)}
          >
            <XCircle className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {(isSchedulerTaskManuallyRerunnable(task) || status === 'paused') && onRetryFailed ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            title={
              status === 'paused'
                ? 'Continue from saved checkpoint (same as Graph scheduled pipeline)'
                : manualRunLabel === 'Run now'
                  ? 'Run this job now (same as when the scheduler tick picks it up)'
                  : 'Retry after a failure (does not wait in the scheduler queue)'
            }
            className="h-8 shrink-0 gap-1 px-2 text-[11px] font-medium"
            disabled={retrying}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void onRetryFailed(String(task.id));
            }}
          >
            {retrying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {manualRunLabel}
          </Button>
        ) : null}
        {(status === 'completed' || status === 'failed' || status === 'cancelled') && onDelete ? (
          <button
            type="button"
            title="Delete"
            className="p-1 opacity-30 transition-opacity hover:opacity-100"
            onClick={() => onDelete(task.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function SchedulerPage() {
  const { isMirror } = useMindScope();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [schedulingSuggestionId, setSchedulingSuggestionId] = useState(null);
  const [taskType, setTaskType] = useState('dreaming');
  const [recurrence, setRecurrence] = useState('once');
  const [delayMinutes, setDelayMinutes] = useState(30);
  const [scheduledTime, setScheduledTime] = useState('');
  const [useAbsoluteTime, setUseAbsoluteTime] = useState(false);
  const [recurrenceEndDate, setRecurrenceEndDate] = useState('');
  const [customInterval, setCustomInterval] = useState(1);
  const [customUnit, setCustomUnit] = useState('hours');
  const [inputText, setInputText] = useState('');
  const [reason, setReason] = useState('');
  const [scheduleMindPhase, setScheduleMindPhase] = useState(
    () => getRuntimeSettings().defaultMindPhase || 'focus'
  );
  const [scheduleArousal, setScheduleArousal] = useState(0.55);
  /** Empty = use global Settings for scheduled pipeline tasks */
  const [scheduleMetaMaxReruns, setScheduleMetaMaxReruns] = useState('');
  const [scheduleMetaDelayMin, setScheduleMetaDelayMin] = useState('');
  const [scheduleMindTarget, setScheduleMindTarget] = useState(
    /** @type {typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR} */ (
      MIND_STORAGE_PROFILE_PRIMARY
    )
  );
  /** Align “Run for” with Primary | System B scope (`/scheduler` vs `/scheduler/mirror`). */
  useEffect(() => {
    setScheduleMindTarget(isMirror ? MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR : MIND_STORAGE_PROFILE_PRIMARY);
  }, [isMirror]);
  /** Per-suggestion mind target (`s.id` → profile); omitted keys default to Primary. */
  const [suggestionMindById, setSuggestionMindById] = useState(
    /** @type {Record<string, typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR>} */ ({})
  );
  const [creating, setCreating] = useState(false);
  const [retryingTaskId, setRetryingTaskId] = useState(null);
  const [releaseSchedulerHoldBusy, setReleaseSchedulerHoldBusy] = useState(false);
  const cooperativeSchedulerHoldActive = useSyncExternalStore(
    subscribeCooperativePauseAllExternalHold,
    isCooperativePauseAllExternalHoldActive,
    isCooperativePauseAllExternalHoldActive
  );

  useEffect(() => {
    if (SCHEDULER_PIPELINE_MIND_TASK_TYPES.has(taskType)) {
      setScheduleArousal(defaultSchedulerArousalForTaskType(taskType));
    }
  }, [taskType]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await ScheduledTask.list('-created_date', 100);
      setTasks(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      setSuggestions(await getSchedulerSuggestions());
    } catch (e) {
      console.warn('getSchedulerSuggestions', e);
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await load();
    await loadSuggestions();
  }, [load, loadSuggestions]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useMindStorageRefresh(refreshAll);

  const create = async () => {
    if (!taskType) return;
    setCreating(true);

    let delay = Number(delayMinutes) || 5;
    if (useAbsoluteTime && scheduledTime) {
      const ms = new Date(scheduledTime).getTime() - Date.now();
      delay = Math.max(1, Math.round(ms / 60000));
    }

    await scheduleTask(taskType, delay, {
      input_text: inputText || undefined,
      reason: reason || 'Manually scheduled',
      scheduled_by: 'user',
      recurrence,
      recurrence_end_date: recurrenceEndDate || undefined,
      recurrence_interval: recurrence === 'custom' ? Number(customInterval) : undefined,
      recurrence_unit: recurrence === 'custom' ? customUnit : undefined,
      mind_storage_profile: scheduleMindTarget,
      ...(SCHEDULER_PIPELINE_MIND_TASK_TYPES.has(taskType)
        ? {
            mind_phase: scheduleMindPhase,
            mind_arousal: Math.min(1, Math.max(0, Number(scheduleArousal) || 0)),
            ...(String(scheduleMetaMaxReruns).trim() !== ''
              ? { metacognition_max_reruns_override: Number(scheduleMetaMaxReruns) }
              : {}),
            ...(String(scheduleMetaDelayMin).trim() !== ''
              ? { metacognition_rerun_delay_minutes_override: Number(scheduleMetaDelayMin) }
              : {}),
          }
        : {}),
    });
    setInputText('');
    setReason('');
    await refreshAll();
    setCreating(false);
  };

  const scheduleFromSuggestion = async (s) => {
    setSchedulingSuggestionId(s.id);
    try {
      const rt = getRuntimeSettings();
      const suggestionProfile = suggestionMindById[s.id] ?? MIND_STORAGE_PROFILE_PRIMARY;
      const opts = {
        reason: `Suggested — ${s.detail}`,
        scheduled_by: 'suggestion',
        mind_storage_profile: suggestionProfile,
      };
      if (s.input_text != null && String(s.input_text).trim()) {
        opts.input_text = String(s.input_text).trim();
      }
      if (suggestionUsesMindOptions(s.task_type)) {
        opts.mind_phase = rt.defaultMindPhase || 'focus';
        opts.mind_arousal = defaultSchedulerArousalForTaskType(s.task_type);
      }
      await scheduleTask(s.task_type, s.delayMinutes ?? 20, opts);
      toast({
        title: 'Task scheduled',
        description: SCHEDULER_TASK_LABELS[s.task_type] || s.task_type,
      });
      await refreshAll();
    } catch (e) {
      console.error(e);
      toast({
        title: 'Could not schedule',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSchedulingSuggestionId(null);
    }
  };

  const cancel = async (id) => {
    const r = await stopScheduledTaskRunFromUi(id, { resultSummary: 'Cancelled.' });
    if (!r.ok) {
      toast({
        title: 'Could not cancel',
        description: r.message || '',
        variant: 'destructive',
      });
    }
    await refreshAll();
  };

  const deleteTask = async (id) => {
    clearPersistedSchedulerHeadlessFlightIfMatches(id);
    await ScheduledTask.delete(id);
    await refreshAll();
  };

  const toggleSchedulePause = async (task) => {
    const next = !isScheduledTaskSchedulePaused(task);
    try {
      await ScheduledTask.update(task.id, { schedule_paused: next });
      notifyMindStorageChanged({ source: 'scheduled-tasks' });
      await refreshAll();
    } catch (e) {
      toast({
        title: 'Could not update schedule',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  const runAgainOrResume = async (id) => {
    const taskId = String(id ?? '').trim();
    if (!taskId) return;
    if (isCooperativePauseAllExternalHoldActive()) {
      toast({
        title: 'Scheduler hold active',
        description: COOPERATIVE_PAUSE_HOLD_SCHEDULER_MESSAGE,
      });
      return;
    }
    setRetryingTaskId(taskId);
    let statusForToast = '';
    try {
      let probe;
      try {
        probe = await ScheduledTask.retrieve(taskId);
      } catch {
        probe = null;
      }
      statusForToast = probe ? normalizeSchedulerTaskStatus(probe.status) : '';

      if (statusForToast === 'paused') {
        await resumePausedScheduledPipelineTask(taskId);
        toast({
          title: 'Scheduled pipeline resumed',
          description: 'Continuing from the saved checkpoint. Watch Active pipelines or this task’s status for progress.',
        });
      } else {
        await retryFailedScheduledTask(taskId);
        toast({
          title: 'Scheduled task finished',
          description: 'Run again completed. Check this row’s status and result summary.',
        });
      }
      await refreshAll();
    } catch (e) {
      const skipped =
        e instanceof SchedulerRetrySkippedError ||
        (e instanceof Error && e.name === 'SchedulerRetrySkippedError');
      toast({
        title: skipped
          ? 'Run again skipped'
          : statusForToast === 'paused'
            ? 'Could not resume'
            : 'Scheduled task failed',
        description: e instanceof Error ? e.message : String(e),
        variant: skipped ? 'default' : 'destructive',
      });
      await refreshAll();
    } finally {
      setRetryingTaskId(null);
    }
  };

  const toggleLegacy = async (task) => {
    await ScheduledTask.update(task.id, { enabled: !task.enabled });
    await refreshAll();
  };

  const removeLegacy = async (id) => {
    await ScheduledTask.delete(id);
    await refreshAll();
  };

  const modernTasks = tasks.filter((t) => !isLegacyScheduledTask(t));
  const legacyTasks = tasks.filter((t) => isLegacyScheduledTask(t));
  const upcoming = modernTasks.filter((t) => {
    const s = normalizeSchedulerTaskStatus(t.status);
    return s === 'pending' || s === 'running';
  });
  const history = modernTasks.filter((t) => {
    const s = normalizeSchedulerTaskStatus(t.status);
    return s !== 'pending' && s !== 'running';
  });

  return (
    <div className="w-full min-h-0 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        {cooperativeSchedulerHoldActive ? (
          <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-foreground/90">
              <span className="font-medium">Scheduled work is held</span> after Dashboard &quot;Pause &amp; save
              all&quot;. Due tasks and &quot;Run again&quot; stay blocked until you release the hold (same as
              Dashboard &quot;Resume all&quot;).
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0 gap-1.5"
              disabled={releaseSchedulerHoldBusy}
              onClick={() => {
                void (async () => {
                  setReleaseSchedulerHoldBusy(true);
                  try {
                    setCooperativePauseAllExternalHold(false);
                    await flushSchedulerDueTasksNow();
                    await refreshAll();
                    toast({
                      title: 'Scheduler hold released',
                      description: 'Due tasks can run on the next tick.',
                    });
                  } finally {
                    setReleaseSchedulerHoldBusy(false);
                  }
                })();
              }}
            >
              {releaseSchedulerHoldBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Release hold
            </Button>
          </div>
        ) : null}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <Clock className="h-6 w-6 text-primary" />
              Autonomous scheduler
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Queue any job the mind might assign itself — graph pipeline, stream, consolidation,
              beliefs, curiosity, biography, DMN reflection, world model, dreaming, memory and timeline reflection, health
              and emergence scans. While the app is open, due tasks run automatically. Use{' '}
              <span className="font-medium text-foreground/90">Pause schedule</span> on a queued row to stop only that
              job from auto-firing until you resume it. Closing the browser pauses until you return.
            </p>
          </div>
          <Button
            variant="outline"
            size="icon"
            type="button"
            className="shrink-0"
            onClick={() => void refreshAll()}
            disabled={loading || suggestionsLoading}
            aria-label="Refresh list"
          >
            <RefreshCw
              className={cn('h-4 w-4', (loading || suggestionsLoading) && 'animate-spin')}
            />
          </Button>
        </div>

        <div className="mb-6 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" />
            Suggested tasks
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Based on Belief Map tensions, open curiosities, pipeline runs, world model, biography, and emergence logs.
            Types that already have a pending or running task are omitted.
          </p>
          {suggestionsLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : suggestions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/80 bg-card/50 py-5 text-center text-xs text-muted-foreground">
              No suggestions right now — everything looks covered or quiet.
            </div>
          ) : (
            <ul className="space-y-2">
              {suggestions.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{s.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {SCHEDULER_TASK_LABELS[s.task_type] || s.task_type} · first run in ~{s.delayMinutes}m
                    </div>
                    <div className="mt-1 text-xs text-foreground/85">{s.detail}</div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="min-w-0 sm:w-44">
                      <label className="mb-0.5 block text-[10px] uppercase tracking-wider text-muted-foreground">
                        Run for
                      </label>
                      <select
                        className={cn(schedulerSelectClass, 'h-8 w-full')}
                        value={suggestionMindById[s.id] ?? MIND_STORAGE_PROFILE_PRIMARY}
                        title="Which mind’s stores this scheduled run uses (when the task type supports mirror)."
                        onChange={(e) => {
                          const v =
                            /** @type {typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR} */ (
                              e.target.value
                            );
                          setSuggestionMindById((prev) => ({ ...prev, [s.id]: v }));
                        }}
                      >
                        <option value={MIND_STORAGE_PROFILE_PRIMARY}>Primary mind</option>
                        <option value={MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR}>System B (mirror)</option>
                      </select>
                    </div>
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0 gap-1.5 self-end sm:self-end"
                    disabled={schedulingSuggestionId != null}
                    onClick={() => void scheduleFromSuggestion(s)}
                  >
                    {schedulingSuggestionId === s.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Clock className="h-3.5 w-3.5" />
                    )}
                    Schedule
                  </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Plus className="h-4 w-4 text-primary" />
            Schedule a task
          </h2>

          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">Task type</label>
              <select
                className={schedulerSelectClass}
                value={taskType}
                onChange={(e) => setTaskType(e.target.value)}
              >
                {SCHEDULER_TASK_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {Object.entries(group.tasks).map(([val, label]) => (
                      <option key={val} value={val}>
                        {label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">Recurrence</label>
              <select
                className={schedulerSelectClass}
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value)}
              >
                <option value="once">One-time</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="custom">Custom interval</option>
              </select>
            </div>
          </div>

          <div className="mb-3">
            <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
              Run for
            </label>
            <select
              className={schedulerSelectClass}
              value={scheduleMindTarget}
              title="Where pipeline output and dialogue rows are written when the task type supports System B."
              onChange={(e) =>
                setScheduleMindTarget(
                  /** @type {typeof MIND_STORAGE_PROFILE_PRIMARY | typeof MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR} */ (
                    e.target.value
                  )
                )
              }
            >
              <option value={MIND_STORAGE_PROFILE_PRIMARY}>Primary mind</option>
              <option value={MIND_STORAGE_PROFILE_PLAYGROUND_MIRROR}>System B (mirror)</option>
            </select>
          </div>

          {recurrence === 'custom' ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="whitespace-nowrap text-xs text-muted-foreground">Every</span>
              <Input
                type="number"
                min={1}
                value={customInterval}
                onChange={(e) => setCustomInterval(e.target.value)}
                className="w-20 bg-muted/30"
              />
              <select
                className={cn(schedulerSelectClass, 'w-auto min-w-[8rem]')}
                value={customUnit}
                onChange={(e) => setCustomUnit(e.target.value)}
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
                <option value="weeks">Weeks</option>
                <option value="months">Months</option>
              </select>
            </div>
          ) : null}

          <div className="mb-3">
            <div className="mb-1 flex flex-wrap items-center gap-3">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">First run</span>
              <button
                type="button"
                className="text-[10px] text-primary underline"
                onClick={() => setUseAbsoluteTime(!useAbsoluteTime)}
              >
                {useAbsoluteTime ? 'Switch to delay' : 'Set exact time'}
              </button>
            </div>
            {useAbsoluteTime ? (
              <Input
                type="datetime-local"
                value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)}
                className="bg-muted/30"
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={delayMinutes}
                  onChange={(e) => setDelayMinutes(e.target.value)}
                  className="w-24 bg-muted/30"
                />
                <span className="text-sm text-muted-foreground">minutes from now</span>
              </div>
            )}
          </div>

          {recurrence !== 'once' ? (
            <div className="mb-3">
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                End date (optional — blank = no end)
              </label>
              <Input
                type="datetime-local"
                value={recurrenceEndDate}
                onChange={(e) => setRecurrenceEndDate(e.target.value)}
                className="bg-muted/30"
              />
            </div>
          ) : null}

          {SCHEDULER_TASK_TYPES_WITH_PROMPT.has(taskType) ? (
            <div className="mb-3">
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                Prompt (optional — sensible default if empty)
              </label>
              <Input
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={
                  taskType === 'consciousness_stream'
                    ? 'Scheduled graph run input (or leave blank for autonomous continuation)…'
                    : 'Graph pipeline input…'
                }
                className="bg-muted/30"
              />
            </div>
          ) : null}
          {SCHEDULER_PIPELINE_MIND_TASK_TYPES.has(taskType) ? (
            <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Cognitive phase
                </label>
                <select
                  className={schedulerSelectClass}
                  value={scheduleMindPhase}
                  onChange={(e) => setScheduleMindPhase(e.target.value)}
                >
                  {MIND_PHASE_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Arousal {scheduleArousal.toFixed(2)}
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={scheduleArousal}
                  onChange={(e) => setScheduleArousal(Number(e.target.value))}
                  className="w-full accent-primary"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Metacognition reruns / delay (optional — blank = Settings)
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={20}
                    value={scheduleMetaMaxReruns}
                    onChange={(e) => setScheduleMetaMaxReruns(e.target.value)}
                    placeholder="Max reruns"
                    className="h-8 w-28 bg-muted/30 font-mono text-[11px]"
                  />
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    value={scheduleMetaDelayMin}
                    onChange={(e) => setScheduleMetaDelayMin(e.target.value)}
                    placeholder="Delay min"
                    className="h-8 w-28 bg-muted/30 font-mono text-[11px]"
                  />
                </div>
              </div>
            </div>
          ) : null}
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason / note (optional)…"
            className="mb-3 bg-muted/30"
          />
          <Button type="button" onClick={create} disabled={creating} size="sm" className="gap-2">
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
            Schedule task
          </Button>
        </div>

        <div className="mb-6">
          <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">
            Queue ({upcoming.length})
          </h2>
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            </div>
          ) : upcoming.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No queued tasks. When a job is due, it appears here as running, then moves to history.
            </div>
          ) : (
            <div className="space-y-2">
              {upcoming.map((task) => (
                <SchedulerTaskCard
                  key={task.id}
                  task={task}
                  onCancel={normalizeSchedulerTaskStatus(task.status) === 'pending' ? cancel : undefined}
                  onUpdated={refreshAll}
                  onRetryFailed={runAgainOrResume}
                  onToggleSchedulePause={
                    normalizeSchedulerTaskStatus(task.status) === 'pending' ? toggleSchedulePause : undefined
                  }
                  retrying={retryingTaskId === task.id}
                />
              ))}
            </div>
          )}
        </div>

        {history.length > 0 ? (
          <div className="mb-6">
            <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">History</h2>
            <div className="space-y-2">
              {history.map((task) => (
                <SchedulerTaskCard
                  key={task.id}
                  task={task}
                  onDelete={deleteTask}
                  onRetryFailed={runAgainOrResume}
                  retrying={retryingTaskId === task.id}
                />
              ))}
            </div>
          </div>
        ) : null}

        {legacyTasks.length > 0 ? (
          <div>
            <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">
              Legacy cron-style tasks ({legacyTasks.length})
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Older entries used name + cron text only. You can still enable/disable or remove them.
            </p>
            <div className="space-y-3">
              {legacyTasks.map((t) => (
                <Panel key={t.id}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="text-sm font-semibold">{t.name || '(unnamed)'}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t.enabled !== false ? 'enabled' : 'disabled'} · {t.cron || 'no cron'} ·{' '}
                        {formatRelative(t.created_date)}
                      </div>
                      {t.notes ? <div className="mt-2 text-sm text-foreground/80">{t.notes}</div> : null}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" type="button" onClick={() => toggleLegacy(t)}>
                        {t.enabled !== false ? 'Disable' : 'Enable'}
                      </Button>
                      <Button variant="ghost" size="icon" type="button" onClick={() => removeLegacy(t.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </Panel>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

