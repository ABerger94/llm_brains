"use client";

import { useEffect, useState } from "react";
import { AVAILABLE_MODELS } from "@/lib/webllmEngine";
import { isLikelyMobile } from "@/lib/device";

interface Props {
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}

export function ModelPicker({ selectedId, disabled, onSelect }: Props) {
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    setMobile(isLikelyMobile());
  }, []);

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {AVAILABLE_MODELS.map((model) => {
        const active = model.id === selectedId;
        const showRiskWarning = mobile && model.riskyOnMobile;
        return (
          <button
            key={model.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(model.id)}
            className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
              showRiskWarning
                ? "border-amber-500/50 bg-amber-500/5"
                : active
                  ? "border-accent bg-accent/10"
                  : "border-edge bg-panel hover:border-neutral-600"
            }`}
          >
            <div className="text-sm font-medium text-neutral-100">{model.label}</div>
            <div className="mt-1 text-xs text-neutral-400">{model.description}</div>
            <div className="mt-2 text-[11px] text-neutral-500">
              ~{model.approxSizeMB} MB, cached after first download
            </div>
            {showRiskWarning && (
              <div className="mt-2 text-[11px] text-amber-300">
                Likely to crash this browser tab — phones tend to run out of memory around this
                size. Llama 3.2 1B or Qwen2.5 1.5B are safer here.
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
