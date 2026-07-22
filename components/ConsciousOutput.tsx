"use client";

interface Props {
  text: string;
  isRunning: boolean;
}

export function ConsciousOutput({ text, isRunning }: Props) {
  if (!text && !isRunning) return null;

  return (
    <div className="rounded-2xl border border-accent2/40 bg-gradient-to-br from-accent2/10 to-accent/5 p-4">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-accent2">
        Conscious broadcast
      </div>
      <p className="whitespace-pre-wrap text-base leading-relaxed text-neutral-50">
        {text || <span className="text-neutral-500">Synthesizing…</span>}
      </p>
    </div>
  );
}
