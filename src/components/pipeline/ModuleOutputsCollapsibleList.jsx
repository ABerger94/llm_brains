import { clipTextComplete } from '../../../shared/textClip.mjs';
import { COGNITIVE_MODULES_PIPELINE_ORDER } from '../../lib/cognitiveModules';

function statusLabel(st) {
  if (st === 'complete') return 'Complete';
  if (st === 'processing') return 'Processing';
  if (st) return String(st);
  return 'Pending';
}

/**
 * Per-module output text with collapsible rows (used by Live Analytics and scheduled pipeline inspector).
 * @param {{
 *   moduleStatuses?: Record<string, string>,
 *   moduleOutputs?: Record<string, string>,
 *   heading?: string,
 *   maxChars?: number,
 *   className?: string,
 * }} props
 */
export default function ModuleOutputsCollapsibleList({
  moduleStatuses = {},
  moduleOutputs = {},
  heading = 'Module outputs',
  maxChars = 12_000,
  className = '',
}) {
  return (
    <div className={className}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{heading}</div>
      <div className="mt-2 space-y-1.5">
        {COGNITIVE_MODULES_PIPELINE_ORDER.map((mod) => {
          const st = moduleStatuses?.[mod.id];
          const hasKey =
            moduleOutputs &&
            typeof moduleOutputs === 'object' &&
            Object.prototype.hasOwnProperty.call(moduleOutputs, mod.id);
          const raw = moduleOutputs?.[mod.id];
          const trimmed = raw != null && String(raw).trim() ? String(raw).trim() : '';
          const text = trimmed ? clipTextComplete(trimmed, maxChars, { ellipsis: true }) : '';
          const emptyRecorded = hasKey && !trimmed;
          return (
            <details
              key={mod.id}
              className="group rounded-lg border border-border/60 bg-muted/10 px-3 py-2 [&_summary::-webkit-details-marker]:hidden"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium">
                <span className="min-w-0 truncate">
                  {mod.name}
                  <span className="ml-2 font-normal text-muted-foreground">({statusLabel(st)})</span>
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground group-open:hidden">Open</span>
                <span className="hidden shrink-0 text-[10px] text-muted-foreground group-open:inline">Close</span>
              </summary>
              {text ? (
                <pre className="mt-2 max-h-[min(50svh,420px)] overflow-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-foreground/90">
                  {text}
                </pre>
              ) : emptyRecorded ? (
                <p className="mt-2 text-[11px] text-muted-foreground">Module completed with an empty preview line.</p>
              ) : (
                <p className="mt-2 text-[11px] text-muted-foreground">No output yet for this module.</p>
              )}
            </details>
          );
        })}
      </div>
    </div>
  );
}
