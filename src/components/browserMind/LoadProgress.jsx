export default function LoadProgress({ status, progress }) {
  if (status === 'idle') return null;

  const pct = progress ? Math.round(progress.progress * 100) : 0;

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {status === 'ready'
            ? 'Model ready — running fully on-device'
            : status === 'error'
              ? 'Failed to load model'
              : progress?.text ?? 'Preparing model…'}
        </span>
        {status === 'loading' && <span>{pct}%</span>}
      </div>
      {status === 'loading' && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-violet-400 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
