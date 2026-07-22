"use client";

import { AVAILABLE_MODELS } from "@/lib/webllmEngine";

interface Props {
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}

export function ModelPicker({ selectedId, disabled, onSelect }: Props) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {AVAILABLE_MODELS.map((model) => {
        const active = model.id === selectedId;
        return (
          <button
            key={model.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(model.id)}
            className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
              active
                ? "border-accent bg-accent/10"
                : "border-edge bg-panel hover:border-neutral-600"
            }`}
          >
            <div className="text-sm font-medium text-neutral-100">{model.label}</div>
            <div className="mt-1 text-xs text-neutral-400">{model.description}</div>
            <div className="mt-2 text-[11px] text-neutral-500">
              ~{model.approxSizeMB} MB, cached after first download
            </div>
          </button>
        );
      })}
    </div>
  );
}
