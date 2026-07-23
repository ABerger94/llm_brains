import { useMemo } from 'react';
import {
  getServerExecutionLayers,
  PIPELINE_LAYER_COLORS,
  PIPELINE_STAGE_LABELS,
} from '../../lib/cognitiveModules';
import { PIPELINE_MINIMAP_STRIP_LABEL } from '../../lib/activePipelineStatusLabels';
import { cn } from '../../lib/utils';

/**
 * @param {{
 *   snapshot: ReturnType<typeof import('../../lib/consciousnessStreamPipelineMinimap.js').computePipelineMinimapSnapshot>,
 *   stripLabel?: string,
 *   ariaLabel?: string,
 * }} props
 */
export function PipelineStageMinimap({
  snapshot,
  stripLabel = PIPELINE_MINIMAP_STRIP_LABEL,
  ariaLabel = 'Pipeline stage overview',
}) {
  const layers = useMemo(() => getServerExecutionLayers(), []);

  const {
    prep,
    isProcessing,
    activeLayerKey,
    activeModuleName,
    completedLayerKeys,
    allStagesCompleteVisual,
    neutralIdle,
    lastCompletedModuleName,
    liveStatus,
  } = snapshot;

  const completedSet = useMemo(() => new Set(completedLayerKeys), [completedLayerKeys]);

  return (
    <div
      className="flex min-h-[2.25rem] flex-wrap items-center gap-2 border-b border-border/50 bg-muted/5 px-4 py-1.5"
      aria-label={ariaLabel}
    >
      <span className="sr-only" aria-live="polite">
        {liveStatus}
      </span>
      <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground">{stripLabel}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {layers.map(({ layerKey }, idx) => {
          const color = PIPELINE_LAYER_COLORS[layerKey] || '#64748b';
          const label = PIPELINE_STAGE_LABELS[layerKey] || layerKey;
          const isActive = Boolean(activeLayerKey === layerKey);
          const isDone = completedSet.has(layerKey);
          const showFinishedFill = allStagesCompleteVisual;

          let segmentClass =
            'h-2 min-w-[2.5rem] flex-1 rounded-full border transition-colors duration-200';
          let style = {};

          if (neutralIdle && !isProcessing) {
            segmentClass += ' border-border/60 bg-muted/20';
          } else if (prep) {
            segmentClass += ' border-border/50 bg-muted/30';
          } else if (showFinishedFill) {
            segmentClass += ' border-transparent';
            style = { backgroundColor: `${color}40` };
          } else if (isActive) {
            segmentClass += ' border-transparent';
            style = {
              backgroundColor: color,
              boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 75%, transparent), 0 0 0 4px hsl(var(--background) / 1)`,
            };
          } else if (isDone) {
            segmentClass += ' border-transparent';
            style = { backgroundColor: `${color}55` };
          } else if (isProcessing) {
            segmentClass += ' border-border/40 bg-muted/15';
          } else {
            segmentClass += ' border-border/50 bg-muted/20';
          }

          const segmentTitle =
            isActive && activeModuleName
              ? `${label} — ${activeModuleName} (${idx + 1} of ${layers.length})`
              : `${label} (${idx + 1} of ${layers.length})`;

          const isLayer5 = layerKey === 'layer5';
          const segmentFillClass = segmentClass
            .split(/\s+/)
            .filter((t) => t && !['h-2', 'min-w-[2.5rem]', 'flex-1'].includes(t))
            .join(' ');

          if (!isLayer5) {
            return (
              <div key={layerKey} title={segmentTitle} className={segmentClass} style={style} />
            );
          }

          return (
            <div key={layerKey} title={segmentTitle} className="relative h-2 min-w-[2.5rem] flex-1">
              <div className={cn('absolute inset-0', segmentFillClass)} style={style} />
              <div
                className="pointer-events-none absolute bottom-0 right-0 top-0 z-[2] w-px bg-foreground/40 shadow-[0_0_0_1px_hsl(var(--background)/0.85)] dark:bg-foreground/50"
                title="End of Supervisors & workspace (layer 5) — Articulation follows"
                aria-hidden
              />
            </div>
          );
        })}
      </div>
      {prep ? (
        <span className="shrink-0 text-[10px] text-muted-foreground" title="Waiting for first pipeline module">
          Starting…
        </span>
      ) : isProcessing && activeLayerKey ? (
        <span
          className="flex min-w-0 max-w-[min(320px,55vw)] shrink-0 flex-col items-end gap-0.5 text-end leading-tight"
          title={
            activeModuleName
              ? `${PIPELINE_STAGE_LABELS[activeLayerKey] || activeLayerKey} — ${activeModuleName}`
              : undefined
          }
        >
          <span className="text-[10px] text-muted-foreground">
            {PIPELINE_STAGE_LABELS[activeLayerKey] || activeLayerKey}
          </span>
          {activeModuleName ? (
            <span className="truncate text-[10px] font-medium text-foreground/90">{activeModuleName}</span>
          ) : null}
        </span>
      ) : allStagesCompleteVisual ? (
        <span
          className="flex min-w-0 max-w-[min(320px,55vw)] shrink-0 flex-col items-end gap-0.5 text-end leading-tight"
          title={lastCompletedModuleName ? `Last module: ${lastCompletedModuleName}` : undefined}
        >
          <span className="text-[10px] text-muted-foreground">Complete</span>
          {lastCompletedModuleName ? (
            <span className="truncate text-[10px] font-medium text-foreground/90">{lastCompletedModuleName}</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
