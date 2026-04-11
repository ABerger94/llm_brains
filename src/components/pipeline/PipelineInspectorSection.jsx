import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Collapsible inspector block for graph pipeline / pursuit tooling (consistent chrome).
 *
 * @param {{
 *   id?: string
 *   title?: string
 *   trailing?: import('react').ReactNode
 *   summary?: import('react').ReactNode
 *   children: import('react').ReactNode
 *   contentClassName?: string
 *   className?: string
 * }} props
 */
export default function PipelineInspectorSection({
  id,
  title,
  trailing,
  summary,
  children,
  contentClassName,
  className,
}) {
  const summaryBody =
    summary ??
    (title ? (
      <>
        <span className="min-w-0 flex-1">{title}</span>
        {trailing ? (
          <span className="max-w-[55%] shrink-0 truncate text-[10px] font-normal text-muted-foreground/75">
            {trailing}
          </span>
        ) : null}
      </>
    ) : null);

  return (
    <details
      id={id}
      className={cn(
        'group rounded-lg border border-border/80 bg-card/50 shadow-sm [&_summary::-webkit-details-marker]:hidden',
        className
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-t-lg px-3 py-2 font-sans text-xs font-medium text-muted-foreground hover:bg-muted/20">
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
        <div className="flex min-w-0 flex-1 items-center gap-2">{summaryBody}</div>
      </summary>
      <div className={cn('rounded-b-lg border-t border-border/60 p-3', contentClassName)}>{children}</div>
    </details>
  );
}
