import { useEffect, useState } from 'react';
import { AVAILABLE_MODELS } from '../../lib/browserLlmEngine';
import { cn } from '../../lib/utils';

/** iOS Safari kills the whole tab (blank page / silent reload) when a page's memory footprint gets too high. */
function isLikelyMobile() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isTouchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS reports as Mac
  return /iPhone|iPad|iPod|Android/.test(ua) || isTouchMac;
}

export default function ModelPicker({ selectedId, disabled, onSelect }) {
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
            className={cn(
              'rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
              showRiskWarning
                ? 'border-amber-500/50 bg-amber-500/5'
                : active
                  ? 'border-violet-400/60 bg-violet-400/10'
                  : 'border-border bg-card hover:border-muted-foreground/40'
            )}
          >
            <div className="text-sm font-medium text-foreground">{model.label}</div>
            <div className="mt-1 text-xs text-muted-foreground">{model.description}</div>
            <div className="mt-2 text-[11px] text-muted-foreground/70">
              ~{model.approxSizeMB} MB, cached after first download
            </div>
            {showRiskWarning && (
              <div className="mt-2 text-[11px] text-amber-500">
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
