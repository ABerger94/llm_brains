import PageDescriptionCollapsible from './PageDescriptionCollapsible';
import { cn } from '../lib/utils';

/**
 * @param {object} props
 * @param {boolean} [props.embedInScrollPort] - Default true: grow with AppLayout’s &lt;main&gt; scrollport (`flex-1 min-h-0`) instead of forcing full-viewport min-height (avoids double-stacked shells).
 * @param {boolean} [props.fillMain] - When true, grow to fill AppLayout’s scrollport (flex parent must be a flex column).
 * @param {string} [props.className] - Merged onto the outer shell (e.g. workspace accent backgrounds).
 */
export default function PageShell({
  icon: Icon,
  title,
  description,
  actions,
  maxWidth = 'max-w-7xl',
  embedInScrollPort = true,
  fillMain = false,
  className,
  children,
}) {
  return (
    <div
      className={cn(
        'p-4 sm:p-6',
        fillMain
          ? 'flex min-h-0 w-full min-w-0 flex-1 flex-col bg-background text-foreground'
          : embedInScrollPort
            ? 'flex w-full min-w-0 min-h-0 flex-1 flex-col bg-background text-foreground'
            : 'min-h-screen',
        className
      )}
    >
      <div className={cn('mx-auto w-full min-w-0', fillMain && 'flex min-h-0 flex-1 flex-col', maxWidth)}>
        <div className="mb-6 flex min-w-0 flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <h1 className="min-w-0 break-words text-2xl font-bold text-foreground">{title}</h1>
            </div>
            {description ? <PageDescriptionCollapsible>{description}</PageDescriptionCollapsible> : null}
          </div>
          {actions ? (
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto md:max-w-[min(100%,42rem)] md:justify-end">
              {actions}
            </div>
          ) : null}
        </div>
        <div className={cn('min-w-0', fillMain && 'min-h-0 flex-1')}>{children}</div>
      </div>
    </div>
  );
}
