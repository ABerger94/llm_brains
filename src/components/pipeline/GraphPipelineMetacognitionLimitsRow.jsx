import { useSyncExternalStore } from 'react';
import { Input } from '../ui';
import { graphPipelineStore, subscribeGraphPipeline } from '../../lib/graphPipelineStore';
import {
  subscribeConsciousnessStream,
  consciousnessStreamStore,
} from '../../lib/consciousnessStreamStore';
import { getRuntimeSettings, resolveMaxMetacognitionReruns, resolveMetacognitionRerunDelayMinutes } from '../../lib/runtimeSettings';
import MetacognitionLimitsInfoHint from './MetacognitionLimitsInfoHint';

/**
 * Per-workspace supervisor rerun cap + delay for graph pipeline runs (persisted with session KV).
 * Empty fields use global Mind Settings defaults.
 */
export default function GraphPipelineMetacognitionLimitsRow({ className = '' }) {
  const gpSnap = useSyncExternalStore(
    subscribeGraphPipeline,
    () => graphPipelineStore.getState(),
    () => graphPipelineStore.getState()
  );
  const csSnap = useSyncExternalStore(
    subscribeConsciousnessStream,
    () => consciousnessStreamStore.getState(),
    () => consciousnessStreamStore.getState()
  );
  const streamLocksUi = Boolean(csSnap.isProcessing);
  const pmo = gpSnap.pipelineMetacognitionOverrides || {
    maxMetacognitionReruns: null,
    metacognitionRerunDelayMinutes: null,
  };
  const rt = getRuntimeSettings();
  const defMax = resolveMaxMetacognitionReruns(rt);
  const defDelay = resolveMetacognitionRerunDelayMinutes(rt);
  const patchPmo = (partial) => {
    graphPipelineStore.patch({
      pipelineMetacognitionOverrides: { ...pmo, ...partial },
    });
  };

  return (
    <div
      className={`flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[10px] ${className}`}
    >
      <p className="w-full text-[10px] leading-snug text-muted-foreground">
        This workspace only — overrides global defaults for the next graph run (and persisted with this session).
      </p>
      <label className="flex flex-col gap-0.5 text-muted-foreground">
        <span className="uppercase tracking-wide">Reruns before Voice</span>
        <Input
          type="number"
          min={0}
          max={20}
          value={pmo.maxMetacognitionReruns == null ? '' : pmo.maxMetacognitionReruns}
          onChange={(e) => {
            const v = e.target.value;
            patchPmo({
              maxMetacognitionReruns:
                v === '' ? null : Math.min(20, Math.max(0, Math.floor(Number(v) || 0))),
            });
          }}
          placeholder={`default ${defMax}`}
          disabled={streamLocksUi}
          className="h-8 w-[4.5rem] bg-background font-mono text-[11px]"
        />
      </label>
      <label className="flex flex-col gap-0.5 text-muted-foreground">
        <span className="uppercase tracking-wide">Rerun delay (min)</span>
        <Input
          type="number"
          min={0}
          max={120}
          value={pmo.metacognitionRerunDelayMinutes == null ? '' : pmo.metacognitionRerunDelayMinutes}
          onChange={(e) => {
            const v = e.target.value;
            patchPmo({
              metacognitionRerunDelayMinutes:
                v === '' ? null : Math.min(120, Math.max(0, Math.floor(Number(v) || 0))),
            });
          }}
          placeholder={`default ${defDelay}`}
          disabled={streamLocksUi}
          className="h-8 w-[4.5rem] bg-background font-mono text-[11px]"
        />
      </label>
      <MetacognitionLimitsInfoHint>
        Empty fields use global Settings. Each counted rerun is a full supervisor rework leg; after the cap, further RERUN
        requests proceed to Integration and Voice in the same leg. Deferred reruns use the delay below (0 = immediate
        chained legs). Supervisors now emit confidence scores (e.g. RERUN 0.73); the server uses a soft threshold modulated
        by interoception entropy — configure the baseline via METACOGNITION_RERUN_THRESHOLD in .env.
      </MetacognitionLimitsInfoHint>
    </div>
  );
}
