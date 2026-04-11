import { useSyncExternalStore } from 'react';
import { graphPipelineStore, subscribeGraphPipeline } from '../../lib/graphPipelineStore';
import { consciousnessStreamStore, subscribeConsciousnessStream } from '../../lib/consciousnessStreamStore';
import {
  PIPELINE_LOG_EMPTY_IDLE_GRAPH_COMPOSER,
  PIPELINE_LOG_EMPTY_RUNNING,
} from '../../lib/activePipelineStatusLabels';
import PipelineExecutionLiveView from './PipelineExecutionLiveView';

/**
 * Curiosity / scheduled-task style live view: stage minimap (from module statuses), neural map, execution.log.
 * Subscribes to {@link graphPipelineStore} — same source as `addGraphExecutionLog` during SSE.
 * Interactive runs also mirror {@link consciousnessStreamStore} `isProcessing` so the execution.log
 * banner stays on while the stream is live (graph `isRunning` can lag or be cleared by rehydrate/heal).
 */
export default function GraphPipelineExecutionPanel() {
  const snap = useSyncExternalStore(
    subscribeGraphPipeline,
    () => graphPipelineStore.getState(),
    () => graphPipelineStore.getState()
  );
  const cs = useSyncExternalStore(
    subscribeConsciousnessStream,
    () => consciousnessStreamStore.getState(),
    () => consciousnessStreamStore.getState()
  );

  const { moduleStatuses, executionLog, moduleOutputs, isRunning, runError } = snap;
  const pipelineBusy = Boolean(isRunning || cs.isProcessing);

  return (
    <PipelineExecutionLiveView
      moduleStatuses={moduleStatuses}
      executionLog={executionLog}
      moduleOutputs={moduleOutputs}
      isRunning={pipelineBusy}
      runError={runError}
      emptyRunningMessage={PIPELINE_LOG_EMPTY_RUNNING}
      emptyIdleMessage={PIPELINE_LOG_EMPTY_IDLE_GRAPH_COMPOSER}
      streamEntriesForMinimap={cs.entries}
    />
  );
}
