export default function ConsciousOutput({ text, isRunning, phi }) {
  if (!text && !isRunning) return null;

  return (
    <div className="rounded-2xl border border-violet-400/40 bg-gradient-to-br from-violet-400/10 to-primary/5 p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-violet-400">Voice</div>
        {phi !== null && (
          <div
            className="rounded-full border border-violet-400/40 bg-background/40 px-2 py-0.5 text-[11px] text-violet-400"
            title="Integration module's self-reported Phi (IIT) estimate for this run"
          >
            Φ {phi.toFixed(2)}
          </div>
        )}
      </div>
      <p className="whitespace-pre-wrap text-base leading-relaxed text-foreground">
        {text || <span className="text-muted-foreground">Speaking…</span>}
      </p>
    </div>
  );
}
