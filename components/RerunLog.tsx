"use client";

import type { RerunEvent } from "@/lib/useMindChain";

interface Props {
  events: RerunEvent[];
}

export function RerunLog({ events }: Props) {
  if (events.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-300">
        Rerun activity
      </div>
      <ul className="flex flex-col gap-1.5">
        {events.map((event, i) => (
          <li key={i} className="text-xs text-amber-100/90">
            <span className="text-amber-400">
              {event.type === "contradiction" ? "Contradiction Engine — " : "Metacognition — "}
            </span>
            {event.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}
