import { useMemo, useSyncExternalStore } from 'react';
import { ArrowLeft, GitBranch } from 'lucide-react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import SchedulerTaskPipelineLivePanel from '../components/pipeline/SchedulerTaskPipelineLivePanel';
import { ScheduledTaskPipelineDetail } from '../components/graphPipeline/ScheduledTaskPipelineViews';
import { DEFAULT_GRAPH_SESSION_ID } from '../lib/graphPipelineSessionScope';
import { getFirstProcessingModuleId } from '../lib/cognitiveModules';
import { getSchedulerPipelineEntryTopicSummary } from '../lib/schedulerTaskDisplayTopic';
import { getSchedulerTaskTypeLabel } from '../lib/schedulerTaskLabels';
import { getSchedulerPipelineUiSnapshot, subscribeSchedulerPipelineUi } from '../lib/schedulerPipelineUiStore';

function WorkspaceHeaderDescription() {
  return (
    <p className="text-[11px] leading-snug text-muted-foreground">
      Same live strip as a graph workspace (minimap · neural map · execution.log). Below: pause/resume, original run
      context, and module outputs.{' '}
      <Link to="/graph-pipeline" className="text-primary underline-offset-2 hover:underline">
        All sessions
      </Link>
      {' · '}
      <Link to="/scheduler" className="text-primary underline-offset-2 hover:underline">
        Scheduler
      </Link>
    </p>
  );
}

export default function GraphPipelineScheduledTaskPage() {
  const { taskId: rawTaskId } = useParams();
  const [searchParams] = useSearchParams();

  const taskId = useMemo(() => {
    try {
      return decodeURIComponent(String(rawTaskId || '').trim());
    } catch {
      return String(rawTaskId || '').trim();
    }
  }, [rawTaskId]);

  const fromRaw = searchParams.get('from');
  const fromSession = String(fromRaw || DEFAULT_GRAPH_SESSION_ID).trim() || DEFAULT_GRAPH_SESSION_ID;
  const backHref = `/graph-pipeline/${encodeURIComponent(fromSession)}?tab=scheduled`;

  const snap = useSyncExternalStore(
    subscribeSchedulerPipelineUi,
    getSchedulerPipelineUiSnapshot,
    getSchedulerPipelineUiSnapshot
  );
  const entry = taskId ? snap.byTaskId[taskId] : null;
  const typeLabel = entry ? getSchedulerTaskTypeLabel(entry.taskType) : '';
  const topicSummary = entry ? getSchedulerPipelineEntryTopicSummary(entry) : '';
  const title = entry
    ? (topicSummary || typeLabel || entry.taskType || '').trim() || 'Scheduled pipeline'
    : '';
  const shortId = taskId.length > 14 ? `${taskId.slice(0, 8)}…${taskId.slice(-6)}` : taskId;

  const ms = entry?.ui?.moduleStatuses;
  const isProcessing = Boolean(entry && getFirstProcessingModuleId(ms));

  if (!taskId) {
    return <Navigate to="/graph-pipeline" replace />;
  }

  return (
    <div className="scroll-mt-4 flex min-h-0 flex-1 flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-card/40 px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={backHref}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Scheduled list
            </Link>
            <Link
              to="/graph-pipeline"
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              All runs
            </Link>
          </div>
          <div className="flex min-w-0 items-start gap-3">
            <div className="relative shrink-0 pt-0.5">
              <GitBranch className="h-5 w-5 text-primary" />
              {isProcessing ? (
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-ping rounded-full bg-primary" />
              ) : null}
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold text-foreground">Scheduled graph pipeline</h1>
              <WorkspaceHeaderDescription />
              {title ? (
                <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground/90" title={title}>
                  <span className="font-medium text-muted-foreground">Topic: </span>
                  {title}
                </p>
              ) : null}
              <p className="mt-1 font-mono text-[10px] text-muted-foreground/90" title={taskId}>
                {shortId}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
        <SchedulerTaskPipelineLivePanel taskId={taskId} />
        <div className="min-h-0 flex-1 overflow-y-auto border-b border-border/70 bg-muted/5 px-3 py-3 sm:px-4">
          <ScheduledTaskPipelineDetail taskId={taskId} />
        </div>
      </div>

      <div id="graph-pipeline-bottom" className="h-px w-full shrink-0 scroll-mt-4" aria-hidden />
    </div>
  );
}
