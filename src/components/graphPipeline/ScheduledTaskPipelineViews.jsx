import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Clock, GitBranch, Loader2, Play } from 'lucide-react';
import { getFirstProcessingModuleId } from '../../lib/cognitiveModules';
import {
  getSchedulerPipelineUiSnapshot,
  seedSchedulerPipelineUiFromPausedTasks,
  subscribeSchedulerPipelineUi,
} from '../../lib/schedulerPipelineUiStore';
import {
  listPausedScheduledGraphTasks,
  resumePausedScheduledPipelineTask,
} from '../../lib/scheduledTaskRunner';
import { getSchedulerPipelineEntryTopicSummary } from '../../lib/schedulerTaskDisplayTopic';
import { getSchedulerTaskTypeLabel } from '../../lib/schedulerTaskLabels';
import ModuleOutputsCollapsibleList from '../pipeline/ModuleOutputsCollapsibleList';
import { Button, toast } from '../ui';
import { cn } from '../../lib/utils';
import { DEFAULT_GRAPH_SESSION_ID } from '../../lib/graphPipelineSessionScope';

function schedulerHeadlessActiveModuleId(moduleStatuses) {
  return getFirstProcessingModuleId(moduleStatuses);
}

export function ScheduledPipelineRunContext({ entry }) {
  const input = String(entry?.runInputText || '').trim();
  const reason = String(entry?.runReason || '').trim();
  const showReasonSeparate = Boolean(reason && reason !== input);

  if (!input && !reason) {
    return (
      <p className="rounded-lg border border-dashed border-border/60 bg-muted/10 px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
        No input or reason was stored on this scheduled task.
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-muted/10 p-3 sm:p-4">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/90">
        Original run input and context
      </div>
      {input ? (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-foreground/90">
          {input}
        </pre>
      ) : null}
      {!input && reason ? (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-foreground/90">
          {reason}
        </pre>
      ) : null}
      {input && showReasonSeparate ? (
        <p className="border-t border-border/50 pt-2 text-[10px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-muted-foreground/90">Reason: </span>
          {reason}
        </p>
      ) : null}
    </div>
  );
}

function useSeedPausedSchedulerPipelineUi() {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listPausedScheduledGraphTasks();
        if (cancelled || !rows.length) return;
        seedSchedulerPipelineUiFromPausedTasks(rows);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

/**
 * Secondary inspector content: pause/resume, run context, module outputs.
 * Live minimap / neural / log lives in {@link ../pipeline/SchedulerTaskPipelineLivePanel} (same strip as graph workspace).
 * @param {{ taskId: string }} props
 */
export function ScheduledTaskPipelineDetail({ taskId }) {
  useSeedPausedSchedulerPipelineUi();
  const [resumeBusyId, setResumeBusyId] = useState(null);

  const snap = useSyncExternalStore(
    subscribeSchedulerPipelineUi,
    getSchedulerPipelineUiSnapshot,
    getSchedulerPipelineUiSnapshot
  );
  const tid = String(taskId || '').trim();
  const entry = tid ? snap.byTaskId[tid] : null;

  if (!tid) {
    return (
      <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">Missing task id.</p>
    );
  }

  if (!entry) {
    return (
      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/10 px-3 py-4 sm:px-4">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          This scheduled task is not in the live pipeline buffer (it may have finished, not started yet, or this tab lost
          the connection). Open the{' '}
          <Link to="/scheduler" className="text-primary underline-offset-2 hover:underline">
            Scheduler
          </Link>{' '}
          for task status, or start a new run from the queue.
        </p>
      </div>
    );
  }

  const pipelineUi = entry.ui;

  return (
    <div className="space-y-4">
      {entry.paused ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-500/35 bg-sky-500/[0.07] px-3 py-2 dark:bg-sky-950/20">
          <p className="min-w-0 flex-1 text-[10px] leading-snug text-muted-foreground">
            <span className="font-semibold text-foreground/90">Paused</span> — checkpoint saved on the scheduler task.
            {entry.pauseNextModule ? (
              <span className="mt-0.5 block font-mono text-[9px] text-muted-foreground/90">
                Next module: {entry.pauseNextModule}
              </span>
            ) : null}
          </p>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-7 shrink-0 gap-1 text-[10px]"
            disabled={resumeBusyId === tid}
            onClick={() => {
              setResumeBusyId(tid);
              void (async () => {
                try {
                  await resumePausedScheduledPipelineTask(tid);
                  toast({
                    title: 'Resuming scheduled pipeline',
                    description: 'Continuing from the saved checkpoint…',
                  });
                } catch (e) {
                  toast({
                    title: 'Could not resume',
                    description: e instanceof Error ? e.message : String(e),
                    variant: 'destructive',
                  });
                } finally {
                  setResumeBusyId(null);
                }
              })();
            }}
          >
            <Play className="h-3 w-3 shrink-0" aria-hidden />
            Continue
          </Button>
        </div>
      ) : null}
      <ScheduledPipelineRunContext entry={entry} />
      <div className="rounded-xl border border-border/70 bg-muted/5 p-3 sm:p-4">
        <ModuleOutputsCollapsibleList
          moduleStatuses={pipelineUi.moduleStatuses}
          moduleOutputs={pipelineUi.moduleOutputs}
          heading="Module outputs"
          maxChars={12_000}
        />
      </div>
    </div>
  );
}

/**
 * Rows like Sessions list — each scheduled pipeline links to its own page.
 * @param {{ currentSessionId?: string }} props
 */
export function ScheduledTaskListPanel({ currentSessionId = DEFAULT_GRAPH_SESSION_ID }) {
  useSeedPausedSchedulerPipelineUi();

  const snap = useSyncExternalStore(
    subscribeSchedulerPipelineUi,
    getSchedulerPipelineUiSnapshot,
    getSchedulerPipelineUiSnapshot
  );
  const taskIds = snap.taskIds?.length ? snap.taskIds : [];

  if (taskIds.length === 0) {
    return (
      <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">
        No scheduled graph pipelines right now.
      </p>
    );
  }

  const fromQ = encodeURIComponent(String(currentSessionId || DEFAULT_GRAPH_SESSION_ID).trim() || DEFAULT_GRAPH_SESSION_ID);

  return (
    <div className="space-y-2">
      <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-[10px] leading-snug text-muted-foreground">
        Each row opens the same live pipeline view as a graph workspace (stage map, neural map,{' '}
        <span className="font-mono text-[10px]">execution.log</span>) plus run context and module outputs below.
      </p>
      <div className="space-y-2">
        {taskIds.map((tid) => {
          const entry = snap.byTaskId[tid];
          if (!entry) return null;
          const pipelineUi = entry.ui;
          const activeModuleId = schedulerHeadlessActiveModuleId(pipelineUi.moduleStatuses);
          const isProcessing = Boolean(activeModuleId);
          const typeLabel = getSchedulerTaskTypeLabel(entry.taskType);
          const topicSummary = getSchedulerPipelineEntryTopicSummary(entry);
          const headline = topicSummary || typeLabel || entry.taskType || 'Scheduled pipeline';
          const href = `/graph-pipeline/scheduled/${encodeURIComponent(tid)}?from=${fromQ}`;

          return (
            <div
              key={tid}
              className={cn(
                'flex items-stretch gap-0 overflow-hidden rounded-lg border transition-colors',
                'border-border/80 bg-card/40 hover:bg-muted/30'
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <Link
                    to={href}
                    className="shrink-0 pt-0.5 text-primary hover:opacity-80"
                    aria-label={`Open scheduled pipeline ${headline}`}
                  >
                    <Clock className="h-4 w-4" aria-hidden />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0">
                      <Link
                        to={href}
                        className="min-w-0 text-left text-sm font-medium text-foreground hover:underline"
                        title={headline}
                      >
                        <span className="line-clamp-2">{headline}</span>
                      </Link>
                    </div>
                    {topicSummary && headline !== topicSummary ? (
                      <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground" title={topicSummary}>
                        {topicSummary}
                      </div>
                    ) : null}
                    <Link
                      to={href}
                      className="mt-0.5 block font-mono text-[10px] text-muted-foreground/90 hover:underline"
                    >
                      {tid}
                    </Link>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end sm:text-right text-muted-foreground">
                  <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                    {entry.paused ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
                        Paused
                      </span>
                    ) : isProcessing ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        Running
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">Idle</span>
                    )}
                    <span className="max-w-[12rem] truncate text-[10px] text-muted-foreground/90 sm:text-right">
                      {typeLabel || entry.taskType || 'scheduler'}
                    </span>
                  </div>
                  <Link
                    to={href}
                    className="inline-flex items-center gap-1 text-[10px] font-medium text-primary underline-offset-2 hover:underline"
                  >
                    <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
                    Open pipeline
                  </Link>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
