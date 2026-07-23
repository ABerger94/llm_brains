import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Same chrome as Live Analytics mind snapshot sections: bordered card, collapsible header row.
 * @param {'sky' | 'pink'} accent
 */
export default function MindSnapshotCollapsibleSection({
  accent = 'sky',
  open,
  onToggle,
  icon: Icon,
  iconClassName,
  title,
  count,
  headerRight = null,
  children,
}) {
  const border = accent === 'pink' ? 'border-pink-500/20' : 'border-sky-500/20';
  return (
    <div className={cn('rounded-xl border bg-card p-4', border)}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle((prev) => !prev)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1 pr-2 text-left transition-colors hover:bg-muted/40',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
          )}
        >
          {open ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Icon className={cn('h-4 w-4 shrink-0', iconClassName)} aria-hidden />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
          {count != null ? (
            <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
              ({count})
            </span>
          ) : null}
        </button>
        {headerRight}
      </div>
      {open ? <div className="mt-0">{children}</div> : null}
    </div>
  );
}
