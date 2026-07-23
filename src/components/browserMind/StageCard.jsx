import { cn } from '../../lib/utils';

function StatusDot({ status }) {
  if (status === 'running') {
    return <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />;
  }
  if (status === 'done') {
    return <span className="h-2 w-2 rounded-full bg-emerald-400" />;
  }
  if (status === 'error') {
    return <span className="h-2 w-2 rounded-full bg-red-400" />;
  }
  return <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />;
}

export default function StageCard({ stage, state }) {
  const isIdle = state.status === 'pending' && state.text === '';

  return (
    <div
      className={cn(
        'rounded-xl border p-3 transition-colors',
        state.status === 'running'
          ? 'border-violet-400/60 bg-violet-400/5'
          : state.status === 'done'
            ? 'border-border bg-card'
            : 'border-border/60 bg-card/40'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusDot status={state.status} />
          <span className="text-[11px] text-muted-foreground">{stage.order.toString().padStart(2, '0')}</span>
          <span className="text-sm font-medium text-foreground">{stage.title}</span>
        </div>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{stage.blurb}</p>
      {!isIdle && (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {state.text || <span className="text-muted-foreground/60">…</span>}
        </p>
      )}
    </div>
  );
}
