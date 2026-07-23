import { derivePipelineExecutionStatus } from '../../lib/activePipelineStatusLabels';
import { cn } from '../../lib/utils';

/**
 * One-line status above execution.log entries: **Processing** while the run is active, or the error message after failure.
 *
 * @param {{
 *   runError?: unknown,
 *   isRunning?: boolean,
 *   executionLog?: unknown[],
 *   className?: string,
 * }} props
 */
export default function PipelineExecutionLogStatusLine({ runError, isRunning, executionLog, className }) {
  const { showProcessing, errorText } = derivePipelineExecutionStatus({
    runError,
    isRunning,
    executionLog,
  });

  if (errorText) {
    return (
      <div
        className={cn(
          'max-h-[min(50svh,28rem)] overflow-y-auto overflow-x-auto border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 font-mono text-[11px] leading-snug text-destructive shadow-[0_1px_0_0_hsl(var(--border)/0.35)] [overflow-wrap:anywhere]',
          className
        )}
        role="status"
      >
        <span className="whitespace-pre-wrap">{errorText}</span>
      </div>
    );
  }
  if (showProcessing) {
    return (
      <div
        className={cn(
          'border-b border-border bg-muted px-3 py-1.5 text-[11px] font-medium leading-snug text-foreground shadow-[0_1px_0_0_hsl(var(--border)/0.35)]',
          className
        )}
        role="status"
      >
        Processing
      </div>
    );
  }
  return null;
}
