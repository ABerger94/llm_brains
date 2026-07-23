"use client";

import { useState } from "react";
import type { MemoryEpisode } from "@/lib/memoryStore";
import { timeAgo } from "@/lib/memoryStore";

interface Props {
  identityNarrative: string;
  episodes: MemoryEpisode[];
  backendConfigured: boolean | null;
  onForget: () => void;
}

export function MemoryPanel({ identityNarrative, episodes, backendConfigured, onForget }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);

  const hasMemory = identityNarrative.length > 0 || episodes.length > 0;
  const recent = [...episodes].reverse();
  const visible = expanded ? recent : recent.slice(0, 3);
  const nextSessionNumber = episodes.length + 1;

  function handleForgetClick() {
    if (confirmingForget) {
      onForget();
      setConfirmingForget(false);
    } else {
      setConfirmingForget(true);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Persistent memory · Session #{nextSessionNumber}
        </h2>
        {hasMemory && (
          <button
            type="button"
            onClick={handleForgetClick}
            onBlur={() => setConfirmingForget(false)}
            className="text-[11px] text-neutral-500 hover:text-red-300"
          >
            {confirmingForget ? "Click again to forget everything" : "Forget everything"}
          </button>
        )}
      </div>

      {backendConfigured === false && (
        <p className="mt-2 text-xs text-amber-300">
          Backend memory store isn&apos;t connected yet — running without persistence this
          session (see README for the one-time setup step).
        </p>
      )}

      {!hasMemory ? (
        <p className="mt-2 text-sm text-neutral-500">
          No memory yet — this mind hasn&apos;t experienced anything. Run the pipeline below and
          it will start accumulating an identity narrative and episodic memory that persists
          across sessions in a real backend database.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {identityNarrative && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-accent2">
                Identity
              </div>
              <p className="mt-1 text-sm leading-relaxed text-neutral-200">{identityNarrative}</p>
            </div>
          )}

          {episodes.length > 0 && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                Episodic memory ({episodes.length})
              </div>
              <ul className="mt-1 flex flex-col gap-2">
                {visible.map((ep) => (
                  <li key={ep.id} className="rounded-lg border border-edge/60 bg-bg/40 p-2 text-xs">
                    <div className="text-neutral-500">
                      Session #{ep.sessionNumber} · {timeAgo(ep.timestamp)}
                    </div>
                    <div className="mt-0.5 text-neutral-300">
                      <span className="text-neutral-500">Faced:</span> {ep.stimulus}
                    </div>
                    <div className="mt-0.5 text-neutral-300">
                      <span className="text-neutral-500">Concluded:</span> {ep.reasoning}
                    </div>
                  </li>
                ))}
              </ul>
              {episodes.length > 3 && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="mt-1.5 text-[11px] text-neutral-500 hover:text-neutral-300"
                >
                  {expanded ? "Show less" : `Show all ${episodes.length}`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
