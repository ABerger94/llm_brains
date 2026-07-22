"use client";

import type { InitProgressReport } from "@mlc-ai/web-llm";
import type { EngineStatus } from "@/lib/useMindChain";

interface Props {
  status: EngineStatus;
  progress: InitProgressReport | null;
}

export function LoadProgress({ status, progress }: Props) {
  if (status === "idle") return null;

  const pct = progress ? Math.round(progress.progress * 100) : 0;

  return (
    <div className="rounded-xl border border-edge bg-panel p-3">
      <div className="mb-1.5 flex items-center justify-between text-xs text-neutral-400">
        <span>
          {status === "ready"
            ? "Model ready — running fully on-device"
            : status === "error"
              ? "Failed to load model"
              : progress?.text ?? "Preparing model…"}
        </span>
        {status === "loading" && <span>{pct}%</span>}
      </div>
      {status === "loading" && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-edge">
          <div
            className="h-full rounded-full bg-accent transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
