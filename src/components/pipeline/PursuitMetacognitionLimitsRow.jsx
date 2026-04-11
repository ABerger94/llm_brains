import { Input } from '../ui';
import { getRuntimeSettings, resolveMaxMetacognitionReruns, resolveMetacognitionRerunDelayMinutes } from '../../lib/runtimeSettings';
import MetacognitionLimitsInfoHint from './MetacognitionLimitsInfoHint';

/**
 * Per-pursuit metacognition rerun cap + deferred delay (empty = global defaults from Settings).
 * Max reruns = supervisor rework legs allowed before the run must complete through Voice.
 */
export default function PursuitMetacognitionLimitsRow({
  maxReruns,
  delayMinutes,
  onChange,
  disabled,
  className = '',
}) {
  const rt = getRuntimeSettings();
  const defMax = resolveMaxMetacognitionReruns(rt);
  const defDelay = resolveMetacognitionRerunDelayMinutes(rt);

  return (
    <div
      className={`flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[10px] ${className}`}
    >
      <label className="flex flex-col gap-0.5 text-muted-foreground">
        <span className="uppercase tracking-wide">Reruns before Voice</span>
        <Input
          type="number"
          min={0}
          max={20}
          value={maxReruns == null ? '' : maxReruns}
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              metacognitionMaxReruns: v === '' ? null : Math.min(20, Math.max(0, Math.floor(Number(v) || 0))),
            });
          }}
          placeholder={`default ${defMax}`}
          disabled={disabled}
          className="h-8 w-[4.5rem] bg-background font-mono text-[11px]"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-muted-foreground">
        <span className="uppercase tracking-wide">Rerun delay (min)</span>
        <Input
          type="number"
          min={0}
          max={120}
          value={delayMinutes == null ? '' : delayMinutes}
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              metacognitionRerunDelayMinutes: v === '' ? null : Math.min(120, Math.max(0, Math.floor(Number(v) || 0))),
            });
          }}
          placeholder={`default ${defDelay}`}
          disabled={disabled}
          className="h-8 w-[4.5rem] bg-background font-mono text-[11px]"
        />
      </label>
      <MetacognitionLimitsInfoHint>
        Empty fields use global Settings. Each counted rerun is a full supervisor rework leg (inline layers 1–4, continuation
        POST, or deferred schedule); after the cap, the run proceeds to Voice. Deferred reruns queue the next leg after delay
        minutes (0 = immediate chained legs).
      </MetacognitionLimitsInfoHint>
    </div>
  );
}
