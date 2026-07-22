"use client";

import { useState } from "react";

interface Props {
  disabled: boolean;
  isRunning: boolean;
  onRun: (stimulus: string) => void;
  onStop: () => void;
}

const EXAMPLES = [
  "Your phone buzzes with a text from your boss at 11pm: \"We need to talk tomorrow.\"",
  "You find a wallet full of cash on the sidewalk with no ID inside.",
  "A close friend cancels plans with you for the third time this month.",
];

export function StimulusInput({ disabled, isRunning, onRun, onStop }: Props) {
  const [text, setText] = useState("");

  return (
    <div className="rounded-xl border border-edge bg-panel p-4">
      <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-neutral-400">
        Stimulus
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Describe something the mind perceives — an event, a message, a scene…"
        rows={3}
        className="w-full resize-none rounded-lg border border-edge bg-bg p-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setText(ex)}
            className="rounded-full border border-edge px-2.5 py-1 text-[11px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
          >
            {ex.length > 40 ? ex.slice(0, 40) + "…" : ex}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {!isRunning ? (
          <button
            type="button"
            disabled={disabled || text.trim().length === 0}
            onClick={() => onRun(text.trim())}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40"
          >
            Run 22-module pipeline
          </button>
        ) : (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg border border-edge px-4 py-2 text-sm font-medium text-neutral-200 hover:border-neutral-500"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
