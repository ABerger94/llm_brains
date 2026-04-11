import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Eye, GitBranch, Loader2, Trash2 } from 'lucide-react';
import { Button } from '../ui';
import GraphSessionLabelInline, { graphSessionDisplayTitle } from './GraphSessionLabelInline';
import { removeGraphPipelineSession } from '../../lib/graphPipelineSessionRegistry';
import { DEFAULT_GRAPH_SESSION_ID } from '../../lib/graphPipelineSessionScope';
import { cn } from '../../lib/utils';

function scheduleAfterReactFlush(fn) {
  if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else Promise.resolve().then(fn);
}

function truncateId(id) {
  if (!id || id.length <= 16) return id;
  return `${id.slice(0, 6)}...${id.slice(-6)}`;
}

function GraphSessionRemoveColumn({ title, pendingDelete, setPendingDelete, onConfirmRemove }) {
  return (
    <div
      className="relative z-20 isolate flex min-w-[7rem] shrink-0 flex-col items-stretch justify-center border-l border-border/70 bg-muted/5 px-1.5 py-1.5 sm:min-w-[8rem] sm:px-2"
      data-graph-session-remove-root
    >
      {pendingDelete ? (
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
                setPendingDelete(false);
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
                onConfirmRemove();
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
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${title} from list`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            scheduleAfterReactFlush(() => setPendingDelete(true));
          }}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}

function StatusBadge({ mode }) {
  if (mode === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
      Idle
    </span>
  );
}

/**
 * @param {{
 *   s: { id: string, label: string, threadRootLabel?: string, updatedAt?: number, isProcessing?: boolean },
 *   mode: 'idle' | 'running',
 *   onPeekSession: (payload: { sessionId: string, title: string }) => void,
 *   onSessionRemoved?: (sessionId: string) => void,
 *   updatedLabel?: string,
 * }} props
 */
export default function GraphPipelineRunsSessionCard({ s, mode, onPeekSession, onSessionRemoved, updatedLabel }) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const href = `/graph-pipeline/${encodeURIComponent(s.id)}`;
  const title = graphSessionDisplayTitle(s.id, s.label, s.threadRootLabel);
  const canRemoveFromList = s.id !== DEFAULT_GRAPH_SESSION_ID;

  const confirmRemove = () => {
    removeGraphPipelineSession(s.id);
    setPendingDelete(false);
    onSessionRemoved?.(s.id);
  };

  return (
    <div
      className={cn(
        'flex items-stretch gap-0 overflow-hidden rounded-xl border shadow-sm transition-colors',
        mode === 'running'
          ? 'border-emerald-500/30 bg-card/60'
          : 'border-border/80 bg-card/40 hover:bg-muted/20'
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-3 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <Link to={href} className="shrink-0 pt-0.5 text-primary hover:opacity-80" aria-label={`Open workspace ${title}`}>
              <GitBranch className="h-4 w-4" aria-hidden />
            </Link>
            <div className="min-w-0 flex-1">
              <GraphSessionLabelInline
                sessionId={s.id}
                label={s.label}
                threadRootLabel={s.threadRootLabel}
                titleLinkTo={href}
                compact
              />
              <span
                className="mt-0.5 block font-mono text-[11px] text-muted-foreground/70"
                title={s.id}
              >
                {truncateId(s.id)}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <StatusBadge mode={mode} />
            {updatedLabel ? (
              <span className="text-[11px] text-muted-foreground">{updatedLabel}</span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mode === 'running' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={(e) => {
                if (e.target.closest('[data-graph-session-remove-root]')) return;
                onPeekSession({ sessionId: s.id, title });
              }}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden />
              Peek live
            </Button>
          ) : null}
          <Link
            to={href}
            className={cn(
              'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              mode === 'running'
                ? 'bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Open workspace
          </Link>
        </div>
      </div>
      {canRemoveFromList ? (
        <GraphSessionRemoveColumn
          title={title}
          pendingDelete={pendingDelete}
          setPendingDelete={setPendingDelete}
          onConfirmRemove={confirmRemove}
        />
      ) : null}
    </div>
  );
}
