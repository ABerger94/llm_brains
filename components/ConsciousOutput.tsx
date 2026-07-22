"use client";

interface Props {
  text: string;
  isRunning: boolean;
  phi: number | null;
}

export function ConsciousOutput({ text, isRunning, phi }: Props) {
  if (!text && !isRunning) return null;

  return (
    <div className="rounded-2xl border border-accent2/40 bg-gradient-to-br from-accent2/10 to-accent/5 p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-accent2">Voice</div>
        {phi !== null && (
          <div
            className="rounded-full border border-accent2/40 bg-bg/40 px-2 py-0.5 text-[11px] text-accent2"
            title="Integration module's self-reported Phi (IIT) estimate for this run"
          >
            Φ {phi.toFixed(2)}
          </div>
        )}
      </div>
      <p className="whitespace-pre-wrap text-base leading-relaxed text-neutral-50">
        {text || <span className="text-neutral-500">Speaking…</span>}
      </p>
    </div>
  );
}
