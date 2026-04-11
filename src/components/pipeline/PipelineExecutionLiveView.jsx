import { useEffect, useMemo, useRef } from 'react';
import NeuralNetworkViz from '../NeuralNetworkViz';
import { PipelineStageMinimap } from '../consciousness/PipelineStageMinimap';
import { COGNITIVE_MODULES, getFirstProcessingModuleId } from '../../lib/cognitiveModules';
import { computeCuriosityPipelineMinimapSnapshot } from '../../lib/curiosityPipelineSseUi';
import { computePipelineMinimapSnapshot } from '../../lib/consciousnessStreamPipelineMinimap';
import {
  PIPELINE_LOG_EMPTY_IDLE,
  PIPELINE_LOG_EMPTY_RUNNING,
  PIPELINE_MINIMAP_STRIP_LABEL,
} from '../../lib/activePipelineStatusLabels';
import PipelineExecutionLogEntries from './PipelineExecutionLogEntries';
import PipelineExecutionLogStatusLine from './PipelineExecutionLogStatusLine';

/**
 * Presentational curiosity / goal / graph style live pipeline: minimap, neural map, execution.log.
 *
 * When `streamEntriesForMinimap` is set (e.g. Graph Pipeline), the stage strip matches the interactive
 * consciousness stream — same semantics as PipelineTranscriptExperience. Otherwise it derives from
 * `moduleStatuses` (curiosity carousel, scheduler buffer).
 *
 * @param {unknown[] | undefined} [streamEntriesForMinimap] When provided, minimap uses stream entries (legacy strip).
 */
export default function PipelineExecutionLiveView({
  moduleStatuses,
  executionLog,
  moduleOutputs,
  isRunning,
  runError = null,
  stripLabel = PIPELINE_MINIMAP_STRIP_LABEL,
  emptyRunningMessage = PIPELINE_LOG_EMPTY_RUNNING,
  emptyIdleMessage = PIPELINE_LOG_EMPTY_IDLE,
  lineKeyPrefix = 'pipeline-live',
  streamEntriesForMinimap,
}) {
  const ms = moduleStatuses && typeof moduleStatuses === 'object' ? moduleStatuses : {};
  const log = Array.isArray(executionLog) ? executionLog : [];
  const cognitiveModuleCount = COGNITIVE_MODULES.length;

  const minimapSnapshot = useMemo(() => {
    if (streamEntriesForMinimap !== undefined) {
      const stream = Array.isArray(streamEntriesForMinimap) ? streamEntriesForMinimap : [];
      return computePipelineMinimapSnapshot(stream, isRunning, { statusPrefix: stripLabel });
    }
    return computeCuriosityPipelineMinimapSnapshot(ms, isRunning, stripLabel);
  }, [streamEntriesForMinimap, ms, isRunning, stripLabel]);
  const activeModuleId = getFirstProcessingModuleId(ms);

  const logScrollRef = useRef(null);
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  return (
    <div className="space-y-3 border-b border-border/70 bg-muted/5 px-3 py-3 sm:px-4">
      <PipelineStageMinimap
        snapshot={minimapSnapshot}
        stripLabel={stripLabel}
        ariaLabel={`${stripLabel} pipeline stage overview`}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-stretch">
        <div className="relative h-[min(200px,30vh)] min-h-[10rem] min-w-0 overflow-hidden rounded-lg border border-border bg-muted/10 lg:col-span-1 lg:h-[min(240px,35vh)]">
          <NeuralNetworkViz
            variant="embedded"
            activeModuleId={activeModuleId}
            ariaLabel={`${stripLabel} pipeline modules`}
          />
        </div>
        <div className="flex max-h-[min(320px,40vh)] min-h-[min(200px,30vh)] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:col-span-2">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-muted/15 px-3 py-2">
            <span className="font-mono text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              execution.log
            </span>
            {log.length > 0 ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs tabular-nums text-primary">
                {log.length} lines
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{cognitiveModuleCount} modules</span>
          </div>
          <div ref={logScrollRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <PipelineExecutionLogStatusLine
              className="sticky top-0 z-10"
              runError={runError}
              isRunning={isRunning}
              executionLog={log}
            />
            {log.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                {isRunning ? emptyRunningMessage : emptyIdleMessage}
              </p>
            ) : (
              <PipelineExecutionLogEntries
                entries={log}
                lineKeyPrefix={lineKeyPrefix}
                moduleOutputs={moduleOutputs && typeof moduleOutputs === 'object' ? moduleOutputs : undefined}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
