import { useMemo } from 'react';
import {
  getServerExecutionLayers,
  PIPELINE_LAYER_COLORS,
  PIPELINE_METACOGNITION_END_FRACTION,
  PIPELINE_STAGE_LABELS,
} from '../../lib/cognitiveModules';
import { cn } from '../../lib/utils';

const METACOG_MARKER_TITLE =
  'End of Supervisors & workspace layer — Articulation follows';

const TRACK_BG =
  'relative h-1.5 w-full overflow-hidden rounded-full bg-white/70 shadow-inner ring-1 ring-white/40 dark:bg-white/20 dark:ring-white/15';

function MetacognitionMarkerLine({ leftPct }) {
  return (
    <div
      className="pointer-events-none absolute bottom-0 top-0 z-[2] w-px -translate-x-1/2 bg-foreground/45 shadow-[0_0_0_1px_hsl(var(--background)/0.85)] dark:bg-foreground/50"
      style={{ left: `${leftPct}%` }}
      title={METACOG_MARKER_TITLE}
      aria-hidden
    />
  );
}

/**
 * Per-layer segment status: 'complete' | 'processing' | 'pending'.
 * @param {Record<string, string>} ms
 */
function computeLayerSegments(ms) {
  const layers = getServerExecutionLayers();
  const total = layers.length;
  if (total === 0) return [];

  const segments = [];
  let reachedProcessing = false;

  for (const row of layers) {
    const ids = row.moduleIds || [];
    const color = PIPELINE_LAYER_COLORS[row.layerKey] || '#64748b';
    const label = PIPELINE_STAGE_LABELS[row.layerKey] || row.layerKey;

    if (reachedProcessing || ids.length === 0) {
      segments.push({ layerKey: row.layerKey, color, label, status: 'pending', width: 100 / total });
      continue;
    }

    let allComplete = true;
    let anyProcessing = false;
    for (const id of ids) {
      const st = ms[id];
      if (st === 'processing') {
        anyProcessing = true;
        allComplete = false;
      } else if (st !== 'complete') {
        allComplete = false;
      }
    }

    if (allComplete) {
      segments.push({ layerKey: row.layerKey, color, label, status: 'complete', width: 100 / total });
    } else if (anyProcessing) {
      segments.push({ layerKey: row.layerKey, color, label, status: 'processing', width: 100 / total });
      reachedProcessing = true;
    } else {
      segments.push({ layerKey: row.layerKey, color, label, status: 'pending', width: 100 / total });
      reachedProcessing = true;
    }
  }
  return segments;
}

function LayerSegmentedFill({ moduleStatuses, progressAmber }) {
  const ms = moduleStatuses && typeof moduleStatuses === 'object' ? moduleStatuses : {};
  const segments = useMemo(() => computeLayerSegments(ms), [ms]);

  if (segments.length === 0) return null;

  return (
    <div className="relative z-[1] flex h-full w-full">
      {segments.map((seg) => {
        let bgColor;
        let extraClass = '';

        if (seg.status === 'complete') {
          bgColor = progressAmber ? undefined : seg.color;
          extraClass = progressAmber ? 'bg-amber-500 dark:bg-amber-400' : '';
        } else if (seg.status === 'processing') {
          bgColor = progressAmber ? undefined : `${seg.color}90`;
          extraClass = progressAmber
            ? 'bg-amber-500/60 dark:bg-amber-400/60 motion-safe:animate-pulse'
            : 'motion-safe:animate-pulse';
        } else {
          bgColor = undefined;
          extraClass = '';
        }

        return (
          <div
            key={seg.layerKey}
            title={seg.label}
            className={cn('h-full transition-colors duration-300', extraClass)}
            style={{
              width: `${seg.width}%`,
              ...(bgColor ? { backgroundColor: bgColor } : {}),
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Horizontal pipeline progress (Dashboard / Live Analytics) with a fixed marker where the
 * Metacognition module ends in canonical server module order.
 *
 * When `moduleStatuses` is provided, renders per-layer colored segments instead of a single fill.
 *
 * @param {{
 *   indeterminate?: boolean,
 *   progressPercent?: number | null,
 *   progressAmber?: boolean,
 *   moduleStatuses?: Record<string, string> | null,
 *   className?: string,
 * }} props
 */
export function PipelineProgressTrack({ indeterminate, progressPercent, progressAmber, moduleStatuses, className }) {
  if (!indeterminate && progressPercent == null) return null;

  const markerLeftPct = PIPELINE_METACOGNITION_END_FRACTION * 100;
  const hasModuleStatuses = moduleStatuses && typeof moduleStatuses === 'object' && Object.keys(moduleStatuses).length > 0;

  return (
    <div className={className}>
      {indeterminate && !hasModuleStatuses ? (
        <div role="progressbar" aria-label="Pipeline progress (in progress)">
          <div className={TRACK_BG}>
            <MetacognitionMarkerLine leftPct={markerLeftPct} />
            <div
              className={cn(
                'relative z-[1] h-full w-2/5 max-w-[45%] rounded-full motion-safe:animate-pulse',
                progressAmber ? 'bg-amber-500 dark:bg-amber-400' : 'bg-emerald-500 dark:bg-emerald-400'
              )}
            />
          </div>
        </div>
      ) : hasModuleStatuses ? (
        <div
          role="progressbar"
          aria-valuenow={progressPercent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={progressPercent != null ? `Pipeline progress ${progressPercent}%` : 'Pipeline progress'}
        >
          <div className={TRACK_BG}>
            <MetacognitionMarkerLine leftPct={markerLeftPct} />
            <LayerSegmentedFill moduleStatuses={moduleStatuses} progressAmber={progressAmber} />
          </div>
        </div>
      ) : progressPercent != null ? (
        <div
          role="progressbar"
          aria-valuenow={progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Pipeline progress ${progressPercent}%`}
        >
          <div className={TRACK_BG}>
            <MetacognitionMarkerLine leftPct={markerLeftPct} />
            <div
              className={cn(
                'relative z-[1] h-full rounded-full transition-[width] duration-500 ease-out',
                progressAmber ? 'bg-amber-500 dark:bg-amber-400' : 'bg-emerald-500 dark:bg-emerald-400'
              )}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
