import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Pencil, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { NEW_GRAPH_PIPELINE_SESSION_LABEL, upsertGraphPipelineSession } from '../../lib/graphPipelineSessionRegistry';
import { DEFAULT_GRAPH_SESSION_ID } from '../../lib/graphPipelineSessionScope';

const MAX_LEN = 160;

/**
 * @param {string} sessionId
 * @param {string} [label]
 * @param {string} [threadRootLabel] first substantive run topic / thread anchor
 */
export function graphSessionDisplayTitle(sessionId, label, threadRootLabel) {
  const T = String(threadRootLabel || '').trim();
  const L = String(label || '').trim();
  const primary = T || L;
  if (primary) return primary.slice(0, 120);
  if (sessionId === DEFAULT_GRAPH_SESSION_ID) return 'Default (legacy)';
  return `Session ${sessionId.slice(0, 8)}…`;
}

function fallbackLabelForSave(sessionId) {
  return sessionId === DEFAULT_GRAPH_SESSION_ID ? 'Default (legacy transcript)' : NEW_GRAPH_PIPELINE_SESSION_LABEL;
}

function displayPrimaryForEdit(threadRootLabel, label) {
  return String(threadRootLabel || label || '').trim();
}

/**
 * @param {{
 *   sessionId: string
 *   label?: string
 *   threadRootLabel?: string
 *   titleLinkTo?: string | null
 *   compact?: boolean
 *   className?: string
 * }} props
 */
export default function GraphSessionLabelInline({
  sessionId,
  label,
  threadRootLabel,
  titleLinkTo,
  compact,
  className,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  const tr = String(threadRootLabel || '').trim();
  const lb = String(label || '').trim();
  const showLatestLine = Boolean(tr && lb && tr !== lb);

  useEffect(() => {
    if (!editing) {
      setDraft(displayPrimaryForEdit(threadRootLabel, label));
    }
  }, [label, threadRootLabel, sessionId, editing]);

  useEffect(() => {
    if (editing) {
      const t = requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return () => cancelAnimationFrame(t);
    }
    return undefined;
  }, [editing]);

  const displayText = graphSessionDisplayTitle(sessionId, label, threadRootLabel);
  const tooltipTitle = showLatestLine ? `${displayText}\n\nLatest: ${lb}` : displayText;

  const save = () => {
    const t = draft.trim();
    const nextLabel = (t || fallbackLabelForSave(sessionId)).slice(0, MAX_LEN);
    upsertGraphPipelineSession({ id: sessionId, label: nextLabel, threadRootLabel: nextLabel });
    setEditing(false);
  };

  const cancel = () => {
    setDraft(displayPrimaryForEdit(threadRootLabel, label));
    setEditing(false);
  };

  if (editing) {
    return (
      <div className={cn('flex min-w-0 flex-1 items-center gap-1', className)} data-graph-session-rename-root>
        <input
          ref={inputRef}
          className={cn(
            'h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-medium text-foreground',
            compact ? 'h-7 text-xs' : 'text-sm'
          )}
          value={draft}
          maxLength={MAX_LEN}
          aria-label="Session name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
        />
        <button
          type="button"
          className={cn(
            'shrink-0 rounded-md p-1 text-emerald-600 ring-offset-background hover:bg-emerald-500/15 hover:text-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            compact && 'p-0.5'
          )}
          aria-label="Save session name"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            save();
          }}
        >
          <Check className={cn(compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} aria-hidden />
        </button>
        <button
          type="button"
          className={cn(
            'shrink-0 rounded-md p-1 text-muted-foreground ring-offset-background hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            compact && 'p-0.5'
          )}
          aria-label="Cancel rename"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }}
        >
          <X className={cn(compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} aria-hidden />
        </button>
      </div>
    );
  }

  const titleEl =
    titleLinkTo != null && titleLinkTo !== '' ? (
      <Link
        to={titleLinkTo}
        className={cn(
          'min-w-0 truncate font-medium text-foreground hover:underline',
          compact ? 'text-xs' : 'text-sm'
        )}
        title={tooltipTitle}
      >
        {displayText}
      </Link>
    ) : (
      <span
        className={cn('min-w-0 truncate font-medium text-foreground', compact ? 'text-xs' : 'text-sm')}
        title={tooltipTitle}
      >
        {displayText}
      </span>
    );

  return (
    <div className={cn('flex min-w-0 items-start gap-1', className)} data-graph-session-rename-root>
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        {titleEl}
        {showLatestLine ? (
          <span
            className={cn(
              'line-clamp-2 text-muted-foreground',
              compact ? 'text-[10px] leading-snug' : 'text-[11px] leading-snug'
            )}
            title={lb}
          >
            <span className="font-medium text-muted-foreground/90">Latest: </span>
            {lb.length > 140 ? `${lb.slice(0, 140)}…` : lb}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className={cn(
          'shrink-0 rounded-md p-1 text-muted-foreground opacity-70 ring-offset-background hover:bg-muted hover:text-foreground hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          compact && 'p-0.5'
        )}
        aria-label="Edit session name"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }}
      >
        <Pencil className={cn(compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden />
      </button>
    </div>
  );
}
