"use client";

import type { MindStage } from "@/lib/mindChain";
import type { StageState } from "@/lib/useMindChain";

interface Props {
  stage: MindStage;
  state: StageState;
}

function StatusDot({ status }: { status: StageState["status"] }) {
  if (status === "running") {
    return <span className="h-2 w-2 animate-pulse-soft rounded-full bg-accent" />;
  }
  if (status === "done") {
    return <span className="h-2 w-2 rounded-full bg-emerald-400" />;
  }
  if (status === "error") {
    return <span className="h-2 w-2 rounded-full bg-red-400" />;
  }
  return <span className="h-2 w-2 rounded-full bg-neutral-700" />;
}

export function StageCard({ stage, state }: Props) {
  const isIdle = state.status === "pending" && state.text === "";

  return (
    <div
      className={`rounded-xl border p-3 transition-colors ${
        state.status === "running"
          ? "border-accent/60 bg-accent/5"
          : state.status === "done"
            ? "border-edge bg-panel"
            : "border-edge/60 bg-panel/40"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusDot status={state.status} />
          <span className="text-[11px] text-neutral-500">{stage.order.toString().padStart(2, "0")}</span>
          <span className="text-sm font-medium text-neutral-100">{stage.title}</span>
        </div>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-neutral-500">{stage.blurb}</p>
      {!isIdle && (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">
          {state.text || <span className="text-neutral-600">…</span>}
        </p>
      )}
    </div>
  );
}
